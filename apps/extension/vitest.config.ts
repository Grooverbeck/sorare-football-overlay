import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __EXTENSION_BROWSER__: JSON.stringify('chromium'),
  },
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: { url: 'https://sorare.com/football' },
    },
    include: ['src/tests/**/*.test.ts'],
    restoreMocks: true,
  },
});
