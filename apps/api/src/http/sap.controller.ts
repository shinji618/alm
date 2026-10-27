// SAP 연계(openapi sapToken·sapPing·수신 IF, 09 6.6, 08 4.3~5.3). 수신 1차: IF-MD-01·IF-AA-01·IF-AA-02(WBS 4.7)
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Db } from '../db/pool';
import { Cognito } from '../auth/cognito';
import { ipAllowed, sapClientByAlias, sapConnection, SapConn } from '../auth/sap';
import { securityEvent } from '../auth/login';
import { TtlCache } from '../common/cache';
import { LIMITS, SharedLimiter } from '../common/shared';
import { log } from '../common/log';
import { AlmContext, AlmRequest, Ctx, Operation, txOf } from './context';
import { Batch, batchBody, idempotent, logRun } from '../sap/inbound';
import { postMasterData } from '../sap/master';
import { postAssetValues, retryPendingAssets, upsertAssets } from '../sap/assets';
import { claimPostings, Mail, pickRunRequests, postResult } from '../sap/postings';
import { postGoodsReceipts, retryPendingReceipts, upsertPurchaseOrders } from '../sap/purchasing';
import { postReconciliation } from '../sap/recon';
import { Mailer, queueEmail, SendEmailJob } from '../notify/mail';
import type { Config } from '../config';
import type { PoolClient } from 'pg';
import { CONFIG, COGNITO, DB, LIMITER, MAILER, SAP_CONNS } from './tokens';

// RFC 6749 5.2 오류(SAP OAuth 클라이언트가 읽음) + ALM 공통 오류 필드
//   401에는 WWW-Authenticate: Basic을 붙인다(RFC 6749 5.2). SAP HTTP 클라이언트(SM59 기본 인증)는 이 도전을 받아야 자격 증명을 보낸다
function oauthError(res: Response, req: AlmRequest, status: number, error: string, description: string, code: string) {
  if (status === 401) res.setHeader('WWW-Authenticate', 'Basic realm="ALM SAP", charset="UTF-8"');
  return res.status(status).type('application/json').json({
    error, error_description: description,
    type: `https://alm.pasapps.com/errors/${code}`, title: error, status, code, detail: description, correlationId: req.alm.correlationId,
  });
}

@Controller()
export class SapController {
  constructor(@Inject(DB) private db: Db, @Inject(COGNITO) private cognito: Cognito, @Inject(SAP_CONNS) private conns: TtlCache<SapConn>,
              @Inject(LIMITER) private limiter: SharedLimiter, @Inject(MAILER) private mailer: Mailer | null, @Inject(CONFIG) private cfg: Config) {}

