import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button, ConfirmProvider, DataTable, Drawer, StatusPill, useConfirm, type Column } from '@/components/ui';

interface Row { id: string; name: string; value: number }
const rows: Row[] = [
  { id: 'A', name: 'Bravo', value: 20 },
  { id: 'B', name: 'Alpha', value: 5 },
  { id: 'C', name: 'Charlie', value: 12 },
];
const cols: Column<Row>[] = [
  { key: 'name', label: 'Name', sortValue: (r) => r.name },
  { key: 'value', label: 'Value', align: 'right', sortValue: (r) => r.value },
];

function SelectableTable({ onRow }: { onRow: (r: Row) => void }) {
  const [sel, setSel] = useState<string[]>([]);
  return (
    <>
      <DataTable rows={rows} columns={cols} rowId={(r) => r.id} selected={sel} onSelectedChange={setSel} onRowClick={onRow} />
      <output>{sel.join(',')}</output>
    </>
  );
}

describe('DataTable', () => {
  it('sorts by a column when its header is clicked', async () => {
    render(<DataTable rows={rows} columns={cols} rowId={(r) => r.id} />);
    await userEvent.click(screen.getByRole('button', { name: /Name/ }));
    const names = screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0].textContent);
    expect(names).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('selects rows without triggering row click', async () => {
    const onRow = vi.fn();
    render(<SelectableTable onRow={onRow} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select B' }));
    expect(document.querySelector('output')?.textContent).toBe('B');
    expect(onRow).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText('Charlie'));
    expect(onRow).toHaveBeenCalledWith(rows[2]);
  });

  it('shows the empty state when there are no rows', () => {
    render(<DataTable rows={[]} columns={cols} rowId={(r) => r.id} />);
    expect(screen.getByText('No results match these filters.')).toBeInTheDocument();
  });
});

describe('Drawer', () => {
  it('closes on Escape and on scrim click', async () => {
    const onClose = vi.fn();
    render(<Drawer open onClose={onClose} label="Asset AT-1" title="Dell"><p>Body</p></Drawer>);
    expect(screen.getByRole('dialog', { name: 'Asset AT-1' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByTestId('drawer-scrim'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('ConfirmDialog', () => {
  function Asker({ onResult }: { onResult: (v: boolean) => void }) {
    const confirm = useConfirm();
    return <Button onClick={async () => onResult(await confirm({ title: 'Reject AR-1?', danger: true, confirmLabel: 'Reject' }))}>Ask</Button>;
  }
  it('resolves true on confirm and false on cancel', async () => {
    const onResult = vi.fn();
    render(<ConfirmProvider><Asker onResult={onResult} /></ConfirmProvider>);
    await userEvent.click(screen.getByText('Ask'));
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onResult).toHaveBeenLastCalledWith(true);
    await userEvent.click(screen.getByText('Ask'));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onResult).toHaveBeenLastCalledWith(false);
  });
});

describe('StatusPill', () => {
  it('always renders its text', () => {
    render(<StatusPill tone="bad">Missing</StatusPill>);
    expect(screen.getByText('Missing')).toBeInTheDocument();
  });
});
