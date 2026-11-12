/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// 공유 플랫폼(suite) 빌드: VITE_SUITE=1 — 기준 경로 /alm/, 공통 틀(상단바·로그인·통행증)을 index.html에 넣는다. 없으면 지금과 같은 빌드
const suite = process.env.VITE_SUITE === '1';
const suiteShell = (): Plugin => ({
  name: 'alm-suite-shell',
  transformIndexHtml: (html) => !suite ? html : {
    html: html.replace('<html lang="en">', '<html lang="en" data-suite>'),
    tags: [
      { tag: 'script', attrs: { src: '/_suite/shell.js', 'data-product': 'alm' }, injectTo: 'head' },   // 모듈 스크립트보다 먼저 실행된다(window.suite)
      { tag: 'suite-bar', injectTo: 'body-prepend' },
    ],
  },
});

export default defineConfig({
  base: suite ? '/alm/' : '/',
  plugins: [react(), suiteShell()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  css: { modules: { localsConvention: 'camelCaseOnly' } },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test/setup.ts'], css: true },
});