  @Post('oauth/token')
  @HttpCode(200)
  @Operation('sapToken')
  async token(@Req() req: AlmRequest, @Res() res: Response) {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Pragma', 'no-cache');
    const b = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    if (b.grant_type !== 'client_credentials') return oauthError(res, req, 400, 'unsupported_grant_type', 'grant_type=client_credentials만 지원합니다', 'ALM-E100');
    if (b.scope !== undefined && b.scope !== '' && b.scope !== 'sap.api') return oauthError(res, req, 400, 'invalid_scope', 'scope는 sap.api입니다', 'ALM-E100');
    // client_secret_basic(권장) 또는 client_secret_post
    let id: string | undefined, secret: string | undefined;
    const basic = /^Basic (.+)$/i.exec(req.header('authorization') ?? '');
    if (basic) {
      const raw = Buffer.from(basic[1], 'base64').toString();
      const i = raw.indexOf(':');
      try { if (i > 0) { id = decodeURIComponent(raw.slice(0, i)); secret = decodeURIComponent(raw.slice(i + 1)); } } catch { /* 형식 오류 → invalid_client */ }
    } else if (typeof b.client_id === 'string' && typeof b.client_secret === 'string') { id = b.client_id; secret = b.client_secret; }
    if (!id || !secret) return oauthError(res, req, 401, 'invalid_client', '클라이언트 인증 정보가 없습니다', 'ALM-E402');

    const wait = await this.limiter.hit(`sap-token:${id.slice(0, 64)}`, LIMITS.sapToken);   // 09 6.6: 클라이언트당 분당 10회(모든 작업 합계)
    if (wait) { res.setHeader('Retry-After', String(wait)); return oauthError(res, req, 429, 'slow_down', '토큰 발급 호출이 너무 많습니다', 'ALM-E429'); }

    // SM59 기본 인증은 사용자 12자 제한: 연결 별칭(client_alias)이면 clientId로 바꾼다(Cognito clientId는 26자라 겹치지 않음)
    if (id.length <= 12) id = (await sapClientByAlias(this.db, id)) ?? id;
    const conn = await sapConnection(this.db, id);
    if (!conn) {
      // 테넌트를 알 수 없으므로 CloudWatch에만(09 7장)
      log.warn('sap token unknown client', { clientId: id.slice(0, 40), ip: req.alm.ip, correlationId: req.alm.correlationId });
      return oauthError(res, req, 401, 'invalid_client', '클라이언트 인증에 실패했습니다', 'ALM-E402');
    }
    const fail = async (reason: string, extra?: Record<string, unknown>) => {
      log.warn('sap token denied', { reason, clientId: id, ip: req.alm.ip, correlationId: req.alm.correlationId, ...extra });
      await this.db.withTx({ tenantId: conn.tenantId, actorType: 'SAP', correlationId: req.alm.correlationId, clientIp: req.alm.ip },
        (c) => securityEvent(c, { tenantId: conn.tenantId, type: 'SAP_AUTH_FAILED', actorType: 'SAP', channel: 'SAP', target: conn.connectionId,
          meta: { clientId: id, ip: req.alm.ip, userAgent: req.alm.userAgent, correlationId: req.alm.correlationId }, detail: { reason, ...extra } }))
        .catch((e) => log.error('security_event write failed', { err: String(e) }));
    };
    if (!ipAllowed(req.alm.ip, conn.allowedCidrs)) {
      await fail('IP_NOT_ALLOWED');
      return oauthError(res, req, 403, 'access_denied', '허용되지 않은 출발지 IP입니다', 'ALM-E401');
    }
    const r = await this.cognito.clientCredentials(id, secret);
    if (!r.ok) {
      await fail('COGNITO_REJECTED', { status: r.status, error: r.error });
      return r.status >= 500
        ? oauthError(res, req, 502, 'temporarily_unavailable', '인증 서버 응답 오류', 'ALM-E502')
        : oauthError(res, req, 401, 'invalid_client', '클라이언트 인증에 실패했습니다', 'ALM-E402');
    }
    await this.db.withTx({ tenantId: conn.tenantId, actorType: 'SAP', correlationId: req.alm.correlationId, clientIp: req.alm.ip },
      (c) => c.query('UPDATE sap_connection SET last_call_at = now() WHERE id = $1', [conn.connectionId])).catch(() => undefined);
    this.conns.delete(id);   // 연결 상태 변경을 다음 호출에 반영
    return res.status(200).json({ access_token: r.token.access_token, token_type: 'Bearer', expires_in: r.token.expires_in, scope: 'sap.api' });
  }

  @Get('sap/ping')
  @Operation('sapPing')
  ping(@Ctx() ctx: AlmContext) {
    const s = ctx.sap!;
    return { status: 'UP', serverTime: new Date().toISOString(), tenantCode: s.tenantCode, companyCodes: [s.companyCode] };
  }

  // ---- 수신(SAP → ALM). 공통: Idempotency-Key, sap_if_run 기록, 오류가 있으면 207(08 4.3) ----
  private async inbound(ctx: AlmContext, res: Response, o: { endpoint: string; iface: string; key?: string; body: unknown; max: number;
    run: (c: PoolClient, b: Record<string, unknown>, records: Record<string, unknown>[], batch: Batch) => Promise<void>;
    after?: (c: PoolClient, b: Record<string, unknown>, batch: Batch) => Promise<void> }) {
    const conn = ctx.sap!;
    const startedAt = new Date();
    const jobs: SendEmailJob[] = [];
    const out = await this.db.withTx(txOf(ctx), (c) => idempotent(c, conn.tenantId, o.endpoint, o.key, o.body, async () => {
      const { batchId, b, records } = batchBody(o.body, o.max);
      const batch = new Batch(batchId, records.length);
      await o.run(c, b, records, batch);
      await logRun(c, conn, { interfaceId: o.iface, batchId, correlationId: ctx.correlationId, startedAt, batch });
      await o.after?.(c, b, batch);
      for (const m of batch.mails) { const j = await queueEmail(c, conn.tenantId, m, this.cfg.appOrigin); if (j) jobs.push(j); }
      log.info('sap inbound', { iface: o.iface, batchId, received: batch.received, failed: batch.failed, ms: Date.now() - startedAt.getTime(),
        correlationId: ctx.correlationId });
      return { status: batch.http(), body: batch.body() };
    }));
    await this.enqueue(jobs);
    res.status(out.status);
    return out.body;
  }

  @Post('sap/master-data')
  @Operation('sapPostMasterData')
  masterData(@Ctx() ctx: AlmContext, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    return this.inbound(ctx, res, { endpoint: 'sapPostMasterData', iface: 'IF-MD-01', key, body, max: 5000,
      run: (c, b, records, batch) => postMasterData(c, ctx.sap!, b, records, batch),
      // 코스트센터·자산클래스를 다 받았으면 그것 때문에 실패했던 자산(최근 3일)을 다시 처리
      after: async (c, b) => {
        if (b.isLast === true && (b.type === 'COST_CENTER' || b.type === 'ASSET_CLASS')) {
          const r = await retryPendingAssets(c, ctx.sap!, ctx.correlationId);
          if (r) log.info('sap asset retry', { batchId: r.batchId, received: r.received, failed: r.failed });
        }
      } });
  }

