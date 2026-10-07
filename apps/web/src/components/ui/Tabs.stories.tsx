import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Tabs } from './Tabs';

const items = ['General', 'Financial & SAP', 'Contracts', 'Relationships', 'Tickets', 'History'].map((l) => ({ value: l, label: l }));
const meta = { title: 'Components/Tabs', component: Tabs<string>, args: { items, value: 'General', onChange: () => {}, label: 'Asset sections' } } satisfies Meta<typeof Tabs<string>>;
export default meta;
type Story = StoryObj<typeof meta>;

export const AssetSections: Story = {
  render: (args) => {
    const [v, setV] = useState('General');
    return <Tabs {...args} value={v} onChange={setV} />;
  },
};
