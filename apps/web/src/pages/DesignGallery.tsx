import { useState } from 'react';
import { ViewHeader } from '@/components/layout';
import {
  AssetTag, Button, CheckboxField, ChipGroup, DataTable, Drawer, EmptyState, FilterBar, FilterSelect, FormGrid, KeyValue, KpiTile,
  Panel, ProgressBar, SelectField, Skeleton, StatusPill, Steps, Tabs, TextareaField, TextField, Timeline, useConfirm, useToast, type Column,
} from '@/components/ui';
import { assetStatusTone, stageColorVar, STAGES, type AssetStatus, type Stage } from '@/lib/status';
import { formatDate, formatUsd, formatUsdCompact } from '@/lib/format';
import s from './gallery.module.css';

/** 예시 데이터 — 디자인 확인용(실데이터 아님) */
interface SampleAsset {
  tag: string;
  name: string;
  cat: string;
  status: AssetStatus;
  stage: Stage;
  owner: string;
  room: string;
  sap: string;
  nbv: number;
  warranty: string;
}
const SAMPLE: SampleAsset[] = [
  { tag: 'AT-100231', name: 'Dell Latitude 7450', cat: 'Laptop', status: 'In Use', stage: 'Operate', owner: 'Daniel Kim', room: 'ATL1-3F-FIN', sap: '300001231-0', nbv: 1240, warranty: '2027-05-14' },
  { tag: 'AT-100244', name: 'HPE ProLiant DL380 Gen11', cat: 'Server', status: 'In Repair', stage: 'Maintain', owner: '', room: 'ATL1-B1-DC', sap: '300001244-0', nbv: 18450, warranty: '2026-12-01' },
  { tag: 'AT-100257', name: 'Dell P2725H', cat: 'Monitor', status: 'In Stock', stage: 'Deploy', owner: '', room: 'ATL1-2F-IT', sap: '', nbv: 210, warranty: '2028-01-20' },
  { tag: 'AT-100262', name: 'Toyota 8FGCU25 Forklift', cat: 'Machinery', status: 'Missing', stage: 'Operate', owner: '', room: 'SAV1-WH', sap: '300001262-0', nbv: 31200, warranty: '2026-10-30' },
  { tag: 'AT-100270', name: 'Cisco Catalyst 9300-48P', cat: 'Network', status: 'Retired', stage: 'Retire', owner: '', room: 'ATL1-B1-DC', sap: '300001270-0', nbv: 0, warranty: '2025-03-01' },
];

const COLUMNS: Column<SampleAsset>[] = [
  { key: 'tag', label: 'Asset tag', render: (r) => <AssetTag tag={r.tag} />, sortValue: (r) => r.tag },
  { key: 'name', label: 'Asset', render: (r) => (<><b>{r.name}</b><div className="small faint">{r.cat}</div></>), sortValue: (r) => r.name },
  { key: 'status', label: 'Status', render: (r) => <StatusPill tone={assetStatusTone[r.status]}>{r.status}</StatusPill> },
  { key: 'stage', label: 'Stage', render: (r) => <span className="small" style={{ fontWeight: 600, color: stageColorVar[r.stage] }}>● {r.stage}</span> },
  { key: 'owner', label: 'Owner', render: (r) => r.owner || <span className="faint">Unassigned</span> },
  { key: 'room', label: 'Location', render: (r) => <span className="mono">{r.room}</span> },
  { key: 'sap', label: 'SAP asset', render: (r) => (r.sap ? <span className="mono">{r.sap}</span> : <span className="faint">—</span>) },
  { key: 'nbv', label: 'Net book value', align: 'right', render: (r) => formatUsd(r.nbv), sortValue: (r) => r.nbv },
];

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <Panel title={<span><span className="mono faint">{id}</span> {title}</span>}>
      <div className={s.stack}>{children}</div>
    </Panel>
  );
}

