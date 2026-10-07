import type { Meta, StoryObj } from '@storybook/react-vite';
import { Panel } from './Panel';
import { Button } from './Button';

const meta = { title: 'Components/Panel', component: Panel, args: { title: 'Upcoming renewals', subtitle: 'next 120 days', children: 'Panel body' } } satisfies Meta<typeof Panel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const WithActions: Story = { args: { actions: <Button size="sm">Review</Button> } };
export const NoHeader: Story = { args: { title: undefined, subtitle: undefined } };
