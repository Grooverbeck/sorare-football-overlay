import type { PlayerStats } from '@sorare-overlay/shared';
import type { Cache } from './cache.js';
import type { AppConfig } from './config.js';
import { SorareGraphqlClient } from './graphql/client.js';
import { SorareDataSource } from './graphql/sorare-data-source.js';
import type { AppLogger } from './logger.js';
import { MockDataSource } from './mock/mock-data-source.js';
import { HistoricalGoalscorerProvider } from './providers/goalscorer-provider.js';
import {
  CompetitionRoutedFixtureMatchOddsProvider,
  CompetitionRoutedPlayerMarketOddsProvider,
  createCompetitionRouteIndex,
} from './providers/competition-routed-provider.js';
import {
  InMemoryMarketSnapshotStore,
  MockPlayerMarketOddsProvider,
  TheOddsApiPlayerMarketOddsProvider,
  UnavailablePlayerMarketOddsProvider,
  type MarketSnapshotStore,
  type PlayerMarketField,
  type PlayerMarketOddsProvider,
} from './providers/market-odds-provider.js';
import {
  SportsGameOddsFixtureMatchOddsProvider,
  SportsGameOddsPlayerMarketOddsProvider,
  SupplementingPlayerMarketOddsProvider,
} from './providers/sports-game-odds-provider.js';
import {
  InMemoryProviderQuotaUsageStore,
  type ProviderQuotaUsageStore,
} from './providers/odds-usage.js';
import {
  OddsApiIoFixtureMatchOddsProvider,
  OddsApiIoPlayerMarketOddsProvider,
} from './providers/odds-api-io-provider.js';
import {
  InMemoryMatchOddsSnapshotStore,
  SupplementingFixtureMatchOddsProvider,
  TheOddsApiFixtureMatchOddsProvider,
  UnavailableFixtureMatchOddsProvider,
  type FixtureMatchOddsProvider,
  type MatchOddsSnapshotStore,
} from './providers/match-odds-provider.js';
import {
  EUROPEAN_THE_ODDS_API_MATCH_ROUTES,
  EUROPEAN_THE_ODDS_API_PLAYER_ROUTES,
  LEAGUES_CUP_THE_ODDS_API_ROUTES,
  ODDS_API_IO_ROUTES,
  SPORTS_GAME_ODDS_ROUTES,
} from './providers/competition-odds-routes.js';
import type {
  PlayerNameResolutionCache,
  PlayerStatsDataSource,
} from './services/data-source.js';
import {
  DEFAULT_NAME_RESOLUTION_BUDGET_MS,
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
  fixtureMatchOddsProvider: FixtureMatchOddsProvider;
  dataSource: PlayerStatsDataSource;
  source: 'sorare' | 'mock';
}

interface TheOddsPlayerProviderPlan {
  competitionSlugs: readonly string[];
  sportKeys: readonly string[] | null;
  region?: string;
  fallbackRegion?: string | null;
  markets?: readonly PlayerMarketField[];
  fetchWindowMs?: number;
  refreshUsage: boolean;
}

const THE_ODDS_PLAYER_PROVIDER_PLANS: readonly TheOddsPlayerProviderPlan[] = [
  {
    competitionSlugs: ['mlspa'],
    sportKeys: null,
    refreshUsage: true,
  },
  ...LEAGUES_CUP_THE_ODDS_API_ROUTES.map((route) => ({
    competitionSlugs: route.competitionSlugs,
    sportKeys: route.sportKeys,
    region: route.region,
    fallbackRegion: route.fallbackRegion,
    refreshUsage: false,
  })),
  {
    competitionSlugs: ['uefa-champions-league'],
    sportKeys: [
      'soccer_uefa_champs_league_qualification',
      'soccer_uefa_champs_league',
    ],
    region: 'eu',
    fallbackRegion: 'uk',
    refreshUsage: false,
  },
  {
    competitionSlugs: ['uefa-europa-league'],
    sportKeys: ['soccer_uefa_europa_league'],
    region: 'eu',
    fallbackRegion: 'uk',
    refreshUsage: false,
  },
  {
    competitionSlugs: ['uefa-europa-conference-league'],
    sportKeys: ['soccer_uefa_europa_conference_league'],
    region: 'eu',
    fallbackRegion: 'uk',
    refreshUsage: false,
  },
  ...EUROPEAN_THE_ODDS_API_PLAYER_ROUTES.map((route) => ({
    competitionSlugs: route.competitionSlugs,
    sportKeys: route.sportKeys,
    region: route.region,
    fallbackRegion: route.fallbackRegion,
    markets: route.markets,
    fetchWindowMs: route.fetchWindowMs,
    refreshUsage: false,
  })),
];