export function DesignGallery() {
  const toast = useToast();
  const confirm = useConfirm();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [chip, setChip] = useState<'all' | 'warranty' | 'eol'>('all');
  const [sel, setSel] = useState<string[]>([]);
  const [drawer, setDrawer] = useState<SampleAsset | null>(null);
  const [tab, setTab] = useState<'general' | 'financial' | 'history'>('general');
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState('');
  const rows = SAMPLE.filter((a) => (!cat || a.cat === cat) && (!q || `${a.tag} ${a.name} ${a.owner} ${a.room}`.toLowerCase().includes(q.toLowerCase())));

  return (
    <>
      <ViewHeader
        crumb="Design system · WBS 3.5"
        title="Component gallery"
        description="Every shared component from the UI spec, rendered with sample data. Switch language and theme from the user menu to check both."
        actions={<Button variant="primary" onClick={() => toast.show('Saved: sample toast', 'success')}>Show toast</Button>}
      />

      <Section id="4.1" title="Button">
        <div className={s.row}>
          <Button variant="primary">Primary</Button>
          <Button>Default</Button>
          <Button variant="danger">Danger</Button>
          <Button size="sm">Small</Button>
          <Button disabled>Disabled</Button>
        </div>
      </Section>

      <Section id="4.2–4.3" title="StatusPill · AssetTag">
        <div className={s.row}>
          {(Object.keys(assetStatusTone) as AssetStatus[]).map((st) => (
            <StatusPill key={st} tone={assetStatusTone[st]}>{st}</StatusPill>
          ))}
          <AssetTag tag="AT-100231" />
          <AssetTag tag="AT-100244" onClick={(t) => toast.show(`Open ${t}`)} />
        </div>
      </Section>

      <Section id="4.4" title="KpiTile">
        <div className={s.kpis}>
          <KpiTile label="Active assets" value="81" hint="61 capitalized in SAP" onClick={() => toast.show('→ Assets')} />
          <KpiTile label="Net book value" value={formatUsdCompact(204000)} hint={`APC ${formatUsdCompact(663200)}`} />
          <KpiTile label="Warranty ≤ 90 days" value="7" hint="renew or plan refresh" tone="warn" />
          <KpiTile label="License compliance" value="88%" hint="1 product under-licensed" />
          <KpiTile label="Count discrepancies" value="10" hint="19/23 counted · ATL1" tone="bad" />
          <KpiTile label="SAP sync errors" value="1" hint="last load 06:00 today" tone="bad" />
        </div>
      </Section>

      <Panel title="4.6–4.8 DataTable · FilterBar · Chip" subtitle="Sample data · click a row to open the drawer" padded={false} actions={<Button size="sm" onClick={() => { setLoading(true); setTimeout(() => setLoading(false), 1500); }}>Show loading</Button>}>
        <FilterBar search={q} onSearch={setQ} searchPlaceholder="Filter tag, owner, room…" onClear={q || cat || chip !== 'all' ? () => { setQ(''); setCat(''); setChip('all'); } : undefined}>
          <FilterSelect label="Category" allLabel="All categories" value={cat} onChange={setCat} options={['Laptop', 'Server', 'Monitor', 'Machinery', 'Network'].map((c) => ({ value: c, label: c }))} />
          <ChipGroup label="Quick filters" value={chip} onChange={setChip} options={[{ value: 'all', label: 'All' }, { value: 'warranty', label: 'Warranty ≤ 90d' }, { value: 'eol', label: 'Past useful life' }]} />
        </FilterBar>
        <DataTable
          rows={rows}
          columns={COLUMNS}
          rowId={(r) => r.tag}
          loading={loading}
          selected={sel}
          onSelectedChange={setSel}
          onRowClick={(r) => { setTab('general'); setDrawer(r); }}
          empty={<EmptyState message="No assets match these filters." action={<Button size="sm" onClick={() => { setQ(''); setCat(''); }}>Clear filters</Button>} />}
          footer={<><span>{rows.length} of {SAMPLE.length} assets · NBV {formatUsd(rows.reduce((a, r) => a + r.nbv, 0))}</span><span>{sel.length} selected</span></>}
        />
      </Panel>

      <div className={s.two}>
        <Section id="4.12–4.13" title="Steps · ProgressBar">
          <Steps label="Lifecycle" steps={STAGES} current={3} />
          <Steps label="Approval route" steps={['Submitted', 'Manager', 'Asset accounting', 'Posted to SAP']} current={2} />
          <ProgressBar label="Room progress" value={9} max={10} />
          <ProgressBar
            label="Count result"
            large
            max={23}
            segments={[{ value: 16, color: 'var(--ok)', label: 'Found' }, { value: 4, color: 'var(--warn)', label: 'Elsewhere' }, { value: 3, color: 'var(--bad)', label: 'Not found' }]}
          />
        </Section>
        <Section id="4.11 · 4.14" title="KeyValue · Timeline">
          <KeyValue items={[{ label: 'Asset tag', value: <AssetTag tag="AT-100231" /> }, { label: 'Serial number', value: <span className="mono">DL7Q2K91</span> }, { label: 'Cost center', value: <span className="mono">1000-4100</span> }, { label: 'IP address', value: '' }]} />
          <Timeline label="History" events={[{ id: '1', meta: `${formatDate('2026-10-02')} · Assigned`, body: 'Checked out to Daniel Kim · Finance' }, { id: '2', meta: `${formatDate('2026-09-22')} · Created`, body: 'Received on PO 4500018231' }]} />
        </Section>
      </div>

      <div className={s.two}>
        <Section id="4.15" title="Field · FormGrid">
          <FormGrid onSubmit={() => toast.show(name ? `Saved ${name}` : 'Fix the errors and try again', name ? 'success' : 'error')}>
            <TextField label="Manufacturer & model" required value={name} onChange={(e) => setName(e.target.value)} error={name ? undefined : 'Enter the manufacturer and model, e.g. Dell Latitude 7450.'} />
            <SelectField label="Category" required options={[{ value: 'Laptop', label: 'Laptop' }, { value: 'Server', label: 'Server' }]} />
            <TextField label="Acquisition cost (USD)" type="number" min={0} step="0.01" defaultValue="1840" />
            <TextField label="Warranty end" type="date" defaultValue="2029-10-07" hint="Default: today + 3 years" />
            <TextareaField label="Reason" defaultValue="Department change" />
            <CheckboxField label="Create SAP fixed asset (company code 1000) after approval" defaultChecked />
            <div style={{ gridColumn: '1 / -1' }}>
              <Button variant="primary" type="submit">Save asset</Button>
            </div>
          </FormGrid>
        </Section>
        <Section id="4.16–4.18" title="Toast · ConfirmDialog · EmptyState · Skeleton">
          <div className={s.row}>
            <Button onClick={() => toast.show('AT-100231 checked out to Daniel Kim', 'success')}>Success toast</Button>
            <Button onClick={() => toast.show('SAP posting failed: AAPO 176 cost center does not exist', 'error')}>Error toast</Button>
            <Button
              variant="danger"
              onClick={async () => {
                const ok = await confirm({ title: 'Reject AR-5013?', message: 'The requester is notified and the asset does not change.', confirmLabel: 'Reject', danger: true });
                toast.show(ok ? 'AR-5013 rejected' : 'Cancelled');
              }}
            >
              Reject request…
            </Button>
          </div>
          <EmptyState message="Queue is clear. Every discovered device matches an asset record." />
          <Skeleton width="60%" />
          <Skeleton width="40%" />
        </Section>
      </div>

      <Drawer
        open={!!drawer}
        onClose={() => setDrawer(null)}
        label={drawer ? `Asset ${drawer.tag}` : 'Asset'}
        badges={drawer && (<><AssetTag tag={drawer.tag} /><StatusPill tone={assetStatusTone[drawer.status]}>{drawer.status}</StatusPill>{drawer.sap ? <StatusPill tone="accent">SAP {drawer.sap}</StatusPill> : <StatusPill>Non-SAP</StatusPill>}</>)}
        title={drawer?.name ?? ''}
        subtitle={drawer && `${drawer.cat} · ${drawer.room} · ${drawer.owner || 'Unassigned'}`}
        toolbar={<Tabs label="Asset sections" value={tab} onChange={setTab} items={[{ value: 'general', label: 'General' }, { value: 'financial', label: 'Financial & SAP' }, { value: 'history', label: 'History' }]} />}
      >
        {drawer && tab === 'general' && (
          <>
            <KeyValue items={[{ label: 'Category', value: drawer.cat }, { label: 'Room', value: <span className="mono">{drawer.room}</span> }, { label: 'Assigned to', value: drawer.owner }, { label: 'Warranty end', value: formatDate(drawer.warranty) }]} />
            <Steps label="Lifecycle" steps={STAGES} current={STAGES.indexOf(drawer.stage)} />
          </>
        )}
        {drawer && tab === 'financial' && <KeyValue items={[{ label: 'SAP asset (ANLN1-ANLN2)', value: drawer.sap }, { label: 'Net book value', value: formatUsd(drawer.nbv, 2) }]} />}
        {drawer && tab === 'history' && <Timeline label="History" events={[{ id: '1', meta: `${formatDate('2026-09-22')} · Created`, body: 'Received on PO 4500018231' }]} />}
      </Drawer>
    </>
  );
}
