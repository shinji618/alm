import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { KpiTile } from './KpiTile';

const meta = {
  title: 'Components/KpiTile',
  component: KpiTile,
  args: { label: 'Active assets', value: '81', hint: '61 capitalized in SAP' },
  decorators: [(S) => <div style={{ width: 220 }}><S /></div>],
} satisfies Meta<typeof KpiTile>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Clickable: Story = { args: { onClick: fn() } };
export const Warn: Story = { args: { label: 'Warranty ≤ 90 days', value: '7', hint: 'renew or plan refresh', tone: 'warn' } };
export const Bad: Story = { args: { label: 'SAP sync errors', value: '1', hint: 'last load 06:00 today', tone: 'bad' } };
