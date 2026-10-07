import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Drawer } from './Drawer';
import { Button } from './Button';
import { AssetTag } from './AssetTag';
import { StatusPill } from './StatusPill';
import { Tabs } from './Tabs';
import { KeyValue } from './KeyValue';
import { Steps } from './Steps';
import { STAGES } from '@/lib/status';

const meta = { title: 'Components/Drawer', component: Drawer, parameters: { layout: 'fullscreen' }, args: { open: true, onClose: () => {}, label: 'Asset', title: '', children: null } } satisfies Meta<typeof Drawer>;
export default meta;
type Story = StoryObj<typeof meta>;

/** ALM-111 자산 상세 형태. Esc·배경 클릭으로 닫힘 */
export const AssetDetail: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    const [tab, setTab] = useState<'general' | 'financial' | 'history'>('general');
    return (
      <div style={{ padding: 16 }}>
        <Button onClick={() => setOpen(true)}>Open drawer</Button>
        <Drawer
          open={open}
          onClose={() => setOpen(false)}
          label="Asset AT-100244"
          badges={<><AssetTag tag="AT-100244" /><StatusPill tone="warn">In Repair</StatusPill><StatusPill tone="accent">SAP 300001244-0</StatusPill></>}
          title="HPE ProLiant DL380 Gen11"
          subtitle="Server · ATL1-B1-DC · Unassigned"
          toolbar={<Tabs label="Asset sections" value={tab} onChange={setTab} items={[{ value: 'general', label: 'General' }, { value: 'financial', label: 'Financial & SAP' }, { value: 'history', label: 'History' }]} />}
        >
          <KeyValue items={[{ label: 'Category', value: 'Server' }, { label: 'Room', value: 'ATL1-B1-DC' }, { label: 'Assigned to', value: '' }, { label: 'Warranty end', value: 'Dec 01, 2026' }]} />
          <Steps label="Lifecycle" steps={STAGES} current={4} />
        </Drawer>
      </div>
    );
  },
};
