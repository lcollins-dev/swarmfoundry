import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

import { iconsPlugin } from './icons.config';

export default defineConfig({
  plugins: [vue(), iconsPlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    globals: false,
    testTimeout: 15_000,
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
  },
});
