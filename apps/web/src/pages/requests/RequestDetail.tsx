// ALM-230 자산 요청 상세: 요청 값 · 승인 단계 · SAP 전기. 지금 단계 승인자는 승인·반려, 요청자는 제출·취소
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ViewHeader } from '@/components/layout';
import { AssetTag, Button, Drawer, EmptyState, FormGrid, KeyValue, Panel, StatusPill, Steps, TextareaField, Timeline, useConfirm, useToast } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { formatDate, formatDateTime, formatUsd, type Lang } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
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
            {d.actions.approve && <Button disabled={busy} onClick={() => setDeciding('reject')}>{t('request.detail.reject')}</Button>}
            {d.actions.approve && <Button variant="primary" disabled={busy} onClick={() => setDeciding('approve')}>{t('request.detail.approve')}</Button>}
          </>
        )} />
      {!d ? <Panel><span className="muted">{t('common.loading')}</span></Panel> : (
        <>
          <Panel>
            <Steps label={t('request.detail.flow')} current={flowIndex(d)} steps={[t('request.flow.submit'), t('request.flow.mgr'), t('request.flow.acct'), t('request.flow.sap')]} />
            {d.status === 'REJECTED' && <div className={s.notice} role="status">{t('request.detail.rejectedNote')}</div>}
            {d.status === 'POST_ERROR' && <div className={s.notice} role="alert">{t('request.detail.postErrorNote')}</div>}
          </Panel>
          <Panel>
            <h3 style={{ marginTop: 0 }}>{t('request.detail.values')}</h3>
            <Values d={d} lang={lang} />
          </Panel>
          <Panel>
            <h3 style={{ marginTop: 0 }}>{t('request.detail.approvals')}</h3>
            {d.approvals.length ? <Approvals steps={d.approvals} /> : <span className="muted">{t('request.detail.noApprovals')}</span>}
          </Panel>
          <Panel>
            <h3 style={{ marginTop: 0 }}>{t('request.detail.posting')}</h3>
            <Posting d={d} />
          </Panel>
        </>
      )}
      {d && deciding && d.actions.approve && (
        <DecisionDrawer d={d} kind={deciding} approvalId={d.actions.approve} onClose={() => setDeciding(undefined)}
          onDone={(st) => { setDeciding(undefined); toast.show(t(st.decision === 'REJECTED' ? 'request.detail.rejected' : 'request.detail.approved'), 'success'); r.reload(); refresh(); }} />
      )}
    </>
  );
}

// 진행 표시: 0 제출 전, 1 부서 관리자, 2 자산회계, 3 SAP 전기, 4 완료
function flowIndex(d: Detail): number {
  switch (d.status) {
    case 'DRAFT': return 0;
    case 'SUBMITTED': return 1;
    case 'MGR_APPROVED': return 2;
    case 'ACCT_APPROVED': case 'POST_ERROR': return 3;
    case 'POSTED': return 4;
    default: return Math.max(0, d.currentStep);
  }
}

function Values({ d, lang }: { d: Detail; lang: Lang }) {
  const { t } = useTranslation();
  const q = d.request;
  const masked = t('request.detail.masked');
  const amount = (v?: number) => (v !== undefined ? <span className="num">{formatUsd(v, 2)}</span> : d.amountMasked ? masked : undefined);
  const items: { label: string; value: ReactNode }[] = [
    { label: t('request.field.reason'), value: q.reason },
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
      meta: <>{t('request.detail.step', { no: x.stepNo })} · {t(`role.${x.approverRole}`)}{x.decidedAt && <> · {formatDateTime(x.decidedAt)}</>}</>,
      body: (
        <div>
          <strong>{t(`request.decision.${x.decision}`)}</strong>{x.approverName && <span> · {x.approverName}</span>}
          {x.comment && <div className="small">{x.comment}</div>}
        </div>
      ),
    }))} />
  );
}

function Posting({ d }: { d: Detail }) {
  const { t } = useTranslation();
  const p = d.posting;
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
          {p.messages.map((m, i) => <li key={i}><span className="mono">{m.type} {m.id} {m.number}</span> {m.text}</li>)}
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
