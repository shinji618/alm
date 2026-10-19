// 자산 상세(ALM-111)에서 여는 자산 요청 작성(ALM-230, F-111-06): 이관 · 변경 · 폐기 · 매각 · SAP 등록(SAP 자산번호가 없을 때)
//   임시 저장(DRAFT) 또는 바로 제출. 승인(부서 관리자 → 자산회계) 뒤 SAP 전기, SAP 자산이 아니면 승인 즉시 ALM에 반영
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Drawer, FormGrid, SelectField, TextField, TextareaField, useToast } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import type { AssetDetail, Lookups, LookupItem } from '../assets/types';
import type { RequestDetail, RequestInput, RequestType } from './types';
import s from '../assets/assets.module.css';

const today = () => new Date().toISOString().slice(0, 10);
const opts = (xs: LookupItem[] | undefined) => [{ value: '', label: '—' }, ...(xs ?? []).map((x) => ({ value: x.id, label: `${x.code} · ${x.label}` }))];

export function RequestDrawer({ d, L, onClose, onDone }: { d: AssetDetail; L: Lookups; onClose: () => void; onDone: (id: string) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const sapCompany = d.financial.sapEnabled !== false;
  const sap = sapCompany && !!d.financial.sapAssetNo;   // SAP에 보낼 자산인가
  // Bundle 구성품은 SAP에 보내지 않는다(Bundle을 등록). Bundle의 SAP 취득가 기본값은 구매가, 없으면 구성품 구매가 합
  const types: RequestType[] = sap || !sapCompany || d.bundle ? ['TRANSFER', 'CHANGE', 'RETIRE', 'SALE'] : ['NEW_ASSET', 'TRANSFER', 'CHANGE', 'RETIRE', 'SALE'];
  const value = d.financial.tcoEstimate || (d.isBundle ? d.componentCostTotal : undefined);
  const [f, setF] = useState({ type: types[0], reason: '', assetClassId: '', targetCostCenterId: '', acquisitionValue: value ? String(value) : '',
    effectiveDate: today(), targetRoomId: '', description: d.description, serialNo: d.serialNo ?? '', retireType: 'SCRAP', saleAmount: '', buyer: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const companyCode = d.financial.companyCode;
  const ccs = useMemo(() => (L.costCenters ?? []).filter((c) => !c.extra?.companyCode || c.extra.companyCode === companyCode), [L.costCenters, companyCode]);
  // SAP 신규 등록: SAP 자산클래스(직접 만든 클래스 제외) 중 자본화 클래스만
  const classes = useMemo(() => (L.assetClasses ?? []).filter((c) => c.extra?.isCapitalized !== false && c.extra?.isLowValue !== true && c.extra?.isManual !== true), [L.assetClasses]);

  const body = (): RequestInput => {
    const base = { requestType: f.type, assetId: d.id, reason: f.reason.trim() };
    switch (f.type) {
      case 'NEW_ASSET': return { ...base, assetClassId: f.assetClassId, targetCostCenterId: f.targetCostCenterId || d.costCenterId,
        acquisitionValue: f.acquisitionValue ? Number(f.acquisitionValue) : undefined, effectiveDate: f.effectiveDate || undefined };
      case 'TRANSFER': return { ...base, targetCostCenterId: f.targetCostCenterId, effectiveDate: f.effectiveDate, targetRoomId: f.targetRoomId || undefined };
      case 'CHANGE': {
        const changes: RequestInput['changes'] = {};
        if (f.description.trim() !== d.description) changes.description = f.description.trim();
        if (f.serialNo.trim() !== (d.serialNo ?? '')) changes.serialNo = f.serialNo.trim();
        return { ...base, changes: Object.keys(changes).length ? changes : undefined, targetRoomId: f.targetRoomId || undefined };
      }
      case 'RETIRE': return { ...base, retireType: f.retireType as 'SCRAP' | 'LOSS', effectiveDate: f.effectiveDate };
      case 'SALE': return { ...base, saleAmount: f.saleAmount ? Number(f.saleAmount) : undefined, buyer: f.buyer.trim() || undefined, effectiveDate: f.effectiveDate || undefined };
    }
  };
  // 화면 검사(서버가 다시 검사한다)
  const check = (b: RequestInput) => {
    const e: Record<string, string> = {};
    const req = t('common.required');
    if (!b.reason) e.reason = req;
    if (f.type === 'NEW_ASSET') {
      if (!b.assetClassId) e.assetClassId = req;
      if (!b.targetCostCenterId) e.targetCostCenterId = req;
      if (!(Number(b.acquisitionValue) > 0)) e.acquisitionValue = req;
    }
    if (f.type === 'TRANSFER') {
      if (!b.targetCostCenterId) e.targetCostCenterId = req;
      else if (b.targetCostCenterId === d.costCenterId) e.targetCostCenterId = t('request.form.sameCostCenter');
      if (!b.effectiveDate) e.effectiveDate = req;
    }
    if (f.type === 'CHANGE' && !b.changes && !b.targetRoomId) e.targetRoomId = t('request.form.nothingChanged');
    if (f.type === 'RETIRE' && !b.effectiveDate) e.effectiveDate = req;
    if (f.type === 'SALE') {
      if (!(Number(b.saleAmount) > 0)) e.saleAmount = req;
      if (!b.buyer) e.buyer = req;
    }
    return e;
  };
  const save = async (submit: boolean) => {
    const b = body();
    const e = check(b);
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    try {
      const r = await api.post<RequestDetail>('/asset-requests', { ...b, submit });
      toast.show(t(submit ? 'request.form.submitted' : 'request.form.saved', { no: r.requestNo }), 'success');
      onDone(r.id);
    } catch (err) {
      if (err instanceof ApiError && err.errors.length) {
        const fe = err.fieldErrors();
        setErrors(Object.fromEntries(Object.entries(fe).map(([k, v]) => [k.replace(/^changes\./, ''), v])));
      }
      toast.show(err instanceof Error ? err.message : String(err), 'error');
    } finally { setSaving(false); }
  };
  const e = errors;
  const title = t('asset.detail.newRequest');
  return (
    <Drawer open onClose={onClose} label={title} title={`${title} · ${d.assetTag}`}>
      <FormGrid onSubmit={() => void save(true)}>
        <SelectField label={t('request.col.type')} value={f.type} options={types.map((x) => ({ value: x, label: t(`request.type.${x}`) }))}
          onChange={(x) => { set('type', x.target.value); setErrors({}); }} />
        <div className="small muted" style={{ alignSelf: 'end' }}>{t(`request.form.hint.${f.type}`)}{!sap && f.type !== 'NEW_ASSET' ? ` ${t('request.form.localHint')}` : ''}</div>
        {f.type === 'NEW_ASSET' && (
          <>
            <SelectField label={t('request.field.assetClass')} required value={f.assetClassId} error={e.assetClassId} options={opts(classes)} onChange={(x) => set('assetClassId', x.target.value)} />
            <SelectField label={t('request.field.costCenter')} required value={f.targetCostCenterId || d.costCenterId || ''} error={e.targetCostCenterId} options={opts(ccs)}
              onChange={(x) => set('targetCostCenterId', x.target.value)} />
            <TextField label={t('request.field.acquisitionValue')} required type="number" min="0" step="0.01" inputMode="decimal" value={f.acquisitionValue}
              error={e.acquisitionValue} onChange={(x) => set('acquisitionValue', x.target.value)} />
            <TextField label={t('request.field.capDate')} type="date" value={f.effectiveDate} error={e.effectiveDate} onChange={(x) => set('effectiveDate', x.target.value)} />
          </>
        )}
        {f.type === 'TRANSFER' && (
          <>
            <SelectField label={t('request.field.costCenter')} required value={f.targetCostCenterId} error={e.targetCostCenterId} options={opts(ccs)}
              onChange={(x) => set('targetCostCenterId', x.target.value)} />
            <TextField label={t('request.field.effectiveDate')} required type="date" value={f.effectiveDate} error={e.effectiveDate} onChange={(x) => set('effectiveDate', x.target.value)} />
            <SelectField label={t('request.field.room')} value={f.targetRoomId} error={e.targetRoomId} options={opts(L.rooms)} onChange={(x) => set('targetRoomId', x.target.value)} />
            <div />
          </>
        )}
        {f.type === 'CHANGE' && (
          <>
            <SelectField label={t('request.field.room')} value={f.targetRoomId} error={e.targetRoomId} options={opts(L.rooms)} onChange={(x) => set('targetRoomId', x.target.value)} />
            <TextField label={t('request.field.description')} maxLength={50} value={f.description} error={e.description} onChange={(x) => set('description', x.target.value)} />
            <TextField label={t('request.field.serialNo')} maxLength={sap ? 18 : 40} value={f.serialNo} error={e.serialNo} onChange={(x) => set('serialNo', x.target.value)} />
            <div />
          </>
        )}
        {f.type === 'RETIRE' && (
          <>
            <SelectField label={t('request.field.retireType')} required value={f.retireType} options={['SCRAP', 'LOSS'].map((x) => ({ value: x, label: t(`request.retireType.${x}`) }))}
              onChange={(x) => set('retireType', x.target.value)} />
            <TextField label={t('request.field.retireDate')} required type="date" value={f.effectiveDate} error={e.effectiveDate} onChange={(x) => set('effectiveDate', x.target.value)} />
          </>
        )}
        {f.type === 'SALE' && (
          <>
            <TextField label={t('request.field.saleAmount')} required type="number" min="0" step="0.01" inputMode="decimal" value={f.saleAmount} error={e.saleAmount}
              onChange={(x) => set('saleAmount', x.target.value)} />
            <TextField label={t('request.field.buyer')} required maxLength={80} value={f.buyer} error={e.buyer} onChange={(x) => set('buyer', x.target.value)} />
            <TextField label={t('request.field.retireDate')} type="date" value={f.effectiveDate} error={e.effectiveDate} onChange={(x) => set('effectiveDate', x.target.value)} />
            <div />
          </>
        )}
        <TextareaField label={t('request.field.reason')} required maxLength={200} value={f.reason} error={e.reason} onChange={(x) => set('reason', x.target.value)} />
        <div className={s.formActions}>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button disabled={saving} onClick={() => void save(false)}>{t('request.form.saveDraft')}</Button>
          <Button variant="primary" type="submit" disabled={saving}>{t('request.form.submit')}</Button>
        </div>
      </FormGrid>
    </Drawer>
  );
}
