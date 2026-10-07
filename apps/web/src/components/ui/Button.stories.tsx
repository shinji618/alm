import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { Button } from './Button';

const meta = {
  title: 'Components/Button',
  component: Button,
  args: { children: 'Save asset', onClick: fn() },
  argTypes: { variant: { control: 'inline-radio', options: ['default', 'primary', 'danger'] }, size: { control: 'inline-radio', options: ['md', 'sm'] } },
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = { args: { variant: 'primary' } };
export const Default: Story = {};
export const Danger: Story = { args: { variant: 'danger', children: 'Request retirement' } };
export const Small: Story = { args: { size: 'sm', children: 'Approve' } };
export const Disabled: Story = { args: { disabled: true, children: 'Print labels (0)' } };
export const AllVariants: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <Button variant="primary">+ New asset</Button>
      <Button>Export</Button>
      <Button variant="danger">Reject</Button>
      <Button size="sm">Small</Button>
      <Button disabled>Disabled</Button>
    </div>
  ),
};
