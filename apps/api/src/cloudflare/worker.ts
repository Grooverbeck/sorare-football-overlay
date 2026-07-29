import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { SorareGraphqlClient } from '../graphql/client.js';
import { createStatsRuntime } from '../service-factory.js';
import { MlsMarketPrewarmer } from '../services/mls-market-prewarmer.js';
import { MlsAaBenchmarkRefresher } from '../services/mls-aa-benchmark.js';
import {
  CloudflareMarketSnapshotStore,
  CloudflareMatchOddsSnapshotStore,
  CloudflareMlsAaBenchmarkStore,
  CloudflareNameResolutionCache,
  CloudflarePlayerStatsCache,
  CloudflareProviderQuotaUsageStore,
} from './cache.js';
import { D1JsonKeyValueStore } from './d1-cache.js';
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
  'MATCH_ODDS_FALLBACK_WINDOW_HOURS',
  'ODDS_MISS_CACHE_TTL_SECONDS',
  'SPORTS_GAME_ODDS_API_KEY',
  'SPORTS_GAME_ODDS_BASE_URL',
  'SPORTS_GAME_ODDS_LEAGUE_ID',
  'CORS_ORIGINS',
] as const;

const WEEKLY_MLS_AA_CRON = '0 10 * * MON';
const DAILY_MARKET_PREWARM_CRON = '0 5 * * *';

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
  const cacheStore = new D1JsonKeyValueStore(
    env.CACHE_DB,
    env.STATS_CACHE,
  );
  const mlsAaBenchmarkStore = new CloudflareMlsAaBenchmarkStore(
    cacheStore,
  );
  const runtime = createStatsRuntime({
    config,
    logger,
    statsCache: new CloudflarePlayerStatsCache(
      cacheStore,
      formTtlSeconds,
      fixtureTtlSeconds,
      context,
    ),
    nameResolutionCache: new CloudflareNameResolutionCache(
      cacheStore,
      nameTtlSeconds,
      nameMissTtlSeconds,
      context,
    ),
    marketSnapshotStore: new CloudflareMarketSnapshotStore(
      cacheStore,
      Math.floor(config.oddsMissCacheTtlMs / 1_000),
      context,
    ),
    matchOddsSnapshotStore: new CloudflareMatchOddsSnapshotStore(cacheStore),
    providerQuotaUsageStore: new CloudflareProviderQuotaUsageStore(
      cacheStore,
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
  return { config, logger, runtime, mlsAaBenchmarkStore };
}

export default {
  async fetch(
    request: Request,
    env: CloudflareBindings,
    context: ExecutionContext,
  ): Promise<Response> {
    const { config, logger, runtime, mlsAaBenchmarkStore } =
      createWorkerServices(env, context);
    const app = createApp({
      statsService: runtime.statsService,
      logger,
      corsOrigins: config.corsOrigins,
      mlsAaBenchmarkStore,
    });

    return app.fetch(request);
  },

  scheduled(
    controller: ScheduledController,
    env: CloudflareBindings,
    context: ExecutionContext,
  ): void {
    const { config, logger, runtime, mlsAaBenchmarkStore } =
      createWorkerServices(env, context);
    const client = new SorareGraphqlClient({
      url: config.graphqlUrl,
      requestTimeoutMs: config.requestTimeoutMs,
      maxRetries: config.maxRetries,
      logger,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.authToken ? { authToken: config.authToken } : {}),
      ...(config.jwtAud ? { jwtAud: config.jwtAud } : {}),
    });
    if (controller.cron === WEEKLY_MLS_AA_CRON) {
      const refresher = new MlsAaBenchmarkRefresher({
        client,
        store: mlsAaBenchmarkStore,
        logger,
      });
      context.waitUntil(
        refresher.run().catch((error: unknown) => {
          logger.error(
            {
              cron: controller.cron,
              error: error instanceof Error ? error.message : String(error),
            },
            'Weekly MLS AA benchmark refresh failed; keeping previous snapshot',
          );
        }),
      );
      return;
    }
    if (controller.cron !== DAILY_MARKET_PREWARM_CRON) {
      logger.warn(
        { cron: controller.cron },
        'Ignoring unknown scheduled trigger',
      );
      return;
    }
    const prewarmer = new MlsMarketPrewarmer({
      client,
      marketOddsProvider: runtime.marketOddsProvider,
      logger,
      windowMs: config.oddsFetchWindowMs,
    });
    context.waitUntil((async () => {
      try {
        const usages =
          (await runtime.marketOddsProvider.refreshUsage?.()) ?? [];
        for (const usage of usages) {
          logger.info(
            {
              provider: usage.provider,
              unit: usage.unit,
              used: usage.used,
              limit: usage.limit,
              remaining: usage.remaining,
              usagePercent:
                Math.round((usage.used / usage.limit) * 1_000) / 10,
              interval: usage.interval.unit,
              intervalStartsAt: usage.interval.startsAt,
              intervalEndsAt: usage.interval.endsAt,
            },
            'Bookmaker quota usage refreshed',
          );
        }
      } catch (error) {
        logger.warn(
          {
            cron: controller.cron,
            error: error instanceof Error ? error.message : String(error),
          },
          'Bookmaker quota usage refresh failed; keeping last known protection state',
        );
      }

      try {
        await prewarmer.run();
      } catch (error) {
        logger.error(
          {
            cron: controller.cron,
            error: error instanceof Error ? error.message : String(error),
          },
          'MLS market prewarm failed',
        );
      }
    })());
  },
} satisfies ExportedHandler<CloudflareBindings>;
