import type { Meta, StoryObj } from '@storybook/react-vite';
import { KeyValue } from './KeyValue';

const meta = {
  title: 'Components/KeyValue',
  component: KeyValue,
  args: {
    items: [
      { label: 'Company code (BUKRS)', value: '1000 · BSG America Inc.' },
      { label: 'Asset / sub-number', value: <span className="mono">300001231-0</span> },
      { label: 'Asset class (ANLKL)', value: '3100 · IT Hardware' },
      { label: 'Cost center (KOSTL)', value: <span className="mono">1000-4100</span> },
      { label: 'IP address', value: '' },
    ],
  },
} satisfies Meta<typeof KeyValue>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TwoColumns: Story = {};
export const OneColumn: Story = { args: { columns: 1 } };