const THE_ODDS_PLAYER_ROUTE_INDEX = createCompetitionRouteIndex(
  THE_ODDS_PLAYER_PROVIDER_PLANS.map(({ competitionSlugs }) => competitionSlugs),
);
const SPORTS_GAME_ODDS_ROUTE_INDEX = createCompetitionRouteIndex(
  SPORTS_GAME_ODDS_ROUTES.map(({ competitionSlugs }) => competitionSlugs),
);

function supplementFixtureMatchOddsProviders(
  providers: readonly FixtureMatchOddsProvider[],
): FixtureMatchOddsProvider {
  const [first, ...rest] = providers;
  if (!first) return new UnavailableFixtureMatchOddsProvider();
  return rest.reduce<FixtureMatchOddsProvider>(
    (primary, fallback) =>
      new SupplementingFixtureMatchOddsProvider(primary, fallback),
    first,
  );
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
    const matchOddsSnapshotStore =
      options.matchOddsSnapshotStore ??
      new InMemoryMatchOddsSnapshotStore();
    const createTheOddsProvider = (
      sportKey: string,
      supportedCompetitionSlugs: readonly string[],
      providerOptions: {
        additionalSportKeys?: readonly string[];
        region?: string;
        fallbackRegion?: string | null;
        markets?: readonly PlayerMarketField[];
        fetchWindowMs?: number;
        refreshUsage?: boolean;
      } = {},
    ) => {
      const fallbackRegion =
        providerOptions.fallbackRegion === undefined
          ? config.oddsApiFallbackRegion
          : providerOptions.fallbackRegion;
      return new TheOddsApiPlayerMarketOddsProvider({
        apiKey: config.oddsApiKey!,
        baseUrl: config.oddsApiBaseUrl,
        sportKey,
        ...(providerOptions.additionalSportKeys
          ? { additionalSportKeys: providerOptions.additionalSportKeys }
          : {}),
        region: providerOptions.region ?? config.oddsApiRegion,
        ...(fallbackRegion
          ? {
              fallbackRegion,
            }
          : {}),
        fetchWindowMs:
          providerOptions.fetchWindowMs ?? config.oddsFetchWindowMs,
        requestTimeoutMs: config.requestTimeoutMs,
        maxRetries: config.maxRetries,
        store: marketSnapshotStore,
        logger,
        usageStore: providerQuotaUsageStore,
        refreshUsage: providerOptions.refreshUsage ?? true,
        supportedCompetitionSlugs,
        ...(providerOptions.markets
          ? { supportedMarkets: providerOptions.markets }
          : {}),
        // Player cards arrive progressively from the extension. A short
        // distributed batching window lets one full-fixture market response
        // satisfy the whole visible cohort instead of refreshing per card.
        supplementBatchDelayMs: 1_500,
        supplementBatchTtlMs: 15 * 60 * 1_000,
        refreshLeaseTtlMs: 90 * 1_000,
      });
    };
    const theOddsSources = config.oddsApiKey
      ? THE_ODDS_PLAYER_PROVIDER_PLANS.map((plan) => {
          const sportKeys = plan.sportKeys ?? [config.oddsApiSportKey];
          return createTheOddsProvider(
            sportKeys[0]!,
            plan.competitionSlugs,
            {
              ...(sportKeys.length > 1
                ? { additionalSportKeys: sportKeys.slice(1) }
                : {}),
              ...(plan.region ? { region: plan.region } : {}),
              ...(plan.fallbackRegion !== undefined
                ? { fallbackRegion: plan.fallbackRegion }
                : {}),
              ...(plan.markets ? { markets: plan.markets } : {}),
              ...(plan.fetchWindowMs !== undefined
                ? { fetchWindowMs: plan.fetchWindowMs }
                : {}),
              refreshUsage: plan.refreshUsage,
            },
          );
        })
      : [];
    const theOddsProvider =
      theOddsSources.length > 0
        ? new CompetitionRoutedPlayerMarketOddsProvider(
            theOddsSources,
            THE_ODDS_PLAYER_ROUTE_INDEX,
          )
        : new UnavailablePlayerMarketOddsProvider();
    const sportsGameOddsSources = config.sportsGameOddsApiKey
      ? SPORTS_GAME_ODDS_ROUTES.map(
          (route, index) =>
            new SportsGameOddsPlayerMarketOddsProvider({
              apiKey: config.sportsGameOddsApiKey!,
              baseUrl: config.sportsGameOddsBaseUrl,
              leagueId: route.competitionSlugs.includes('mlspa')
                ? config.sportsGameOddsLeagueId
                : route.leagueId,
              fetchWindowMs:
                route.playerFetchWindowMs ?? config.oddsFetchWindowMs,
              matchOddsFetchWindowMs:
                route.matchOddsFetchWindowMs ??
                config.matchOddsFallbackWindowMs,
              matchOddsMissTtlMs: config.matchOddsMissCacheTtlMs,
              requestTimeoutMs: config.requestTimeoutMs,
              maxRetries: config.maxRetries,
              store: marketSnapshotStore,
              ...(route.matchOdds
                ? { matchOddsStore: matchOddsSnapshotStore }
                : {}),
              logger,
              usageStore: providerQuotaUsageStore,
              refreshUsage: index === 0,
              supportedCompetitionSlugs: route.competitionSlugs,
              supportedMarkets: route.playerMarkets,
            }),
        )
      : [];
    const sportsGameOddsProvider =
      sportsGameOddsSources.length > 0
        ? new CompetitionRoutedPlayerMarketOddsProvider(
            sportsGameOddsSources,
            SPORTS_GAME_ODDS_ROUTE_INDEX,
          )
        : new UnavailablePlayerMarketOddsProvider();
    const configuredMarketOddsProvider = config.sportsGameOddsApiKey
      ? new SupplementingPlayerMarketOddsProvider(
          sportsGameOddsProvider,
          theOddsProvider,
        )
      : theOddsProvider;
    const oddsApiIoProvider = config.oddsApiIoKey
      ? new OddsApiIoPlayerMarketOddsProvider({
          apiKey: config.oddsApiIoKey,
          baseUrl: config.oddsApiIoBaseUrl,
          bookmakers: config.oddsApiIoBookmakers,
          routes: ODDS_API_IO_ROUTES.map((route) =>
            route.competitionSlugs.some(
              (slug) => slug === 'austrian-bundesliga',
            )
              ? {
                  ...route,
                  leagueSlugs: [config.oddsApiIoLeague],
                }
              : route,
          ),
          fetchWindowMs: config.oddsFetchWindowMs,
          matchOddsFallbackWindowMs: config.matchOddsFallbackWindowMs,
          matchOddsMissTtlMs: config.matchOddsMissCacheTtlMs,
          dailyRequestLimit: config.oddsApiIoDailyRequestLimit,
          hourlyRequestLimit: config.oddsApiIoHourlyRequestLimit,
          requestTimeoutMs: config.requestTimeoutMs,
          maxRetries: config.maxRetries,
          store: marketSnapshotStore,
          matchOddsStore: matchOddsSnapshotStore,
          logger,
          usageStore: providerQuotaUsageStore,
        })
      : null;
    marketOddsProvider = oddsApiIoProvider
      ? new SupplementingPlayerMarketOddsProvider(
          configuredMarketOddsProvider,
          oddsApiIoProvider,
          ['goal', 'assist', 'decisive'],
          undefined,
          ['goal'],
        )
      : configuredMarketOddsProvider;
    const theOddsMatchProvider = config.oddsApiKey
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
            ...LEAGUES_CUP_THE_ODDS_API_ROUTES,
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
            ...EUROPEAN_THE_ODDS_API_MATCH_ROUTES,
          ],
          fallbackWindowMs: config.matchOddsFallbackWindowMs,
          missTtlMs: config.matchOddsMissCacheTtlMs,
          requestTimeoutMs: config.requestTimeoutMs,
          maxRetries: config.maxRetries,
          store: matchOddsSnapshotStore,
          logger,
          usageStore: providerQuotaUsageStore,
        })
      : new UnavailableFixtureMatchOddsProvider();
    const oddsApiIoMatchProvider = oddsApiIoProvider
      ? new OddsApiIoFixtureMatchOddsProvider(oddsApiIoProvider)
      : new UnavailableFixtureMatchOddsProvider();
    const sportsGameOddsMatchSources = sportsGameOddsSources.map(
      (source) => new SportsGameOddsFixtureMatchOddsProvider(source),
    );
    const sportsGameOddsMatchProvider =
      sportsGameOddsMatchSources.length > 0
        ? new CompetitionRoutedFixtureMatchOddsProvider(
            sportsGameOddsMatchSources,
            SPORTS_GAME_ODDS_ROUTE_INDEX,
          )
        : new UnavailableFixtureMatchOddsProvider();
    fixtureMatchOddsProvider = supplementFixtureMatchOddsProviders([
      sportsGameOddsMatchProvider,
      theOddsMatchProvider,
      oddsApiIoMatchProvider,
    ]);
  }

  return {
    statsService: new StatsService(
      dataSource,
      new HistoricalGoalscorerProvider(),
      options.statsCache,
      config.excludeLowCoverage,
      marketOddsProvider,
      options.scheduleBackground,
      DEFAULT_NAME_RESOLUTION_BUDGET_MS,
      fixtureMatchOddsProvider,
    ),
    marketOddsProvider,
    fixtureMatchOddsProvider,
    dataSource,
    source: dataSource.source,
  };
}
