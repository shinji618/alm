import type { Meta, StoryObj } from '@storybook/react-vite';

const COLORS = ['bg', 'surface', 'sunk', 'line', 'ink', 'muted', 'faint', 'accent', 'accent-soft', 'tag', 'ok', 'ok-soft', 'warn', 'warn-soft', 'bad', 'bad-soft', 'info', 'info-soft', 'rail'];
const STAGES = ['plan', 'procure', 'deploy', 'operate', 'maintain', 'retire'];
const TYPE = [
  ['--fs-h1', 'display', 'View title 22'],
  ['--fs-kpi', 'display', '1,284'],
  ['--fs-h2', 'display', 'Panel title 14'],
  ['--fs-body', 'body', 'Body text 14 — 본문 텍스트'],
  ['--fs-table', 'body', 'Table cell 13'],
  ['--fs-small', 'mono', 'BSG-NB-000123'],
  ['--fs-label', 'body', 'LABEL 11'],
];
const SPACE = [1, 2, 3, 4, 5, 6];

function Swatch({ name, prefix = '' }: { name: string; prefix?: string }) {
  const v = `--${prefix}${name}`;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width: 36, height: 36, borderRadius: 'var(--r)', background: `var(${v})`, border: '1px solid var(--line)' }} />
      <code className="mono">{v}</code>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 'var(--space-6)' }}>
      <h2 style={{ fontFamily: 'var(--f-display)', fontSize: 'var(--fs-h2)', margin: '0 0 var(--space-3)' }}>{title}</h2>
      {children}
    </section>
  );
}

function Tokens() {
  return (
    <div style={{ color: 'var(--ink)' }}>
      <Section title="Color">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
          {COLORS.map((c) => <Swatch key={c} name={c} />)}
        </div>
      </Section>
      <Section title="Lifecycle stages">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
          {STAGES.map((c) => <Swatch key={c} name={c} prefix="stage-" />)}
        </div>
      </Section>
      <Section title="Type">
        {TYPE.map(([size, fam, sample]) => (
          <div key={size} style={{ display: 'flex', gap: 16, alignItems: 'baseline', padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
            <code className="mono muted" style={{ width: 110 }}>{size}</code>
            <span style={{ fontFamily: `var(--f-${fam})`, fontSize: `var(${size})` }}>{sample}</span>
          </div>
        ))}
      </Section>
      <Section title="Space">
        {SPACE.map((n) => (
          <div key={n} style={{ display: 'flex', gap: 16, alignItems: 'center', padding: '4px 0' }}>
            <code className="mono muted" style={{ width: 110 }}>--space-{n}</code>
            <span style={{ height: 12, width: `var(--space-${n})`, background: 'var(--accent)' }} />
          </div>
        ))}
      </Section>
    </div>
  );
}

const meta = { title: 'Foundations/Tokens', parameters: { layout: 'padded' }, render: () => <Tokens /> } satisfies Meta;
export default meta;
export const All: StoryObj<typeof meta> = {};
