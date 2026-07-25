import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { SorareGraphqlClient } from '../graphql/client.js';
import { createStatsRuntime } from '../service-factory.js';
import { MlsMarketPrewarmer } from '../services/mls-market-prewarmer.js';
import {
  CloudflareMarketSnapshotStore,
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
  'THE_ODDS_API_KEY',
  'ODDS_API_BASE_URL',
  'ODDS_API_SPORT_KEY',
  'ODDS_API_REGION',
  'ODDS_API_FALLBACK_REGION',
  'ODDS_FETCH_WINDOW_HOURS',
  'ODDS_MISS_CACHE_TTL_SECONDS',
  'SPORTS_GAME_ODDS_API_KEY',
  'SPORTS_GAME_ODDS_BASE_URL',
  'SPORTS_GAME_ODDS_LEAGUE_ID',
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

function createWorkerServices(
  env: CloudflareBindings,
  context: ExecutionContext,
) {
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
    marketSnapshotStore: new CloudflareMarketSnapshotStore(
      env.STATS_CACHE,
      Math.floor(config.oddsMissCacheTtlMs / 1_000),
      context,
    ),
    scheduleBackground: (task) => {
      context.waitUntil(
        task.catch((error: unknown) => {
          logger.warn(
            {
              error:
                error instanceof Error ? error.message : String(error),
            },
            'Background stats refresh failed',
          );
        }),
      );
    },
  });
  return { config, logger, runtime };
}

export default {
  async fetch(
    request: Request,
    env: CloudflareBindings,
    context: ExecutionContext,
  ): Promise<Response> {
    const { config, logger, runtime } = createWorkerServices(env, context);
    const app = createApp({
      statsService: runtime.statsService,
      logger,
      corsOrigins: config.corsOrigins,
    });

    return app.fetch(request);
  },

  scheduled(
    controller: ScheduledController,
    env: CloudflareBindings,
    context: ExecutionContext,
  ): void {
    const { config, logger, runtime } = createWorkerServices(env, context);
    const client = new SorareGraphqlClient({
      url: config.graphqlUrl,
      requestTimeoutMs: config.requestTimeoutMs,
      maxRetries: config.maxRetries,
      logger,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.authToken ? { authToken: config.authToken } : {}),
      ...(config.jwtAud ? { jwtAud: config.jwtAud } : {}),
    });
    const prewarmer = new MlsMarketPrewarmer({
      client,
      marketOddsProvider: runtime.marketOddsProvider,
      logger,
      windowMs: config.oddsFetchWindowMs,
    });
    context.waitUntil(
      prewarmer.run().catch((error: unknown) => {
        logger.error(
          {
            cron: controller.cron,
            error: error instanceof Error ? error.message : String(error),
          },
          'MLS market prewarm failed',
        );
      }),
    );
  },
} satisfies ExportedHandler<CloudflareBindings>;
