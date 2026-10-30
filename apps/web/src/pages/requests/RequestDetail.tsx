// ALM-230 자산 요청 상세: 요청 값 · 승인 단계 · SAP 전기. 지금 단계 승인자는 승인·반려, 요청자는 제출·취소
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ViewHeader } from '@/components/layout';
import { AssetTag, Button, Drawer, EmptyState, FormGrid, KeyValue, Panel, SelectField, StatusPill, Steps, TextField, TextareaField, Timeline, useConfirm, useToast } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { formatDate, formatDateTime, formatUsd, type Lang } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { sysText } from '@/lib/serverText';
import { useSession } from '@/lib/session';
import { statusTone, type ApprovalStep, type RequestDetail as Detail } from './types';
import s from '../assets/assets.module.css';

export function RequestDetail() {
  const { id = '' } = useParams();
  const { t, i18n } = useTranslation();
  const lang = i18n.language as Lang;
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { refresh } = useSession();
  const r = useAsync((sig) => api.get<Detail>(`/asset-requests/${id}`, sig), [id]);
  const [deciding, setDeciding] = useState<'approve' | 'reject'>();
  const [fixing, setFixing] = useState(false);
  const [busy, setBusy] = useState(false);

  if (r.error) {
    const notFound = r.error instanceof ApiError && r.error.status === 404;
    return (
      <>
        <ViewHeader crumb="ALM-230" title={t('nav.requests')} />
        <Panel><EmptyState message={notFound ? t('request.detail.notFound') : t('common.error', { message: r.error.message })} /></Panel>
      </>
    );
  }
  const d = r.data;
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try { await fn(); toast.show(msg, 'success'); r.reload(); refresh(); } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), 'error');
    } finally { setBusy(false); }
  };
  const cancel = async () => {
    if (!d || !(await confirm({ title: t('request.detail.cancelTitle', { no: d.requestNo }), message: t('request.detail.cancelMessage'), danger: true,
      confirmLabel: t('request.detail.cancel') }))) return;
    await run(() => api.post(`/asset-requests/${d.id}:cancel`), t('request.detail.cancelled'));
  };
  const submit = () => d && run(() => api.post(`/asset-requests/${d.id}:submit`), t('request.detail.submitted'));

  return (
    <>
      <ViewHeader crumb={`ALM-230 · ${t('nav.requests')}`} title={d ? `${d.requestNo} · ${t(`request.type.${d.request.requestType}`)}` : t('common.loading')}
        description={d && (
          <span className={s.headRow}>
            <StatusPill tone={statusTone[d.status]}>{t(`request.status.${d.status}`)}</StatusPill>
            {d.asset && <Link to={`/assets/${d.asset.id}`}><AssetTag tag={d.asset.assetTag} /></Link>}
            {d.asset && <span>{d.asset.description}</span>}
            <span className="small muted">{t('request.detail.by', { name: d.requesterName, at: formatDateTime(d.submittedAt ?? d.createdAt) })}</span>
          </span>
        )}
        actions={d && (
          <>
            <Button onClick={() => nav('/requests')}>{t('nav.requests')}</Button>
            {d.actions.submit && <Button variant="primary" disabled={busy} onClick={submit}>{t('request.detail.submit')}</Button>}
            {d.actions.cancel && <Button disabled={busy} onClick={cancel}>{t('request.detail.cancel')}</Button>}
            {d.actions.fix && <Button variant="primary" disabled={busy} onClick={() => setFixing(true)}>{t('request.fix.title')}</Button>}
            {d.actions.approve && <Button disabled={busy} onClick={() => setDeciding('reject')}>{t('request.detail.reject')}</Button>}
            {d.actions.approve && <Button variant="primary" disabled={busy} onClick={() => setDeciding('approve')}>{t('request.detail.approve')}</Button>}
          </>
        )} />
      {!d ? <Panel><span className="muted">{t('common.loading')}</span></Panel> : (
        <>
          <Panel>
            <Steps label={t('request.detail.flow')} current={flowIndex(d)} steps={flowLabels(d, t)} />
            {d.status === 'REJECTED' && <div className={s.notice} role="status">{t('request.detail.rejectedNote')}</div>}
            {d.status === 'POST_ERROR' && <div className={s.notice} role="alert">{t('request.detail.postErrorNote')}</div>}
          </Panel>
          <Panel>
            <h3 style={{ marginTop: 0 }}>{t('request.detail.values')}</h3>
            <Values d={d} lang={lang} />
          </Panel>
          <Panel>
            <h3 style={{ marginTop: 0 }}>{t('request.detail.approvals')}</h3>
            {d.deptManagerMissing && ['DRAFT', 'SUBMITTED'].includes(d.status) && <div className={s.notice}>{t('request.detail.proxyNote')}</div>}
            {d.approvals.length ? <Approvals steps={d.approvals} />
              : <span className="muted">{t(d.approvalSteps === 0 ? 'request.detail.noApproval' : 'request.detail.noApprovals')}</span>}
          </Panel>
          <Panel>
            <h3 style={{ marginTop: 0 }}>{t('request.detail.posting')}</h3>
            <Posting d={d} />
          </Panel>
        </>
      )}
      {d && fixing && <FixDrawer d={d} onClose={() => setFixing(false)} onDone={(n) => { setFixing(false); r.setData(n); refresh(); }} />}
      {d && deciding && d.actions.approve && (
        <DecisionDrawer d={d} kind={deciding} approvalId={d.actions.approve} onClose={() => setDeciding(undefined)}
          onDone={(st) => { setDeciding(undefined); toast.show(t(st.decision === 'REJECTED' ? 'request.detail.rejected' : 'request.detail.approved'), 'success'); r.reload(); refresh(); }} />
      )}
    </>
  );
}

