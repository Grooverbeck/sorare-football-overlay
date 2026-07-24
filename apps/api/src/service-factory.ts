import type { PlayerStats } from '@sorare-overlay/shared';
import type { Cache } from './cache.js';
import type { AppConfig } from './config.js';
import { SorareGraphqlClient } from './graphql/client.js';
import { SorareDataSource } from './graphql/sorare-data-source.js';
import type { AppLogger } from './logger.js';
import { MockDataSource } from './mock/mock-data-source.js';
import { HistoricalGoalscorerProvider } from './providers/goalscorer-provider.js';
import type {
  PlayerNameResolutionCache,
  PlayerStatsDataSource,
} from './services/data-source.js';
import { StatsService } from './services/stats-service.js';

export interface CreateStatsRuntimeOptions {
  config: AppConfig;
  logger: AppLogger;
  statsCache: Cache<PlayerStats>;
  nameResolutionCache?: PlayerNameResolutionCache;
}

export interface StatsRuntime {
  statsService: StatsService;
  source: 'sorare' | 'mock';
}

export function createStatsRuntime(options: CreateStatsRuntimeOptions): StatsRuntime {
  const { config, logger } = options;
  let dataSource: PlayerStatsDataSource;

  if (config.mockMode) {
    dataSource = new MockDataSource();
  } else {
    const client = new SorareGraphqlClient({
      url: config.graphqlUrl,
      requestTimeoutMs: config.requestTimeoutMs,
      maxRetries: config.maxRetries,
      logger,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.authToken ? { authToken: config.authToken } : {}),
      ...(config.jwtAud ? { jwtAud: config.jwtAud } : {}),
    });
    dataSource = new SorareDataSource(
      client,
      config.sorareBatchSize,
      Boolean(config.apiKey),
      config.nameMissCacheTtlMs,
      config.excludeLowCoverage,
      options.nameResolutionCache,
    );
  }

  return {
    statsService: new StatsService(
      dataSource,
      new HistoricalGoalscorerProvider(),
      options.statsCache,
      config.excludeLowCoverage,
    ),
    source: dataSource.source,
  };
}
