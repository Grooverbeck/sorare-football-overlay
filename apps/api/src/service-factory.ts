import type { PlayerStats } from '@sorare-overlay/shared';
import type { Cache } from './cache.js';
import type { AppConfig } from './config.js';
import { SorareGraphqlClient } from './graphql/client.js';
import { SorareDataSource } from './graphql/sorare-data-source.js';
import type { AppLogger } from './logger.js';
import { MockDataSource } from './mock/mock-data-source.js';
import { HistoricalGoalscorerProvider } from './providers/goalscorer-provider.js';
import {
  InMemoryMarketSnapshotStore,
  MockPlayerMarketOddsProvider,
  TheOddsApiPlayerMarketOddsProvider,
  UnavailablePlayerMarketOddsProvider,
  type MarketSnapshotStore,
  type PlayerMarketOddsProvider,
} from './providers/market-odds-provider.js';
import {
  SportsGameOddsPlayerMarketOddsProvider,
  SupplementingPlayerMarketOddsProvider,
} from './providers/sports-game-odds-provider.js';
import {
  InMemoryProviderQuotaUsageStore,
  type ProviderQuotaUsageStore,
} from './providers/odds-usage.js';
import type {
  PlayerNameResolutionCache,
  PlayerStatsDataSource,
} from './services/data-source.js';
import {
  StatsService,
  type BackgroundTaskScheduler,
} from './services/stats-service.js';

export interface CreateStatsRuntimeOptions {
  config: AppConfig;
  logger: AppLogger;
  statsCache: Cache<PlayerStats>;
  nameResolutionCache?: PlayerNameResolutionCache;
  marketSnapshotStore?: MarketSnapshotStore;
  providerQuotaUsageStore?: ProviderQuotaUsageStore;
  scheduleBackground?: BackgroundTaskScheduler;
}

export interface StatsRuntime {
  statsService: StatsService;
  marketOddsProvider: PlayerMarketOddsProvider;
  source: 'sorare' | 'mock';
}

export function createStatsRuntime(options: CreateStatsRuntimeOptions): StatsRuntime {
  const { config, logger } = options;
  let dataSource: PlayerStatsDataSource;
  let marketOddsProvider: PlayerMarketOddsProvider;

  if (config.mockMode) {
    dataSource = new MockDataSource();
    marketOddsProvider = new MockPlayerMarketOddsProvider();
  } else {
    const providerQuotaUsageStore =
      options.providerQuotaUsageStore ??
      new InMemoryProviderQuotaUsageStore();
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
    const theOddsProvider = config.oddsApiKey
      ? new TheOddsApiPlayerMarketOddsProvider({
          apiKey: config.oddsApiKey,
          baseUrl: config.oddsApiBaseUrl,
          sportKey: config.oddsApiSportKey,
          region: config.oddsApiRegion,
          ...(config.oddsApiFallbackRegion
            ? { fallbackRegion: config.oddsApiFallbackRegion }
            : {}),
          fetchWindowMs: config.oddsFetchWindowMs,
          requestTimeoutMs: config.requestTimeoutMs,
          maxRetries: config.maxRetries,
          store:
            options.marketSnapshotStore ??
            new InMemoryMarketSnapshotStore(config.oddsMissCacheTtlMs),
          logger,
          usageStore: providerQuotaUsageStore,
          supportedCompetitionSlugs: ['mlspa'],
        })
      : new UnavailablePlayerMarketOddsProvider();
    marketOddsProvider = config.sportsGameOddsApiKey
      ? new SupplementingPlayerMarketOddsProvider(
          new SportsGameOddsPlayerMarketOddsProvider({
            apiKey: config.sportsGameOddsApiKey,
            baseUrl: config.sportsGameOddsBaseUrl,
            leagueId: config.sportsGameOddsLeagueId,
            fetchWindowMs: config.oddsFetchWindowMs,
            requestTimeoutMs: config.requestTimeoutMs,
            maxRetries: config.maxRetries,
            store:
              options.marketSnapshotStore ??
              new InMemoryMarketSnapshotStore(config.oddsMissCacheTtlMs),
            logger,
            usageStore: providerQuotaUsageStore,
            supportedCompetitionSlugs: ['mlspa'],
          }),
          theOddsProvider,
        )
      : theOddsProvider;
  }

  return {
    statsService: new StatsService(
      dataSource,
      new HistoricalGoalscorerProvider(),
      options.statsCache,
      config.excludeLowCoverage,
      marketOddsProvider,
      options.scheduleBackground,
    ),
    marketOddsProvider,
    source: dataSource.source,
  };
}
