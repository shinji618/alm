import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { AssetTag } from './AssetTag';

const meta = { title: 'Components/AssetTag', component: AssetTag, args: { tag: 'AT-100231' } } satisfies Meta<typeof AssetTag>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Static: Story = {};
/** 클릭하면 자산 상세(ALM-111)를 연다 */
export const Link: Story = { args: { onClick: fn() } };
