// 요청 문맥: 추적 ID·접속 IP·인증 주체. 미들웨어가 만들고 가드가 채운다
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Principal } from '../auth/principal';
import type { AccessClaims } from '../auth/cognito';
import type { TxContext } from '../db/pool';
import type { SapConn } from '../auth/sap';

export interface AlmContext {
  correlationId: string; ip?: string; userAgent?: string; claims?: AccessClaims; principal?: Principal;
  channel?: 'WEB' | 'PDA' | 'SAP';
  sap?: SapConn;                                      // SAP 채널: 연결(테넌트·회사코드)
  device?: { id?: string; serial: string };           // PDA 채널: X-Device-Id
  loginRecorded?: boolean;                            // 이 요청에서 이미 LOGIN을 남김(PDA 첫 로그인)
}
export type AlmRequest = Request & { alm: AlmContext };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// CloudFront가 붙이는 CloudFront-Viewer-Address('IP:포트')를 우선한다. ALB는 내부 전용(VPC 오리진)이라 직접 위조할 경로가 없다
export function clientIp(req: Request): string | undefined {
  const v = req.header('cloudfront-viewer-address');
  if (v) return v.slice(0, v.lastIndexOf(':')).replace(/^\[|\]$/g, '');
  return req.ip;
}

export function contextMiddleware(req: Request, res: Response, next: NextFunction) {
  const h = req.header('x-correlation-id');
  const correlationId = h && UUID.test(h) ? h : randomUUID();
  (req as AlmRequest).alm = { correlationId, ip: clientIp(req), userAgent: req.header('user-agent') };
  res.setHeader('X-Correlation-Id', correlationId);
  res.setHeader('Cache-Control', 'no-store');
  next();
}

// operationId(openapi) → permissions.json operations로 권한 키를 찾는다
export const OPERATION = 'alm:operation';
export const Operation = (operationId: string) => SetMetadata(OPERATION, operationId);
export const PUBLIC = 'alm:public';
export const Public = () => SetMetadata(PUBLIC, true);

export const Ctx = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AlmRequest>().alm);

export function txOf(c: AlmContext): TxContext {
  if (c.sap) return { tenantId: c.sap.tenantId, actorType: 'SAP', correlationId: c.correlationId, clientIp: c.ip };
  if (!c.principal) throw new Error('인증 주체 없음');
  return { tenantId: c.principal.tenantId, userId: c.principal.userId, actorType: c.channel === 'PDA' ? 'PDA' : 'USER',
    correlationId: c.correlationId, clientIp: c.ip };
}
