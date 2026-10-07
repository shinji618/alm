import type { Meta, StoryObj } from '@storybook/react-vite';
import { Timeline } from './Timeline';

const meta = {
  title: 'Components/Timeline',
  component: Timeline,
  args: {
    label: 'Asset history',
    events: [
      { id: '3', meta: 'Oct 03, 2026 · SAP posting', body: 'Transfer AR-5007 posted with ABUMN, document 0100004398' },
      { id: '2', meta: 'Sep 29, 2026 · Assigned', body: 'Checked out to Daniel Kim · Finance' },
      { id: '1', meta: 'Sep 22, 2026 · Created', body: 'Received on PO 4500018231' },
    ],
  },
} satisfies Meta<typeof Timeline>;
export default meta;
export const History: StoryObj<typeof meta> = {};
