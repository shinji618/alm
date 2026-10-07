import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './AppShell';
import { ViewHeader } from './ViewHeader';
import { Button, KpiTile, Panel } from '../ui';

function SampleView() {
  return (
    <>
      <ViewHeader
        crumb="Assets"
        title="Asset register"
        description="All hardware, software and SAP fixed assets in one list."
        actions={
          <>
            <Button>Export</Button>
            <Button variant="primary">New asset</Button>
          </>
        }
      />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
        <KpiTile label="Total assets" value="1,284" />
        <KpiTile label="In use" value="1,012" />
        <KpiTile label="Pending count" value="10" />
      </div>
      <Panel title="Work area" padded>
        <p className="muted">Each screen renders into this area through the router Outlet.</p>
      </Panel>
    </>
  );
}

const meta = {
  title: 'Layout/AppShell',
  component: AppShell,
  parameters: { layout: 'fullscreen' },
  args: { counts: { '/requests': { count: 3 }, '/counts': { count: 10, alert: true }, '/sap': { count: 5, alert: true } } },
  render: (args) => (
    <MemoryRouter initialEntries={['/assets']}>
      <Routes>
        <Route element={<AppShell {...args} />}>
          <Route path="*" element={<SampleView />} />
        </Route>
      </Routes>
    </MemoryRouter>
  ),
} satisfies Meta<typeof AppShell>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Mobile: Story = { globals: { viewport: { value: 'mobile2', isRotated: false } } };
