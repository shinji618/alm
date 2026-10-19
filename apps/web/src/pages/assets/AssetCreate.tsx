// ALM-112 자산 등록. SAP 고정자산 등록은 등록자가 체크 박스로 정한다(2026-10-12 결정):
//   자산클래스가 자본화 클래스면 체크를 기본으로 제안하고, 체크하면 구매가가 필수 → 신규 자산 요청(승인 후 IF-AA-03)
//   Bundle 자산(2026-10-19): 모델 없이 등록, 자산 목록에서 고른 자산(?components=)을 구성품으로. SAP 취득가를 비우면 구성품 구매가 합
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ViewHeader } from '@/components/layout';
import { Button, CheckboxField, FormGrid, Panel, SelectField, TextField, TextareaField, useToast } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useAsync } from '@/lib/useAsync';
import type { AssetDetail, Lookups, LookupItem, RequestRef } from './types';
import s from './assets.module.css';

interface Form {
  categoryId: string; modelId: string; description: string; serialNo: string; companyId: string; siteId: string; roomId: string;
  costCenterId: string; assetClassId: string; status: 'IN_STOCK' | 'ON_ORDER' | 'IN_USE'; assignedUserId: string; purchaseDate: string;
  purchaseCost: string; warrantyEndDate: string; hostname: string; notes: string; printLabel: boolean; registerInSap: boolean; isBundle: boolean;
}
const EMPTY: Form = { categoryId: '', modelId: '', description: '', serialNo: '', companyId: '', siteId: '', roomId: '', costCenterId: '', assetClassId: '',
  status: 'IN_STOCK', assignedUserId: '', purchaseDate: '', purchaseCost: '', warrantyEndDate: '', hostname: '', notes: '', printLabel: true, registerInSap: false, isBundle: false };

