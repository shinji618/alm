import type { Meta, StoryObj } from '@storybook/react-vite';
import { ProgressBar } from './ProgressBar';

const meta = { title: 'Components/ProgressBar', component: ProgressBar, args: { value: 9, max: 10, label: 'Room progress' }, decorators: [(S) => <div style={{ width: 320 }}><S /></div>] } satisfies Meta<typeof ProgressBar>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Single: Story = {};
export const Stacked: Story = {
  args: {
    label: 'Count result',
    large: true,
    max: 23,
    segments: [{ value: 16, color: 'var(--ok)', label: 'Found' }, { value: 4, color: 'var(--warn)', label: 'Elsewhere' }, { value: 3, color: 'var(--bad)', label: 'Not found' }],
  },
};
