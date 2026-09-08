import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { checkWorkerCompatibility } from './scripts/check-worker-compatibility.mjs';

checkWorkerCompatibility();

export default defineConfig({
  plugins: [cloudflareTest({
    main: './src/cloudflare/worker.ts',
    wrangler: {configPath: './wrangler.jsonc'},
    miniflare: {bindings: {
      LOG_LEVEL: 'silent', MOCK_MODE: 'true',
      THE_ODDS_API_KEY: 'test-key', SPORTS_GAME_ODDS_API_KEY: 'test-sgo-key',
    }},
  })],
  test: {
    include: ['src/tests/**/*.worker-test.ts'],
  },
});
