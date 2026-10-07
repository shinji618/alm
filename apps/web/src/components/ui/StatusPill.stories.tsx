import type { Meta, StoryObj } from '@storybook/react-vite';
import { StatusPill } from './StatusPill';
import { assetStatusTone, type AssetStatus } from '@/lib/status';

const meta = {
  title: 'Components/StatusPill',
  component: StatusPill,
  args: { tone: 'ok', children: 'In Use' },
  argTypes: { tone: { control: 'select', options: ['ok', 'warn', 'bad', 'info', 'accent', 'neutral'] } },
} satisfies Meta<typeof StatusPill>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};
/** 화면설계서 5.1 — 자산 상태별 색 */
export const AssetStatuses: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {(Object.keys(assetStatusTone) as AssetStatus[]).map((s) => (
        <StatusPill key={s} tone={assetStatusTone[s]}>{s}</StatusPill>
      ))}
    </div>
  ),
};
