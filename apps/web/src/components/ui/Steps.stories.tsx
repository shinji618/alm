import type { Meta, StoryObj } from '@storybook/react-vite';
import { Steps } from './Steps';
import { STAGES } from '@/lib/status';

const meta = { title: 'Components/Steps', component: Steps, args: { steps: STAGES, current: 3, label: 'Lifecycle' } } satisfies Meta<typeof Steps>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Lifecycle: Story = {};
export const ApprovalRoute: Story = { args: { steps: ['Submitted', 'Manager', 'Asset accounting', 'Posted to SAP'], current: 2, label: 'Approval route' } };
export const CountCampaign: Story = { args: { steps: ['Plan scope', 'Count', 'Review differences', 'Post to SAP', 'Close'], current: 1, label: 'Count campaign' } };
export const AllDone: Story = { args: { steps: ['Submitted', 'Manager', 'Asset accounting', 'Posted to SAP'], current: 4, label: 'Approval route' } };
