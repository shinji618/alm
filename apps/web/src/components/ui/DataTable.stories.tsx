import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { DataTable, type Column } from './DataTable';
import { AssetTag } from './AssetTag';
import { StatusPill } from './StatusPill';
import { assetStatusTone, type AssetStatus } from '@/lib/status';
import { formatUsd } from '@/lib/format';

/** 예시 데이터 */
interface Row { tag: string; name: string; status: AssetStatus; room: string; nbv: number }
const rows: Row[] = [
  { tag: 'AT-100231', name: 'Dell Latitude 7450', status: 'In Use', room: 'ATL1-3F-FIN', nbv: 1240 },
  { tag: 'AT-100244', name: 'HPE ProLiant DL380 Gen11', status: 'In Repair', room: 'ATL1-B1-DC', nbv: 18450 },
  { tag: 'AT-100257', name: 'Dell P2725H', status: 'In Stock', room: 'ATL1-2F-IT', nbv: 210 },
  { tag: 'AT-100262', name: 'Toyota 8FGCU25 Forklift', status: 'Missing', room: 'SAV1-WH', nbv: 31200 },
];
const columns: Column<Row>[] = [
  { key: 'tag', label: 'Asset tag', render: (r) => <AssetTag tag={r.tag} />, sortValue: (r) => r.tag },
  { key: 'name', label: 'Asset', sortValue: (r) => r.name },
  { key: 'status', label: 'Status', render: (r) => <StatusPill tone={assetStatusTone[r.status]}>{r.status}</StatusPill> },
  { key: 'room', label: 'Location', render: (r) => <span className="mono">{r.room}</span> },
  { key: 'nbv', label: 'Net book value', align: 'right', render: (r) => formatUsd(r.nbv), sortValue: (r) => r.nbv },
];

const meta = {
  title: 'Components/DataTable',
  component: DataTable<Row>,
  args: { rows, columns, rowId: (r: Row) => r.tag, onRowClick: fn(), footer: `${rows.length} of ${rows.length} assets` },
} satisfies Meta<typeof DataTable<Row>>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Selectable: Story = {
  render: (args) => {
    const [sel, setSel] = useState<string[]>(['AT-100244']);
    return <DataTable {...args} selected={sel} onSelectedChange={setSel} footer={`${sel.length} selected`} />;
  },
};
export const Loading: Story = { args: { loading: true } };
export const Empty: Story = { args: { rows: [] } };
