import type { Meta, StoryObj } from '@storybook/react-vite';
import { useToast } from './Toast';
import { useConfirm } from './ConfirmDialog';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { Skeleton } from './Skeleton';

/** Toast · ConfirmDialog · EmptyState · Skeleton — 화면설계서 5.4·5.5 */
const meta = { title: 'Components/Feedback', parameters: { layout: 'padded' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function ToastDemo() {
  const toast = useToast();
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <Button onClick={() => toast.show('AT-100231 checked out to Daniel Kim', 'success')}>Success toast</Button>
      <Button onClick={() => toast.show('SAP posting failed: AAPO 176 cost center does not exist', 'error')}>Error toast (stays)</Button>
    </div>
  );
}
export const Toast: Story = { render: () => <ToastDemo /> };

function ConfirmDemo() {
  const confirm = useConfirm();
  const toast = useToast();
  return (
    <Button
      variant="danger"
      onClick={async () => {
        const ok = await confirm({ title: 'Reject AR-5013?', message: 'The requester is notified and the asset does not change.', confirmLabel: 'Reject', danger: true });
        toast.show(ok ? 'AR-5013 rejected' : 'Cancelled');
      }}
    >
      Reject request…
    </Button>
  );
}
export const ConfirmDialog: Story = { render: () => <ConfirmDemo /> };

export const Empty: Story = { render: () => <EmptyState message="No assets match these filters." action={<Button size="sm">Clear filters</Button>} /> };
export const Loading: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 8, width: 320 }}>
      <Skeleton width="80%" />
      <Skeleton width="60%" />
      <Skeleton width="40%" />
    </div>
  ),
};
