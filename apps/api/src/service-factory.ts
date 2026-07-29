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
import {
  InMemoryMatchOddsSnapshotStore,
  TheOddsApiFixtureMatchOddsProvider,
  UnavailableFixtureMatchOddsProvider,
  type FixtureMatchOddsProvider,
  type MatchOddsSnapshotStore,
} from './providers/match-odds-provider.js';
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
  matchOddsSnapshotStore?: MatchOddsSnapshotStore;
  providerQuotaUsageStore?: ProviderQuotaUsageStore;
  scheduleBackground?: BackgroundTaskScheduler;
}

export interface StatsRuntime {
  statsService: StatsService;
  marketOddsProvider: PlayerMarketOddsProvider;
  dataSource: PlayerStatsDataSource;
  source: 'sorare' | 'mock';
}

export function createStatsRuntime(options: CreateStatsRuntimeOptions): StatsRuntime {
  const { config, logger } = options;
  let dataSource: PlayerStatsDataSource;
  let marketOddsProvider: PlayerMarketOddsProvider;
  let fixtureMatchOddsProvider: FixtureMatchOddsProvider;

  if (config.mockMode) {
    dataSource = new MockDataSource();
    marketOddsProvider = new MockPlayerMarketOddsProvider();
    fixtureMatchOddsProvider = new UnavailableFixtureMatchOddsProvider();
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
    const marketSnapshotStore =
      options.marketSnapshotStore ??
      new InMemoryMarketSnapshotStore(config.oddsMissCacheTtlMs);
    const createTheOddsProvider = (
      sportKey: string,
      supportedCompetitionSlugs: readonly string[],
      providerOptions: {
        additionalSportKeys?: readonly string[];
        region?: string;
        fallbackRegion?: string;
        refreshUsage?: boolean;
      } = {},
    ) =>
      new TheOddsApiPlayerMarketOddsProvider({
        apiKey: config.oddsApiKey!,
        baseUrl: config.oddsApiBaseUrl,
        sportKey,
        ...(providerOptions.additionalSportKeys
          ? { additionalSportKeys: providerOptions.additionalSportKeys }
          : {}),
        region: providerOptions.region ?? config.oddsApiRegion,
        ...((providerOptions.fallbackRegion ??
        config.oddsApiFallbackRegion)
          ? {
              fallbackRegion:
                providerOptions.fallbackRegion ??
                config.oddsApiFallbackRegion!,
            }
          : {}),
        fetchWindowMs: config.oddsFetchWindowMs,
        requestTimeoutMs: config.requestTimeoutMs,
        maxRetries: config.maxRetries,
        store: marketSnapshotStore,
        logger,
        usageStore: providerQuotaUsageStore,
        refreshUsage: providerOptions.refreshUsage ?? true,
        supportedCompetitionSlugs,
      });
    const theOddsProvider = config.oddsApiKey
      ? new SupplementingPlayerMarketOddsProvider(
          createTheOddsProvider(config.oddsApiSportKey, ['mlspa']),
          new SupplementingPlayerMarketOddsProvider(
            createTheOddsProvider(
              'soccer_uefa_champs_league_qualification',
              ['uefa-champions-league'],
              {
                additionalSportKeys: ['soccer_uefa_champs_league'],
                region: 'eu',
                fallbackRegion: 'uk',
                refreshUsage: false,
              },
            ),
            new SupplementingPlayerMarketOddsProvider(
              createTheOddsProvider(
                'soccer_uefa_europa_league',
                ['uefa-europa-league'],
                {
                  region: 'eu',
                  fallbackRegion: 'uk',
                  refreshUsage: false,
                },
              ),
              createTheOddsProvider(
                'soccer_uefa_europa_conference_league',
                ['uefa-europa-conference-league'],
                {
                  region: 'eu',
                  fallbackRegion: 'uk',
                  refreshUsage: false,
                },
              ),
            ),
          ),
        )
      : new UnavailablePlayerMarketOddsProvider();
    const createSportsGameOddsProvider = (
      leagueId: string,
      supportedCompetitionSlugs: readonly string[],
      refreshUsage: boolean,
    ) =>
      new SportsGameOddsPlayerMarketOddsProvider({
        apiKey: config.sportsGameOddsApiKey!,
        baseUrl: config.sportsGameOddsBaseUrl,
        leagueId,
        fetchWindowMs: config.oddsFetchWindowMs,
        requestTimeoutMs: config.requestTimeoutMs,
        maxRetries: config.maxRetries,
        store: marketSnapshotStore,
        logger,
        usageStore: providerQuotaUsageStore,
        refreshUsage,
        supportedCompetitionSlugs,
      });
    const sportsGameOddsProvider = config.sportsGameOddsApiKey
      ? new SupplementingPlayerMarketOddsProvider(
          createSportsGameOddsProvider(
            config.sportsGameOddsLeagueId,
            ['mlspa'],
            true,
          ),
          new SupplementingPlayerMarketOddsProvider(
            createSportsGameOddsProvider(
              'UEFA_CHAMPIONS_LEAGUE',
              ['uefa-champions-league'],
              false,
            ),
            createSportsGameOddsProvider(
              'UEFA_EUROPA_LEAGUE',
              ['uefa-europa-league'],
              false,
            ),
          ),
        )
      : new UnavailablePlayerMarketOddsProvider();
    marketOddsProvider = config.sportsGameOddsApiKey
      ? new SupplementingPlayerMarketOddsProvider(
          sportsGameOddsProvider,
          theOddsProvider,
        )
      : theOddsProvider;
    fixtureMatchOddsProvider = config.oddsApiKey
      ? new TheOddsApiFixtureMatchOddsProvider({
          apiKey: config.oddsApiKey,
          baseUrl: config.oddsApiBaseUrl,
          routes: [
            {
              sportKeys: [config.oddsApiSportKey],
              competitionSlugs: ['mlspa'],
              region: config.oddsApiRegion,
              ...(config.oddsApiFallbackRegion
                ? { fallbackRegion: config.oddsApiFallbackRegion }
                : {}),
            },
            {
              sportKeys: [
                'soccer_uefa_champs_league_qualification',
                'soccer_uefa_champs_league',
              ],
              competitionSlugs: ['uefa-champions-league'],
              region: 'eu',
              fallbackRegion: 'uk',
            },
            {
              sportKeys: ['soccer_uefa_europa_league'],
              competitionSlugs: ['uefa-europa-league'],
              region: 'eu',
              fallbackRegion: 'uk',
            },
            {
              sportKeys: ['soccer_uefa_europa_conference_league'],
              competitionSlugs: ['uefa-europa-conference-league'],
              region: 'eu',
              fallbackRegion: 'uk',
            },
          ],
          fallbackWindowMs: config.matchOddsFallbackWindowMs,
          missTtlMs: config.oddsMissCacheTtlMs,
          requestTimeoutMs: config.requestTimeoutMs,
          maxRetries: config.maxRetries,
          store:
            options.matchOddsSnapshotStore ??
            new InMemoryMatchOddsSnapshotStore(),
          logger,
          usageStore: providerQuotaUsageStore,
        })
      : new UnavailableFixtureMatchOddsProvider();
  }

  return {
    statsService: new StatsService(
      dataSource,
      new HistoricalGoalscorerProvider(),
      options.statsCache,
      config.excludeLowCoverage,
      marketOddsProvider,
      options.scheduleBackground,
      3_000,
      fixtureMatchOddsProvider,
    ),
    marketOddsProvider,
    dataSource,
    source: dataSource.source,
  };
}
