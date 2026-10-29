// 관리 > 워크플로(ADM-070, WBS 4.13, 결정 E-11): 대상 유형(자산 요청 5종)별 승인 흐름 정의. admin.config(시스템 관리자)
//   자유 설계기가 아니다. 단계·담당자 규칙·대리 규칙은 제품이 정한 목록에서만 고른다. 직무 분리 규칙(H-01·H-02)은 끌 수 없다
//   저장 → 초안, 게시 → 새 버전(이전 게시본은 보관). 게시한 정의는 아직 승인 실행에 쓰이지 않는다(4.10·4.11)
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ViewHeader } from '@/components/layout';
import { Button, CheckboxField, DataTable, Drawer, EmptyState, Panel, SelectField, StatusPill, TextField, useConfirm, useToast, type Column } from '@/components/ui';
import { api, ApiError, request } from '@/lib/api';
import { useAsync } from '@/lib/useAsync';
import s from '../assets/assets.module.css';

export interface WfStep { key: string; label: string; resolver: string; fallback: string; mergeSame: boolean }
export interface WfOptions { fixerCannotReapprove: boolean; requesterNoStep: boolean; proxyIfAllSkipped: boolean }
export interface WfVersion { id: string; subjectType: string; versionNo: number; status: string; name: string; steps: WfStep[]; options: WfOptions; changeNote?: string;
  publishedAt?: string; publishedByName?: string; updatedAt?: string; updatedByName?: string; version: number }
export interface WfVersionRow { versionNo: number; status: string; name: string; changeNote?: string; publishedAt?: string; publishedByName?: string; updatedAt?: string; updatedByName?: string }
export interface WfSummary { subjectType: string; label: string; name: string; steps: WfStep[]; publishedVersion?: number; hasDraft: boolean; draftVersion?: number; usesDefault: boolean; updatedAt?: string }
export interface WfList { appliedToApprovals: boolean; items: WfSummary[] }
export interface WfDetail { subjectType: string; label: string; appliedToApprovals: boolean; published?: WfVersion; draft?: WfVersion;
  defaultDefinition: { name: string; steps: WfStep[]; options: WfOptions }; versions: WfVersionRow[] }
export interface WfCatalog { subjects: { code: string; label: string }[]; resolvers: { code: string; label: string; subjects?: string[]; final?: boolean }[];
  fallbacks: { code: string; label: string; resolver: string }[]; mandatoryRules: { code: string; label: string }[]; maxSteps: number; appliedToApprovals: boolean }
export interface WfPlanned { key: string; label: string; resolver: string; status: string; proxy: boolean; missing?: boolean; approvers: { id: string; name: string; detail?: string }[] }
export interface WfSimulation { subjectType: string; source: string; steps: WfPlanned[]; canSubmit: boolean }
interface CostCenterRow { id: string; companyId: string; companyCode: string; costCenterCode: string; name: string; isActive: boolean }

interface Form { name: string; steps: WfStep[]; options: WfOptions; changeNote: string }
const day = (v?: string) => (v ? v.slice(0, 10) : '');

export function Workflows() {
  const { t } = useTranslation();
  const [open, setOpen] = useState<string>();
  const list = useAsync((sig) => api.get<WfList>('/admin/workflows', sig), []);
  const columns = useMemo<Column<WfSummary>[]>(() => [
    { key: 'label', label: t('wf.colSubject') },
    { key: 'name', label: t('wf.colName') },
    { key: 'steps', label: t('wf.colFlow'), render: (x) => x.steps.map((st) => st.label).join(' → ') },
    { key: 'usesDefault', label: t('wf.colInUse'), render: (x) => (x.usesDefault
      ? <StatusPill tone="neutral">{t('wf.default')}</StatusPill>
      : <StatusPill tone="ok">{t('wf.publishedV', { n: x.publishedVersion })}</StatusPill>) },
    { key: 'hasDraft', label: t('wf.colDraft'), render: (x) => (x.hasDraft ? <StatusPill tone="warn">{t('wf.draftV', { n: x.draftVersion })}</StatusPill> : '') },
    { key: 'updatedAt', label: t('wf.colUpdated'), render: (x) => day(x.updatedAt) },
  ], [t]);
  const current = list.data?.items.find((x) => x.subjectType === open);
  return (
    <>
      <ViewHeader crumb={t('company.crumb')} title={t('wf.title')} description={t('wf.description')} />
      {list.data && !list.data.appliedToApprovals && <div className={s.notice} role="note">{t('wf.notApplied')}</div>}
      <Panel padded={false}>
        {list.error ? <div className={s.notice} role="alert">{t('common.error', { message: list.error.message })}</div> : (
          <DataTable rows={list.data?.items ?? []} columns={columns} rowId={(x) => x.subjectType} loading={list.loading} onRowClick={(x) => setOpen(x.subjectType)}
            empty={<EmptyState message={t('common.noResults')} />} />
        )}
      </Panel>
      {current && <Editor subject={current.subjectType} label={current.label} onClose={() => setOpen(undefined)} onChanged={() => list.reload()} />}
    </>
  );
}

