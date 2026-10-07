import type { StorybookConfig } from '@storybook/react-vite';

/** Storybook — 화면설계서 4장 컴포넌트 카탈로그 (WBS 3.5 완료 기준 11.3) */
const config: StorybookConfig = {
  stories: ['../src/**/*.mdx', '../src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-docs', '@storybook/addon-a11y', '@storybook/addon-themes'],
  staticDirs: ['../public'],
  framework: { name: '@storybook/react-vite', options: {} },
};
export default config;