// 진행 표시: 만든 승인 단계(이관은 보내는·받는 부서)가 있으면 그대로, 없으면(초안) 회사 설정(승인 단계 2·1·0, SAP 연계)으로
function flowSteps(d: Detail): { key: string; cc?: string }[] {
  const n = d.approvalSteps ?? 2;
  const approvals = d.approvals.length ? d.approvals.map((x) => ({ key: x.approverRole === 'DEPT_MANAGER' ? 'mgr' : 'acct', cc: x.costCenter }))
    : [...(n >= 1 ? [{ key: 'mgr' }] : []), ...(n >= 2 ? [{ key: 'acct' }] : [])];
  return [{ key: 'submit' }, ...approvals, ...(d.sapEnabled !== false ? [{ key: 'sap' }] : [])];
}
function flowLabels(d: Detail, t: (k: string) => string): string[] {
  const steps = flowSteps(d);
  const multi = steps.filter((x) => x.key === 'mgr').length > 1;   // 이관: 부서 단계마다 코스트센터를 붙인다
  return steps.map((x) => `${t(`request.flow.${x.key}`)}${multi && x.cc ? ` (${x.cc.split(' · ')[0]})` : ''}`);
}
function flowIndex(d: Detail): number {
  const approvals = flowSteps(d).length - 1 - (d.sapEnabled !== false ? 1 : 0);
  switch (d.status) {
    case 'DRAFT': return 0;
    case 'SUBMITTED': case 'MGR_APPROVED': return Math.max(1, d.currentStep);
    case 'ACCT_APPROVED': case 'POST_ERROR': return 1 + approvals;
    case 'POSTED': return flowSteps(d).length;
    default: return Math.max(0, d.currentStep);
  }
}

function Values({ d, lang }: { d: Detail; lang: Lang }) {
  const { t } = useTranslation();
  const q = d.request;
  const masked = t('request.detail.masked');
  const amount = (v?: number) => (v !== undefined ? <span className="num">{formatUsd(v, 2)}</span> : d.amountMasked ? masked : undefined);
  const items: { label: string; value: ReactNode }[] = [
    { label: t('request.field.reason'), value: sysText(t, q.reason) },
    { label: t('request.field.sapAsset'), value: d.asset?.sapAssetNo ? <span className="mono">{d.asset.companyCode}/{d.asset.sapAssetNo}</span> : t('asset.fin.notInSap') },
  ];
  switch (q.requestType) {
    case 'NEW_ASSET':
      items.push({ label: t('request.field.assetClass'), value: d.labels.assetClass }, { label: t('request.field.costCenter'), value: d.labels.targetCostCenter },
        { label: t('request.field.acquisitionValue'), value: amount(q.acquisitionValue) }, { label: t('request.field.capDate'), value: q.effectiveDate && formatDate(q.effectiveDate, lang) },
        { label: t('request.field.poItem'), value: d.labels.poItem });
      break;
    case 'TRANSFER':
      items.push({ label: t('request.field.fromCostCenter'), value: d.labels.currentCostCenter }, { label: t('request.field.costCenter'), value: d.labels.targetCostCenter },
        { label: t('request.field.effectiveDate'), value: q.effectiveDate && formatDate(q.effectiveDate, lang) },
        { label: t('request.field.pcChange'), value: d.isProfitCenterChange ? t('request.detail.pcChangeYes') : t('request.detail.pcChangeNo') });
      break;
    case 'CHANGE':
      items.push({ label: t('request.field.room'), value: d.labels.targetRoom }, { label: t('request.field.description'), value: q.changes?.description },
        { label: t('request.field.serialNo'), value: q.changes?.serialNo });
      break;
    case 'RETIRE':
      items.push({ label: t('request.field.retireType'), value: q.retireType && t(`request.retireType.${q.retireType}`) },
        { label: t('request.field.retireDate'), value: q.effectiveDate && formatDate(q.effectiveDate, lang) });
      break;
    case 'SALE':
      items.push({ label: t('request.field.saleAmount'), value: amount(q.saleAmount) }, { label: t('request.field.buyer'), value: q.buyer },
        { label: t('request.field.retireDate'), value: q.effectiveDate && formatDate(q.effectiveDate, lang) });
      break;
  }
  return <KeyValue items={items} />;
}