const formOf = (d: WfDetail): Form => {
  const src = d.draft ?? d.published ?? d.defaultDefinition;
  return { name: src.name, steps: src.steps.map((x) => ({ ...x })), options: { ...src.options }, changeNote: d.draft?.changeNote ?? '' };
};

function Editor({ subject, label, onClose, onChanged }: { subject: string; label: string; onClose: () => void; onChanged: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const detail = useAsync((sig) => api.get<WfDetail>(`/admin/workflows/${subject}`, sig), [subject]);
  const catalog = useAsync((sig) => api.get<WfCatalog>('/admin/workflows/catalog', sig), []);
  const ccs = useAsync((sig) => api.get<{ items: CostCenterRow[] }>('/admin/cost-centers', sig), []);
  const [f, setF] = useState<Form>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [sim, setSim] = useState<WfSimulation>();
  const [srcCc, setSrcCc] = useState('');
  const [dstCc, setDstCc] = useState('');
  useEffect(() => { if (detail.data) { setF(formOf(detail.data)); setErrors({}); } }, [detail.data]);

  const cat = catalog.data;
  const resolvers = (cat?.resolvers ?? []).filter((r) => !r.subjects || r.subjects.includes(subject));
  const resolverLabel = (code: string) => cat?.resolvers.find((r) => r.code === code)?.label ?? code;
  const fallbackOptions = [{ value: 'SKIP', label: t('wf.fbSkip') }, { value: 'NONE', label: t('wf.fbNone') },
    ...(cat?.fallbacks ?? []).map((x) => ({ value: x.code, label: x.label }))];
  const transfer = subject === 'TRANSFER';
  const ccOptions = [{ value: '', label: t('wf.selectCc') }, ...(ccs.data?.items ?? []).filter((c) => c.isActive).map((c) => ({ value: c.id, label: `${c.companyCode} · ${c.costCenterCode} ${c.name}` }))];

  if (!f || !cat) {
    return <Drawer open onClose={onClose} label={t('wf.editorTitle', { label })} title={t('wf.editorTitle', { label })}>
      {detail.error ? <div className={s.notice} role="alert">{t('common.error', { message: detail.error.message })}</div> : t('common.loading')}
    </Drawer>;
  }
  const d = detail.data!;
  const setStep = (i: number, patch: Partial<WfStep>) => setF({ ...f, steps: f.steps.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const move = (i: number, by: number) => {
    const steps = [...f.steps];
    [steps[i], steps[i + by]] = [steps[i + by], steps[i]];
    setF({ ...f, steps });
  };
  const addStep = () => {
    const keys = new Set(f.steps.map((x) => x.key));
    let n = 1;
    while (keys.has(`s${n}`)) n += 1;
    const used = new Set(f.steps.map((x) => x.resolver));
    const step: WfStep = { key: `s${n}`, label: t('wf.newStep'), resolver: resolvers.find((r) => !r.final && !used.has(r.code))?.code ?? resolvers[0]?.code ?? '', fallback: 'SKIP', mergeSame: false };
    setF({ ...f, steps: [...f.steps.slice(0, -1), step, ...f.steps.slice(-1)] });   // 마지막(최종) 단계 앞에 넣는다
  };
  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.errors.length) setErrors(err.fieldErrors());
    toast.show(err instanceof Error ? err.message : String(err), 'error');
  };
  const body = () => ({ name: f.name.trim(), steps: f.steps, options: f.options, changeNote: f.changeNote.trim() || undefined });
  const check = () => {
    if (f.name.trim()) return true;
    setErrors({ name: t('common.required') });
    return false;
  };
  const save = async () => (await request<WfVersion>(`/admin/workflows/${subject}/draft`,
    { method: 'PUT', body: body(), headers: d.draft ? { 'if-match': `"${d.draft.version}"` } : undefined })).data;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErrors({});
    try { await fn(); } catch (err) { fail(err); } finally { setBusy(false); }
  };
  const saveDraft = () => check() && run(async () => { await save(); toast.show(t('company.saved'), 'success'); detail.reload(); onChanged(); });
  const publish = async () => {
    if (!check()) return;
    if (!(await confirm({ title: t('wf.publishTitle', { label }), message: t('wf.publishMessage'), confirmLabel: t('wf.publish') }))) return;
    await run(async () => {
      const v = await save();
      await api.post(`/admin/workflows/${subject}/draft:publish`, {}, v.version);
      toast.show(t('wf.publishedToast'), 'success');
      detail.reload();
      onChanged();
    });
  };
  const discard = async () => {
    if (!d.draft) return;
    if (!(await confirm({ title: t('wf.discardTitle'), message: t('wf.discardMessage', { n: d.draft.versionNo }), danger: true, confirmLabel: t('wf.discard') }))) return;
    await run(async () => { await api.del(`/admin/workflows/${subject}/draft`); toast.show(t('wf.discarded'), 'success'); detail.reload(); onChanged(); });
  };
  const restore = (n: number) => run(async () => {
    await api.post(`/admin/workflows/${subject}/versions/${n}:restore`, {});
    toast.show(t('wf.restored'), 'success');
    detail.reload();
    onChanged();
  });
  const simulate = () => run(async () => {
    const cc = (ccs.data?.items ?? []).find((c) => c.id === (srcCc || dstCc));
    setSim(await api.post<WfSimulation>(`/admin/workflows/${subject}:simulate`,
      { ...body(), sourceCostCenterId: srcCc || undefined, targetCostCenterId: transfer ? dstCc || undefined : undefined, companyId: cc?.companyId }));
  });
  const title = t('wf.editorTitle', { label });
  const canTest = transfer ? !!(srcCc || dstCc) : !!srcCc;
  return (
    <Drawer open onClose={onClose} label={title} title={title}
      badges={d.draft ? <StatusPill tone="warn">{t('wf.draftV', { n: d.draft.versionNo })}</StatusPill> : undefined}>
      <TextField label={t('wf.name')} required maxLength={100} value={f.name} error={errors.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      <h3>{t('wf.steps')}</h3>
      {f.steps.map((st, i) => {
        const last = i === f.steps.length - 1;
        return (
          <div key={st.key} className={s.notice} data-testid="wf-step">
            <div className={s.headRow}><strong>{t('wf.step', { n: i + 1 })}</strong>{last && <StatusPill tone="info">{t('wf.finalStep')}</StatusPill>}</div>
            <TextField label={t('wf.stepLabel')} maxLength={40} value={st.label} error={errors[`steps[${i}].label`]} onChange={(e) => setStep(i, { label: e.target.value })} />
            <SelectField label={t('wf.resolver')} value={st.resolver} error={errors[`steps[${i}].resolver`]} onChange={(e) => setStep(i, { resolver: e.target.value })}
              options={resolvers.map((r) => ({ value: r.code, label: r.label }))} />
            <SelectField label={t('wf.fallback')} value={st.fallback} error={errors[`steps[${i}].fallback`]} onChange={(e) => setStep(i, { fallback: e.target.value })}
              options={fallbackOptions.filter((o) => !(last && o.value === 'SKIP'))} />
            {!last && <CheckboxField label={t('wf.mergeSame')} checked={st.mergeSame} onChange={(e) => setStep(i, { mergeSame: e.target.checked })} />}
            {errors[`steps[${i}].mergeSame`] && <div role="alert" className="faint">{errors[`steps[${i}].mergeSame`]}</div>}
            <div className={s.headRow}>
              <Button disabled={i === 0} onClick={() => move(i, -1)}>{t('wf.moveUp')}</Button>
              <Button disabled={last} onClick={() => move(i, 1)}>{t('wf.moveDown')}</Button>
              <Button disabled={f.steps.length <= 1} onClick={() => setF({ ...f, steps: f.steps.filter((_, j) => j !== i) })}>{t('wf.removeStep')}</Button>
            </div>
          </div>
        );
      })}
      {errors.steps && <div role="alert" className={s.notice}>{errors.steps}</div>}
      <Button disabled={f.steps.length >= cat.maxSteps} onClick={addStep}>{t('wf.addStep')}</Button>

      <h3>{t('wf.options')}</h3>
      <CheckboxField label={t('wf.optFixer')} checked={f.options.fixerCannotReapprove} onChange={(e) => setF({ ...f, options: { ...f.options, fixerCannotReapprove: e.target.checked } })} />
      <CheckboxField label={t('wf.optRequester')} checked={f.options.requesterNoStep} onChange={(e) => setF({ ...f, options: { ...f.options, requesterNoStep: e.target.checked } })} />
      <CheckboxField label={t('wf.optProxy')} checked={f.options.proxyIfAllSkipped} onChange={(e) => setF({ ...f, options: { ...f.options, proxyIfAllSkipped: e.target.checked } })} />
      <div className={s.notice}>
        <strong>{t('wf.mandatory')}</strong>
        {cat.mandatoryRules.map((r) => <div key={r.code}>{r.code} · {r.label}</div>)}
      </div>
      <TextField label={t('wf.changeNote')} maxLength={200} value={f.changeNote} onChange={(e) => setF({ ...f, changeNote: e.target.value })} />
      <div className={s.formActions}>
        {d.draft && <Button disabled={busy} onClick={() => void discard()}>{t('wf.discard')}</Button>}
        <Button disabled={busy} onClick={() => void saveDraft()}>{t('wf.saveDraft')}</Button>
        <Button variant="primary" disabled={busy} onClick={() => void publish()}>{t('wf.publish')}</Button>
      </div>

      <h3>{t('wf.test')}</h3>
      <p className="faint">{t('wf.testHint')}</p>
      <SelectField label={transfer ? t('wf.sourceCc') : t('wf.costCenter')} value={srcCc} onChange={(e) => { setSrcCc(e.target.value); setSim(undefined); }} options={ccOptions} />
      {transfer && <SelectField label={t('wf.targetCc')} value={dstCc} onChange={(e) => { setDstCc(e.target.value); setSim(undefined); }} options={ccOptions} />}
      <Button disabled={busy || !canTest} onClick={() => void simulate()}>{t('wf.run')}</Button>
      {sim && (
        <div data-testid="wf-sim">
          {!sim.canSubmit && <div className={s.notice} role="alert">{t('wf.cannotSubmit')}</div>}
          {sim.steps.map((st) => (
            <div key={st.key} className={s.notice}>
              <div className={s.headRow}>
                <strong>{st.label}</strong>
                <StatusPill tone={st.missing ? 'warn' : st.status === 'ACTIVE' ? 'ok' : 'neutral'}>{st.missing ? t('wf.missing') : t(`wf.status.${st.status}`)}</StatusPill>
                {st.proxy && <StatusPill tone="info">{t('wf.proxy')}</StatusPill>}
              </div>
              <div className="faint">{resolverLabel(st.resolver)}</div>
              <div>{st.approvers.length ? st.approvers.map((a) => `${a.name}${a.detail ? ` (${a.detail})` : ''}`).join(', ') : '—'}</div>
            </div>
          ))}
        </div>
      )}

      <h3>{t('wf.versions')}</h3>
      {d.versions.map((v) => (
        <div key={v.versionNo} className={s.notice} data-testid="wf-version">
          <div className={s.headRow}>
            <strong>v{v.versionNo}</strong><span>{v.name}</span>
            <StatusPill tone={v.status === 'PUBLISHED' ? 'ok' : v.status === 'DRAFT' ? 'warn' : 'neutral'}>{t(`wf.vstatus.${v.status}`)}</StatusPill>
          </div>
          <div className="faint">{[day(v.publishedAt ?? v.updatedAt), v.publishedByName ?? v.updatedByName, v.changeNote].filter(Boolean).join(' · ')}</div>
          {v.status !== 'DRAFT' && !d.draft && <Button disabled={busy} onClick={() => void restore(v.versionNo)}>{t('wf.restore')}</Button>}
        </div>
      ))}
    </Drawer>
  );
}