  @Post('sap/assets\\:upsert')
  @Operation('sapUpsertAssets')
  upsertAssets(@Ctx() ctx: AlmContext, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    return this.inbound(ctx, res, { endpoint: 'sapUpsertAssets', iface: 'IF-AA-01', key, body, max: 1000,
      run: (c, _b, records, batch) => upsertAssets(c, ctx.sap!, records, batch) });
  }

  @Post('sap/asset-values')
  @Operation('sapPostAssetValues')
  assetValues(@Ctx() ctx: AlmContext, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    return this.inbound(ctx, res, { endpoint: 'sapPostAssetValues', iface: 'IF-AA-02', key, body, max: 1000,
      run: (c, b, records, batch) => postAssetValues(c, ctx.sap!, b, records, batch) });
  }

  // ---- 전기(ALM → SAP). 결과에 따라 자산회계 메일: notification 행은 같은 트랜잭션, 큐 전송은 커밋 뒤 ----
  private async posting(ctx: AlmContext, res: Response, endpoint: string, key: string | undefined, body: unknown,
    run: (c: PoolClient) => Promise<{ status: number; body: unknown; mails: Mail[] }>) {
    const jobs: SendEmailJob[] = [];
    const out = await this.db.withTx(txOf(ctx), (c) => idempotent(c, ctx.sap!.tenantId, endpoint, key, body, async () => {
      const r = await run(c);
      for (const m of r.mails) { const j = await queueEmail(c, ctx.sap!.tenantId, m, this.cfg.appOrigin); if (j) jobs.push(j); }
      return { status: r.status, body: r.body };
    }));
    await this.enqueue(jobs);
    res.status(out.status);
    return out.body;
  }

  // 커밋 뒤 메일 작업 큐로. 실패해도 응답은 그대로(notification 행은 QUEUED로 남는다)
  private async enqueue(jobs: SendEmailJob[]) {
    for (const j of jobs) {
      await this.mailer?.enqueue(j).catch((e) => log.error('mail enqueue failed', { notificationId: j.notificationId, err: String(e) }));
    }
  }

  @Post('sap/postings\\:claim')
  @Operation('sapClaimPostings')
  claim(@Ctx() ctx: AlmContext, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    return this.posting(ctx, res, 'sapClaimPostings', key, body, (c) => claimPostings(c, ctx.sap!, body));
  }

  @Post('sap/postings/:postingId/result')
  @Operation('sapPostResult')
  result(@Ctx() ctx: AlmContext, @Param('postingId') postingId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined,
         @Res({ passthrough: true }) res: Response) {
    return this.posting(ctx, res, 'sapPostResult', key, body, (c) => postResult(c, ctx.sap!, postingId, body, ctx.correlationId));
  }

  // IF-OP-01: 15분 잡이 처음에 부른다. PENDING → PICKED
  @Get('sap/run-requests')
  @Operation('sapGetRunRequests')
  runRequests(@Ctx() ctx: AlmContext) {
    return this.db.withTx(txOf(ctx), (c) => pickRunRequests(c, ctx.sap!));
  }

  // ---- 구매·입고·대사(SAP → ALM) ----
  @Post('sap/purchase-orders')
  @Operation('sapPostPurchaseOrders')
  purchaseOrders(@Ctx() ctx: AlmContext, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    return this.inbound(ctx, res, { endpoint: 'sapPostPurchaseOrders', iface: 'IF-MM-01', key, body, max: 1000,
      run: (c, _b, records, batch) => upsertPurchaseOrders(c, ctx.sap!, records, batch),
      // PO 항목이 없어 실패했던 입고(E202, 최근 3일)를 다시 처리
      after: async (c, _b, batch) => {
        const r = await retryPendingReceipts(c, ctx.sap!, ctx.correlationId);
        if (r) { batch.mails.push(...r.mails); log.info('sap gr retry', { batchId: r.batchId, received: r.received, failed: r.failed }); }
      } });
  }

  @Post('sap/goods-receipts')
  @Operation('sapPostGoodsReceipts')
  goodsReceipts(@Ctx() ctx: AlmContext, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    return this.inbound(ctx, res, { endpoint: 'sapPostGoodsReceipts', iface: 'IF-MM-03', key, body, max: 1000,
      run: (c, _b, records, batch) => postGoodsReceipts(c, ctx.sap!, records, batch) });
  }

  @Post('sap/reconciliation')
  @Operation('sapPostReconciliation')
  reconciliation(@Ctx() ctx: AlmContext, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    return this.posting(ctx, res, 'sapPostReconciliation', key, body,
      async (c) => ({ ...await postReconciliation(c, ctx.sap!, body, ctx.correlationId), mails: [] }));
  }
}