function Approvals({ steps }: { steps: ApprovalStep[] }) {
  const { t } = useTranslation();
  return (
    <Timeline label={t('request.detail.approvals')} events={steps.map((x) => ({
      id: x.id,
      meta: <>{t('request.detail.step', { no: x.stepNo })} · {t(`role.${x.approverRole}`)}{x.costCenter && <> · {x.costCenter}</>}
        {x.proxy && <> · {t('request.detail.proxyStep')}</>}{x.decidedAt && <> · {formatDateTime(x.decidedAt)}</>}</>,
      body: (
        <div>
          <strong>{t(`request.decision.${x.decision}`)}</strong>{x.approverName && <span> · {x.approverName}</span>}
          {x.comment && <div className="small">{sysText(t, x.comment)}</div>}
        </div>
      ),
    }))} />
  );
}

function Posting({ d }: { d: Detail }) {
  const { t } = useTranslation();
  const p = d.posting;
  if (!p && d.sapEnabled === false) return <span className="muted">{t('request.detail.noSapPosting')}</span>;
  if (!p) {
    const local = d.request.requestType !== 'NEW_ASSET' && !d.asset?.sapAssetNo;
    return <span className="muted">{local ? t('request.detail.localOnly') : t('request.detail.noPosting')}</span>;
  }
  return (
    <>
      <KeyValue items={[
        { label: t('request.posting.type'), value: p.postingType },
        { label: t('request.posting.status'), value: t(`request.posting.statuses.${p.status}`) },
        { label: t('request.posting.attempts'), value: p.attemptCount },
        { label: t('request.posting.document'), value: p.sapDocumentNo && <span className="mono">{p.sapDocumentNo}{p.sapFiscalYear ? ` / ${p.sapFiscalYear}` : ''}</span> },
        { label: t('request.posting.assetNo'), value: p.sapAssetNo && <span className="mono">{p.sapAssetNo}</span> },
        { label: t('request.posting.resultAt'), value: p.resultAt && formatDateTime(p.resultAt) },
      ]} />
      {p.messages.length > 0 && (
        <ul className="small" style={{ margin: '8px 0 0', paddingLeft: 16 }}>
          {p.messages.map((m, i) => <li key={i}><span className="mono">{m.type} {m.id} {m.number}</span> {sysText(t, m.text)}</li>)}
        </ul>
      )}
    </>
  );
}

function DecisionDrawer({ d, kind, approvalId, onClose, onDone }: { d: Detail; kind: 'approve' | 'reject'; approvalId: string; onClose: () => void;
  onDone: (s: ApprovalStep) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const title = t(kind === 'approve' ? 'request.detail.approve' : 'request.detail.reject');
  const last = d.currentStep >= 2;
  const submit = async () => {
    if (kind === 'reject' && !comment.trim()) { setError(t('request.detail.commentRequired')); return; }
    if (kind === 'approve' && last && !(await confirm({ title: t('request.detail.finalTitle', { no: d.requestNo }), message: t('request.detail.finalMessage'),
      confirmLabel: title }))) return;
    setSaving(true);
    try {
      onDone(await api.post<ApprovalStep>(`/approvals/${approvalId}:${kind}`, { comment: comment.trim() || undefined }));
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), 'error');
    } finally { setSaving(false); }
  };
  return (
    <Drawer open onClose={onClose} label={title} title={`${title} · ${d.requestNo}`}>
      <FormGrid onSubmit={() => void submit()}>
        <TextareaField label={t('request.detail.comment')} required={kind === 'reject'} maxLength={500} value={comment} error={error}
          onChange={(x) => { setComment(x.target.value); setError(undefined); }} />
        <div className={s.formActions}>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" disabled={saving}>{title}</Button>
        </div>
      </FormGrid>
    </Drawer>
  );
}

