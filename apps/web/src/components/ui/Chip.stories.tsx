import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Chip, ChipGroup } from './Chip';

const meta = { title: 'Components/Chip', component: Chip, args: { children: 'Warranty ≤ 90d', on: false } } satisfies Meta<typeof Chip>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Off: Story = {};
export const On: Story = { args: { on: true } };
export const Group: Story = {
  render: () => {
    const [v, setV] = useState<'open' | 'done' | 'all'>('open');
    return <ChipGroup label="Request state" value={v} onChange={setV} options={[{ value: 'open', label: 'Open' }, { value: 'done', label: 'Completed' }, { value: 'all', label: 'All' }]} />;
  },
};
