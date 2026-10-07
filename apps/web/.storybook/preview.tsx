import type { Preview } from '@storybook/react-vite';
import { withThemeByDataAttribute } from '@storybook/addon-themes';
import { useEffect } from 'react';
import '@fontsource/manrope/600.css';
import '@fontsource/manrope/700.css';
import '@fontsource/manrope/800.css';
import '@fontsource/source-sans-3/400.css';
import '@fontsource/source-sans-3/500.css';
import '@fontsource/source-sans-3/600.css';
import '@fontsource/source-sans-3/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import '../src/styles/global.css';
import i18n from '../src/i18n';
import { ConfirmProvider, ToastProvider } from '../src/components/ui';

const preview: Preview = {
  parameters: {
    layout: 'padded',
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    a11y: { test: 'error' },
    backgrounds: { disable: true },
  },
  globalTypes: {
    locale: {
      description: 'UI language',
      toolbar: { icon: 'globe', items: [{ value: 'en', title: 'English' }, { value: 'ko', title: '한국어' }], dynamicTitle: true },
    },
  },
  initialGlobals: { locale: 'en' },
  decorators: [
    withThemeByDataAttribute({ themes: { light: 'light', dark: 'dark' }, defaultTheme: 'light', attributeName: 'data-theme' }),
    (Story, ctx) => {
      const locale = (ctx.globals.locale as string) ?? 'en';
      useEffect(() => {
        void i18n.changeLanguage(locale);
      }, [locale]);
      return (
        <ToastProvider>
          <ConfirmProvider>
            <div style={{ background: 'var(--bg)', color: 'var(--ink)', padding: ctx.parameters.layout === 'fullscreen' ? 0 : 16, minHeight: '100%' }}>
              <Story />
            </div>
          </ConfirmProvider>
        </ToastProvider>
      );
    },
  ],
};
export default preview;
