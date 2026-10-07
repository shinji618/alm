import type { Meta, StoryObj } from '@storybook/react-vite';
import { CheckboxField, FormGrid, SelectField, TextareaField, TextField } from './Field';
import { Button } from './Button';

const meta = { title: 'Components/Field', component: TextField, args: { label: 'Serial number', placeholder: 'Scan or type' } } satisfies Meta<typeof TextField>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Text: Story = {};
export const Required: Story = { args: { label: 'Manufacturer & model', required: true } };
export const WithError: Story = { args: { label: 'Cost center', required: true, defaultValue: '1000-4399', error: 'Cost center 1000-4399 does not exist. Pick one from the list.' } };
export const WithHint: Story = { args: { label: 'Warranty end', type: 'date', hint: 'Default: today + 3 years' } };

/** ALM-112 자산 등록 폼 형태(2열, 820px 이하 1열) */
export const RegisterForm: Story = {
  render: () => (
    <FormGrid>
      <SelectField label="Category" required options={[{ value: 'Laptop', label: 'Laptop' }, { value: 'Server', label: 'Server' }]} />
      <TextField label="Manufacturer & model" required defaultValue="Dell Latitude 7450" />
      <TextField label="Serial number" placeholder="Scan or type" />
      <TextField label="Acquisition cost (USD)" type="number" defaultValue="1840" />
      <TextareaField label="Note" />
      <CheckboxField label="Create SAP fixed asset (company code 1000) after approval" defaultChecked />
      <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8 }}>
        <Button variant="primary" type="submit">Save asset</Button>
        <Button>Cancel</Button>
      </div>
    </FormGrid>
  ),
};