// 전기 오류 보정(자산회계): 기술 필드는 바로 재전기, 회계 필드를 바꾸면 승인을 처음부터 다시 받는다
function FixDrawer({ d, onClose, onDone }: { d: Detail; onClose: () => void; onDone: (n: Detail) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const q = d.request;
  const [f, setF] = useState({ effectiveDate: q.effectiveDate ?? '', description: q.changes?.description ?? '', serialNo: q.changes?.serialNo ?? '',
    acquisitionValue: q.acquisitionValue !== undefined ? String(q.acquisitionValue) : '', saleAmount: q.saleAmount !== undefined ? String(q.saleAmount) : '',
    retireType: q.retireType ?? '', comment: '' });
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const changes: Record<string, unknown> = {};
  if (q.requestType === 'CHANGE' && f.description !== (q.changes?.description ?? '')) changes.description = f.description;
  if (q.requestType === 'CHANGE' && f.serialNo !== (q.changes?.serialNo ?? '')) changes.serialNo = f.serialNo;
  if (q.requestType === 'NEW_ASSET' && f.acquisitionValue && Number(f.acquisitionValue) !== q.acquisitionValue) changes.acquisitionValue = Number(f.acquisitionValue);
  if (q.requestType === 'SALE' && f.saleAmount && Number(f.saleAmount) !== q.saleAmount) changes.saleAmount = Number(f.saleAmount);
  if (q.requestType === 'RETIRE' && f.retireType && f.retireType !== q.retireType) changes.retireType = f.retireType;
  const reapproval = ['acquisitionValue', 'saleAmount', 'retireType'].some((k) => k in changes);
  const submit = async () => {
    if (!f.comment.trim()) { setError(t('request.fix.commentRequired')); return; }
    setSaving(true);
    try {
      const body = { comment: f.comment.trim(), ...(f.effectiveDate && f.effectiveDate !== q.effectiveDate ? { effectiveDate: f.effectiveDate } : {}),
        ...(Object.keys(changes).length ? { changes } : {}) };
      const n = await api.post<Detail>(`/asset-requests/${d.id}:fix`, body, d.version);
      toast.show(t(n.status === 'SUBMITTED' ? 'request.fix.reapproval' : 'request.fix.queued'), 'success');
      onDone(n);
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), 'error');
    } finally { setSaving(false); }
  };
  return (
    <Drawer open onClose={onClose} label={t('request.fix.title')} title={`${t('request.fix.title')} · ${d.requestNo}`}>
      <FormGrid onSubmit={() => void submit()}>
        <TextField label={t('request.fix.date')} type="date" value={f.effectiveDate} onChange={(x) => set('effectiveDate', x.target.value)} />
        {q.requestType === 'CHANGE' && (
          <>
            <TextField label={t('request.field.description')} maxLength={50} value={f.description} onChange={(x) => set('description', x.target.value)} />
            <TextField label={t('request.field.serialNo')} maxLength={18} value={f.serialNo} onChange={(x) => set('serialNo', x.target.value)} />
          </>
        )}
        {q.requestType === 'NEW_ASSET' && <TextField label={t('request.field.acquisitionValue')} type="number" min="0" step="0.01" value={f.acquisitionValue} onChange={(x) => set('acquisitionValue', x.target.value)} />}
        {q.requestType === 'SALE' && <TextField label={t('request.field.saleAmount')} type="number" min="0" step="0.01" value={f.saleAmount} onChange={(x) => set('saleAmount', x.target.value)} />}
        {q.requestType === 'RETIRE' && (
          <SelectField label={t('request.field.retireType')} value={f.retireType} options={['SCRAP', 'LOSS'].map((x) => ({ value: x, label: t(`request.retireType.${x}`) }))}
            onChange={(x) => set('retireType', x.target.value)} />
        )}
        <TextareaField label={t('request.fix.comment')} required maxLength={500} value={f.comment} error={error} onChange={(x) => { set('comment', x.target.value); setError(undefined); }} />
        <div className={s.notice} style={{ gridColumn: '1 / -1' }}>{t(reapproval ? 'request.fix.reapprovalNote' : 'request.fix.queueNote')}</div>
        <div className={s.formActions}>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" disabled={saving}>{t('request.fix.submit')}</Button>
        </div>
      </FormGrid>
    </Drawer>
  );
}
