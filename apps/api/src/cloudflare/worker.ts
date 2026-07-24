import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createStatsRuntime } from '../service-factory.js';
import {
  CloudflareNameResolutionCache,
  CloudflarePlayerStatsCache,
} from './cache.js';
import { createWorkerLogger } from './logger.js';

const configKeys = [
  'PORT',
  'LOG_LEVEL',
  'MOCK_MODE',
  'EXCLUDE_LOW_COVERAGE',
  'CACHE_TTL_SECONDS',
  'PLAYER_FORM_CACHE_TTL_SECONDS',
  'FIXTURE_CACHE_TTL_SECONDS',
  'NAME_CACHE_TTL_SECONDS',
  'NAME_MISS_CACHE_TTL_SECONDS',
  'SORARE_BATCH_SIZE',
  'SORARE_REQUEST_TIMEOUT_MS',
  'SORARE_MAX_RETRIES',
  'SORARE_GRAPHQL_URL',
  'SORARE_API_KEY',
  'SORARE_AUTH_TOKEN',
  'SORARE_JWT_AUD',
  'CORS_ORIGINS',
] as const;

function stringBindings(env: CloudflareBindings): Record<string, string | undefined> {
  const bindings = env as unknown as Readonly<Record<string, unknown>>;
  return Object.fromEntries(
    configKeys.map((key) => {
      const value = bindings[key];
      return [key, typeof value === 'string' ? value : undefined];
    }),
  );
}

export default {
  async fetch(
    request: Request,
    env: CloudflareBindings,
    context: ExecutionContext,
  ): Promise<Response> {
    const config = loadConfig(stringBindings(env));
    const logger = createWorkerLogger(config.logLevel);
    const formTtlSeconds = Math.floor(config.playerFormCacheTtlMs / 1_000);
    const fixtureTtlSeconds = Math.floor(config.fixtureCacheTtlMs / 1_000);
    const nameTtlSeconds = Math.floor(config.nameCacheTtlMs / 1_000);
    const nameMissTtlSeconds = Math.floor(config.nameMissCacheTtlMs / 1_000);
    const runtime = createStatsRuntime({
      config,
      logger,
      statsCache: new CloudflarePlayerStatsCache(
        env.STATS_CACHE,
        formTtlSeconds,
        fixtureTtlSeconds,
        context,
      ),
      nameResolutionCache: new CloudflareNameResolutionCache(
        env.STATS_CACHE,
        nameTtlSeconds,
        nameMissTtlSeconds,
        context,
      ),
    });
    const app = createApp({
      statsService: runtime.statsService,
      logger,
      corsOrigins: config.corsOrigins,
    });

    return app.fetch(request);
  },
} satisfies ExportedHandler<CloudflareBindings>;
