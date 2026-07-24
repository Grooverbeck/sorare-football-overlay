import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: { url: 'https://sorare.com/football' },
    },
    include: ['src/tests/**/*.test.ts'],
    restoreMocks: true,
  },
});