export function AssetCreate() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const toast = useToast();
  const lk = useAsync((sig) => api.get<Lookups>('/lookups?types=companies,sites,rooms,costCenters,assetClasses,categories,models,users', sig), []);
  const [sp] = useSearchParams();
  // 메뉴의 카테고리에서 등록하면 그 카테고리로 시작한다
  const componentIds = useMemo(() => (sp.get('components') ?? '').split(',').filter((x) => /^[0-9a-f-]{36}$/i.test(x)), [sp]);
  const [f, setF] = useState<Form>(() => ({ ...EMPTY, categoryId: sp.get('categoryId') ?? '', isBundle: sp.get('bundle') === '1' || componentIds.length > 0 }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [sapTouched, setSapTouched] = useState(false);
  const L = lk.data ?? {};
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));

  // 회사코드가 하나면 자동 선택
  useEffect(() => { if (!f.companyId && L.companies?.length === 1) set('companyId', L.companies[0].id); }, [L.companies, f.companyId]);
  const category = L.categories?.find((c) => c.id === f.categoryId);
  const classId = f.assetClassId || (category?.extra?.defaultAssetClassId as string | undefined) || '';
  const cls = L.assetClasses?.find((c) => c.id === classId);
  const company = L.companies?.find((c) => c.id === f.companyId);
  const sapCompany = company?.extra?.sapEnabled !== false;   // SAP 연계를 끈 회사는 SAP 등록 체크를 숨긴다
  const capitalized = sapCompany && !!cls && cls.extra?.isCapitalized !== false && cls.extra?.isLowValue !== true;
  // 자본화 클래스면 체크 제안(사용자가 직접 바꾼 뒤에는 건드리지 않음)
  useEffect(() => { if (!sapTouched) set('registerInSap', capitalized); }, [capitalized, sapTouched]);
  useEffect(() => { if (!sapCompany) set('registerInSap', false); }, [sapCompany]);

  const opt = (xs: LookupItem[] | undefined, blank = true) => [...(blank ? [{ value: '', label: '—' }] : []), ...(xs ?? []).map((x) => ({ value: x.id, label: `${x.code} · ${x.label}` }))];
  const models = useMemo(() => (L.models ?? []).filter((m) => !f.categoryId || m.parentId === f.categoryId), [L.models, f.categoryId]);
  const rooms = useMemo(() => (L.rooms ?? []).filter((r) => !f.siteId || r.parentId === f.siteId), [L.rooms, f.siteId]);
  const ccs = useMemo(() => {
    const co = L.companies?.find((c) => c.id === f.companyId)?.code;
    return (L.costCenters ?? []).filter((c) => !co || c.extra?.companyCode === co);
  }, [L.costCenters, L.companies, f.companyId]);

  const costFromComponents = f.isBundle && componentIds.length > 0;
  // 화면 검사(서버가 다시 검사한다)
  const check = (): Record<string, string> => {
    const e: Record<string, string> = {};
    const req = t('common.required');
    for (const k of ['categoryId', 'modelId', 'description', 'companyId', 'roomId', 'costCenterId'] as const) if (!f[k].trim() && !(k === 'modelId' && f.isBundle)) e[k] = req;
    if (f.status === 'IN_USE' && !f.assignedUserId) e.assignedUserId = req;
    if (f.registerInSap) {
      if (f.purchaseCost ? !(Number(f.purchaseCost) > 0) : !costFromComponents) e.purchaseCost = req;
      if (!classId) e.assetClassId = req;
    }
    return e;
  };

  const submit = async () => {
    const e = check();
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    try {
      const body = {
        ...(f.isBundle ? { isBundle: true, componentIds: componentIds.length ? componentIds : undefined } : {}),
        categoryId: f.categoryId, modelId: f.modelId || undefined, description: f.description.trim(), serialNo: f.serialNo.trim() || undefined, companyId: f.companyId,
        roomId: f.roomId, costCenterId: f.costCenterId, assetClassId: f.assetClassId || undefined, status: f.status,
        assignedUserId: f.status === 'IN_USE' ? f.assignedUserId : undefined, purchaseDate: f.purchaseDate || undefined,
        purchaseCost: f.purchaseCost ? Number(f.purchaseCost) : undefined, warrantyEndDate: f.warrantyEndDate || undefined,
        hostname: f.hostname.trim() || undefined, notes: f.notes.trim() || undefined, printLabel: f.printLabel, registerInSap: f.registerInSap,
      };
      const r = await api.post<{ asset: AssetDetail; createdRequest?: RequestRef; labelJobId?: string }>('/assets', body);
      toast.show(t('asset.create.done', { tag: r.asset.assetTag }), 'success');
      if (r.createdRequest) toast.show(t('asset.create.request', { no: r.createdRequest.requestNo }), 'info');
      nav(`/assets/${r.asset.id}`, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.errors.length) setErrors(err.fieldErrors());
      toast.show(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const fe = (k: string) => errors[k];
  return (
    <>
      <ViewHeader crumb={t('asset.create.crumb')} title={t('asset.create.title')} />
      <Panel>
        {lk.error && <div className={s.notice} role="alert">{t('common.error', { message: lk.error.message })}</div>}
        <FormGrid onSubmit={submit}>
          <CheckboxField label={t('asset.bundle.field')} checked={f.isBundle} disabled={componentIds.length > 0} onChange={(e) => set('isBundle', e.target.checked)} />
          <div className="small muted" style={{ gridColumn: '1 / -1', marginTop: -8 }}>
            {f.isBundle ? `${t('asset.bundle.fieldHint')} ${componentIds.length ? t('asset.bundle.componentsSelected', { count: componentIds.length }) : ''} ${t('asset.bundle.rules')}` : t('asset.bundle.fieldHint')}
          </div>
          <SelectField label={t('asset.field.category')} required value={f.categoryId} error={fe('categoryId')} options={opt(L.categories)}
            onChange={(e) => setF((x) => ({ ...x, categoryId: e.target.value, modelId: '' }))} />
          <SelectField label={t('asset.field.model')} required={!f.isBundle} value={f.modelId} error={fe('modelId')} options={opt(models)} onChange={(e) => set('modelId', e.target.value)} />
          <TextField label={t('asset.field.description')} required maxLength={50} value={f.description} error={fe('description')} onChange={(e) => set('description', e.target.value)} />
          <TextField label={t('asset.field.serialNo')} maxLength={40} value={f.serialNo} error={fe('serialNo')} onChange={(e) => set('serialNo', e.target.value)} />
          <SelectField label={t('asset.field.company')} required value={f.companyId} error={fe('companyId')} options={opt(L.companies)}
            onChange={(e) => setF((x) => ({ ...x, companyId: e.target.value, costCenterId: '' }))} />
          <SelectField label={t('asset.field.costCenter')} required value={f.costCenterId} error={fe('costCenterId')} options={opt(ccs)} onChange={(e) => set('costCenterId', e.target.value)} />
          <SelectField label={t('asset.field.site')} value={f.siteId} options={opt(L.sites)} onChange={(e) => setF((x) => ({ ...x, siteId: e.target.value, roomId: '' }))} />
          <SelectField label={t('asset.field.room')} required value={f.roomId} error={fe('roomId')} options={opt(rooms)} onChange={(e) => set('roomId', e.target.value)} />
          <SelectField label={t('asset.field.status')} value={f.status} options={(['IN_STOCK', 'ON_ORDER', 'IN_USE'] as const).map((v) => ({ value: v, label: t(`asset.status.${v}`) }))}
            onChange={(e) => set('status', e.target.value as Form['status'])} />
          {f.status === 'IN_USE' ? (
            <SelectField label={t('asset.field.assignedUser')} required value={f.assignedUserId} error={fe('assignedUserId')} options={opt(L.users)} onChange={(e) => set('assignedUserId', e.target.value)} />
          ) : <div />}
          <SelectField label={t('asset.field.assetClass')} value={f.assetClassId} error={fe('assetClassId')}
            options={[{ value: '', label: cls && !f.assetClassId ? `${cls.code} · ${cls.label}` : '—' },
              ...opt((L.assetClasses ?? []).filter((c) => !sapCompany || c.extra?.isManual !== true), false)]} onChange={(e) => set('assetClassId', e.target.value)} />
          <TextField label={t('asset.field.purchaseCost')} required={f.registerInSap && !costFromComponents} type="number" min="0" step="0.01" inputMode="decimal" value={f.purchaseCost}
            error={fe('purchaseCost')} hint={costFromComponents ? t('asset.bundle.costHint') : undefined} onChange={(e) => set('purchaseCost', e.target.value)} />
          <TextField label={t('asset.field.purchaseDate')} type="date" value={f.purchaseDate} error={fe('purchaseDate')} onChange={(e) => set('purchaseDate', e.target.value)} />
          <TextField label={t('asset.field.warrantyEndDate')} type="date" value={f.warrantyEndDate} error={fe('warrantyEndDate')} onChange={(e) => set('warrantyEndDate', e.target.value)} />
          <TextField label={t('asset.field.hostname')} maxLength={63} value={f.hostname} onChange={(e) => set('hostname', e.target.value)} />
          <div />
          <TextareaField label={t('asset.field.notes')} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
          {sapCompany && (
            <>
              <CheckboxField label={t('asset.field.registerInSap')} checked={f.registerInSap} onChange={(e) => { setSapTouched(true); set('registerInSap', e.target.checked); }} />
              <div className="small muted" style={{ gridColumn: '1 / -1', marginTop: -8 }}>
                {capitalized && !sapTouched ? `${t('asset.sapHintClass')} ` : ''}{t('asset.sapHint')}
              </div>
            </>
          )}
          <CheckboxField label={t('asset.field.printLabel')} checked={f.printLabel} onChange={(e) => set('printLabel', e.target.checked)} />
          <div className={s.formActions}>
            <Button onClick={() => nav('/assets')}>{t('common.cancel')}</Button>
            <Button variant="primary" type="submit" disabled={saving || lk.loading}>{t('asset.create.submit')}</Button>
          </div>
        </FormGrid>
      </Panel>
    </>
  );
}
