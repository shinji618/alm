import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { FilterBar, FilterSelect } from './FilterBar';
import { ChipGroup } from './Chip';

const meta = { title: 'Components/FilterBar', component: FilterBar, args: { search: '', onSearch: () => {} } } satisfies Meta<typeof FilterBar>;
export default meta;
type Story = StoryObj<typeof meta>;

/** 검색 300ms 디바운스 · 선택 · 칩 · 초기화 */
export const AssetFilters: Story = {
  render: () => {
    const [q, setQ] = useState('');
    const [cat, setCat] = useState('');
    const [chip, setChip] = useState<'all' | 'warranty' | 'eol' | 'nonsap'>('all');
    const dirty = !!q || !!cat || chip !== 'all';
    return (
      <div style={{ border: '1px solid var(--line)', borderRadius: 8, background: 'var(--surface)' }}>
        <FilterBar search={q} onSearch={setQ} searchPlaceholder="Filter tag, serial, owner, IP…" onClear={dirty ? () => { setQ(''); setCat(''); setChip('all'); } : undefined}>
          <FilterSelect label="Category" allLabel="All categories" value={cat} onChange={setCat} options={['Laptop', 'Desktop', 'Server'].map((v) => ({ value: v, label: v }))} />
          <ChipGroup label="Quick filters" value={chip} onChange={setChip} options={[{ value: 'all', label: 'All' }, { value: 'warranty', label: 'Warranty ≤ 90d' }, { value: 'eol', label: 'Past useful life' }, { value: 'nonsap', label: 'Non-SAP' }]} />
        </FilterBar>
        <div className="small muted" style={{ padding: 12 }}>q = “{q}” · category = “{cat}” · chip = {chip}</div>
      </div>
    );
  },
};
