import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    pool: '@cloudflare/vitest-pool-workers',
    include: ['src/tests/**/*.worker-test.ts'],
    poolOptions: {
      workers: {
        main: './src/cloudflare/worker.ts',
        wrangler: {
          configPath: './wrangler.jsonc',
        },
        miniflare: {
          bindings: {
            LOG_LEVEL: 'silent',
            MOCK_MODE: 'true',
            THE_ODDS_API_KEY: 'test-key',
            SPORTS_GAME_ODDS_API_KEY: 'test-sgo-key',
          },
        },
      },
    },
  },
});
