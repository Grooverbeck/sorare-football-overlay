import {
  PlayerMarketSnapshotsRequestSchema,
  PlayerStatsRequestSchema,
  type FootballPosition,
  type MatchProbabilities,
  type PlayerMarketOdds,
  type PlayerStats,
} from '@sorare-overlay/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  SplitPlayerStatsCache,
  TtlCache,
  type Cache,
  type PlayerFixtureStats,
  type PlayerFormStats,
} from '../cache.js';
import { MockDataSource } from '../mock/mock-data-source.js';
import { HistoricalGoalscorerProvider } from '../providers/goalscorer-provider.js';
import {
  MockPlayerMarketOddsProvider,
  UnavailablePlayerMarketOddsProvider,
  playerMarketOddsKey,
  type PlayerMarketOddsProvider,
} from '../providers/market-odds-provider.js';
import {
  UnavailableFixtureMatchOddsProvider,
  type FixtureMatchOddsProvider,
} from '../providers/match-odds-provider.js';
import type {
  PlayerNameResolutionOptions,
  PlayerStatsDataSource,
  SourcePlayerRequest,
} from '../services/data-source.js';
import {
  DEFAULT_NAME_RESOLUTION_BUDGET_MS,
  StatsService,
} from '../services/stats-service.js';

describe('StatsService market snapshot reads', () => {
  it('returns batched cache state without scheduling provider work', async () => {
    const load = vi.fn<PlayerMarketOddsProvider['load']>(
      async (players, options) => {
        expect(options?.cacheOnly).toBe(true);
        expect(options?.cacheOnlyDeadlineMs).toBeTypeOf('number');
        if (options?.refreshDueState) options.refreshDueState.complete = true;
        const pending = players.find(({ slug }) => slug === 'pending-player');
        if (pending) {
          options?.refreshDuePlayerKeys?.add(playerMarketOddsKey(pending));
        }
        return new Map(
          players.map((player) => [
            playerMarketOddsKey(player),
            player.slug === 'settled-player'
              ? {
                  source: 'odds-api-io' as const,
                  capturedAt: '2026-08-28T08:00:00.000Z',
                  goal: { probability: 0.31, bookmakerCount: 2 },
                  assist: null,
                  decisive: null,
                }
              : null,
          ]),
        );
      },
    );
    const provider: PlayerMarketOddsProvider = {
      reportsRefreshDue: true,
      supports: (player) => player.position !== 'Goalkeeper',
      supportsMarket: (player) => player.position !== 'Goalkeeper',
      drivesMarketRequest: (player, market) =>
        player.position !== 'Goalkeeper' && market === 'goal',
      load,
    };
    const scheduleBackground = vi.fn();
    const service = new StatsService(
      new MockDataSource(),
      new HistoricalGoalscorerProvider(),
      new TtlCache<PlayerStats>(60_000),
      true,
      provider,
      scheduleBackground,
    );
    const nextGame = {
      date: '2026-08-29T18:00:00.000Z',
      competitionSlug: 'bundesliga-de',
      homeTeamName: 'Home FC',
      awayTeamName: 'Away FC',
      homeTeamSlug: 'home-fc',
      awayTeamSlug: 'away-fc',
      playerTeamName: 'Home FC',
      opponentTeamName: 'Away FC',
      playerTeamSlug: 'home-fc',
      cleanSheetProbability: null,
      matchProbabilities: null,
      marketOdds: {
        source: 'mock' as const,
        capturedAt: '2026-08-28T07:00:00.000Z',
        goal: { probability: 0.99, bookmakerCount: 1 },
        assist: null,
      },
    };

    const result = await service.getPlayerMarketSnapshots(
      PlayerMarketSnapshotsRequestSchema.parse({
        players: [
          {
            slug: 'pending-player',
            displayName: 'Pending Player',
            position: 'Forward',
            nextGame,
          },
          {
            slug: 'settled-player',
            displayName: 'Settled Player',
            position: 'Forward',
            nextGame,
          },
          {
            slug: 'unsupported-player',
            displayName: 'Unsupported Player',
            position: 'Goalkeeper',
            nextGame,
          },
        ],
      }),
    );

    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]?.[0]).toHaveLength(2);
    expect(scheduleBackground).not.toHaveBeenCalled();
    expect(
      result.data.map(({ slug, refreshState }) => ({ slug, refreshState })),
    ).toEqual([
      { slug: 'pending-player', refreshState: 'pending' },
      { slug: 'settled-player', refreshState: 'settled' },
      { slug: 'unsupported-player', refreshState: 'unsupported' },
    ]);
    expect(result.data[1]?.marketOdds?.goal?.probability).toBe(0.31);
    expect(result.data[1]?.marketOdds?.goal?.probability).not.toBe(0.99);
    expect(result.data[1]?.fixture).toEqual({
      date: nextGame.date,
      homeTeamSlug: 'home-fc',
      awayTeamSlug: 'away-fc',
      playerTeamSlug: 'home-fc',
    });
  });
});

class FillMissingCache implements Cache<PlayerStats> {
  fillMissingCalls = 0;
  setCalls = 0;
  getKeys: string[] = [];

  get(key: string): undefined {
    this.getKeys.push(key);
    return undefined;
  }

  set(): void {
    this.setCalls += 1;
  }

  fillMissing(_key: string, value: PlayerStats): PlayerStats {
    this.fillMissingCalls += 1;
    return { ...value, displayName: `${value.displayName} (cached form)` };
  }
}

class TeamAwareFixtureCache extends TtlCache<PlayerFixtureStats> {
  constructor(
    private readonly fixturesByTeam: ReadonlyMap<
      string,
      NonNullable<PlayerFixtureStats>
    >,
  ) {
    super(60_000);
  }

  async getTeamFixture(
    _playerCacheKey: string,
    teamSlug: string,
  ): Promise<PlayerFixtureStats | undefined> {
    return this.fixturesByTeam.get(teamSlug);
  }
}

const fixtureRefreshPlayerSlug = 'fixture-refresh-player';
const fixtureRefreshPlayerKey = `${fixtureRefreshPlayerSlug}:Midfielder:no-low`;
const heldFixture: NonNullable<PlayerFixtureStats> = {
  date: '2026-08-08T18:00:00.000Z',
  homeTeamName: 'Held Home FC',
  awayTeamName: 'Held Away FC',
  playerTeamName: 'Held Home FC',
  opponentTeamName: 'Held Away FC',
  cleanSheetProbability: null,
  matchProbabilities: { win: null, draw: null, loss: null },
};
const followingFixture: NonNullable<PlayerFixtureStats> = {
  date: '2026-08-15T18:00:00.000Z',
  homeTeamName: 'Held Home FC',
  awayTeamName: 'Following Away FC',
  playerTeamName: 'Held Home FC',
  opponentTeamName: 'Following Away FC',
  cleanSheetProbability: null,
  matchProbabilities: { win: null, draw: null, loss: null },
};

interface FixtureRefreshScenarioOptions {
  fetchNextGames: PlayerStatsDataSource['fetchNextGames'];
  priceRefreshDue?: boolean;
  refreshFixture?: (
    key: string,
    value: PlayerFixtureStats,
  ) => PlayerFixtureStats | Promise<PlayerFixtureStats>;
}

async function runFixtureRefreshScenario(
  options: FixtureRefreshScenarioOptions,
): Promise<{
  marketRefreshes: PlayerStats[][];
  priceRefreshes: PlayerStats[][];
  matchRefreshes: PlayerStats[][];
  refreshFixture: ReturnType<typeof vi.fn>;
}> {
  let cachedFixture: PlayerFixtureStats = heldFixture;
  const refreshFixture = vi.fn(
    async (key: string, value: PlayerFixtureStats) => {
      const resolved = options.refreshFixture
        ? await options.refreshFixture(key, value)
        : value;
      cachedFixture = resolved;
      return resolved;
    },
  );
  const fixtureCache: Cache<PlayerFixtureStats> & {
    claimRefresh(value: PlayerFixtureStats): Promise<boolean>;
    refresh(
      key: string,
      value: PlayerFixtureStats,
    ): Promise<PlayerFixtureStats>;
  } = {
    get: () => cachedFixture,
    set: (_key, value) => {
      cachedFixture = value;
    },
    fillMissing: (_key, value) => cachedFixture ?? value,
    claimRefresh: async () => true,
    refresh: refreshFixture,
  };
  const formCache = new TtlCache<PlayerFormStats>(60_000);
  formCache.set(fixtureRefreshPlayerKey, {
    slug: fixtureRefreshPlayerSlug,
    displayName: 'Fixture Refresh Player',
    position: 'Midfielder',
    aaL10: { value: 13, sampleSize: 10 },
    cleanSheetL10: { value: 0.3, sampleSize: 10 },
    goalL10: { value: 0.2, sampleSize: 10 },
    excludedLowCoverage: 0,
  });
  const cache = new SplitPlayerStatsCache(formCache, fixtureCache);
  const mock = new MockDataSource();
  const source: PlayerStatsDataSource = {
    source: 'sorare',
    resolvePlayerNames: mock.resolvePlayerNames.bind(mock),
    fetchPlayers: mock.fetchPlayers.bind(mock),
    fetchNextGames: options.fetchNextGames,
  };
  const marketRefreshes: PlayerStats[][] = [];
  const priceRefreshes: PlayerStats[][] = [];
  const marketProvider: PlayerMarketOddsProvider = {
    reportsRefreshDue: true,
    supports: () => true,
    supportsMarket: () => true,
    drivesMarketRequest: (_player, market) => market === 'goal',
    load: async (players, loadOptions) => {
      if (loadOptions?.refreshDueState) {
        loadOptions.refreshDueState.complete = true;
      }
      if (loadOptions?.cacheOnly && options.priceRefreshDue) {
        for (const player of players) {
          loadOptions.refreshDuePlayerKeys?.add(playerMarketOddsKey(player));
        }
      }
      if (!loadOptions?.cacheOnly) marketRefreshes.push([...players]);
      return new Map(
        players.map((player) => [
          playerMarketOddsKey(player),
          options.priceRefreshDue
            ? {
                source: 'odds-api-io' as const,
                capturedAt: '2026-08-06T12:00:00.000Z',
                goal: { probability: 0.25, bookmakerCount: 1 },
                assist: null,
                decisive: null,
              }
            : null,
        ]),
      );
    },
    refreshCachedPrices: async (players) => {
      priceRefreshes.push([...players]);
    },
  };
  const matchRefreshes: PlayerStats[][] = [];
  const matchProvider: FixtureMatchOddsProvider = {
    supports: () => true,
    load: async (players, loadOptions) => {
      if (!loadOptions?.cacheOnly) matchRefreshes.push([...players]);
      return new Map(
        players.map((player) => [playerMarketOddsKey(player), null]),
      );
    },
  };
  const backgroundTasks: Promise<void>[] = [];
  const service = new StatsService(
    source,
    new HistoricalGoalscorerProvider(),
    cache,
    true,
    marketProvider,
    (task) => backgroundTasks.push(task),
    DEFAULT_NAME_RESOLUTION_BUDGET_MS,
    matchProvider,
  );

  await service.getPlayerStats(
    PlayerStatsRequestSchema.parse({
      slugs: [fixtureRefreshPlayerSlug],
      positions: { [fixtureRefreshPlayerSlug]: 'Midfielder' },
    }),
  );
  await Promise.all(backgroundTasks);

  return {
    marketRefreshes,
    priceRefreshes,
    matchRefreshes,
    refreshFixture,
  };
}

describe('StatsService cache writes', () => {
  it('claims one fixture refresh lease per team and match in a batch', async () => {
    const fixture: NonNullable<PlayerFixtureStats> = {
      date: '2026-08-29T18:00:00.000Z',
      competitionSlug: 'bundesliga-de',
      homeTeamName: 'Shared Home',
      awayTeamName: 'Shared Away',
      homeTeamSlug: 'shared-home',
      awayTeamSlug: 'shared-away',
      playerTeamName: 'Shared Home',
      opponentTeamName: 'Shared Away',
      playerTeamSlug: 'shared-home',
      cleanSheetProbability: 0.4,
      matchProbabilities: { win: 0.55, draw: 0.25, loss: 0.2 },
    };
    const slugs = ['shared-player-one', 'shared-player-two'];
    const fixtureByKey = new Map(
      slugs.map((slug) => [`${slug}:auto-v3:no-low`, fixture] as const),
    );
    const claimRefresh = vi.fn(async () => false);
    const fixtureCache: Cache<PlayerFixtureStats> & {
      claimRefresh: typeof claimRefresh;
    } = {
      get: (key) => fixtureByKey.get(key),
      set: (key, value) => {
        fixtureByKey.set(key, value);
      },
      claimRefresh,
    };
    const formCache = new TtlCache<PlayerFormStats>(60_000);
    for (const slug of slugs) {
      formCache.set(`${slug}:Defender:no-low`, {
        slug,
        displayName: slug,
        position: 'Defender',
        aaL10: { value: 12, sampleSize: 10 },
        cleanSheetL10: { value: 0.3, sampleSize: 10 },
        goalL10: { value: 0.1, sampleSize: 10 },
        excludedLowCoverage: 0,
      });
    }
    const source = new MockDataSource();
    const service = new StatsService(
      source,
      new HistoricalGoalscorerProvider(),
      new SplitPlayerStatsCache(formCache, fixtureCache),
      true,
      new UnavailablePlayerMarketOddsProvider(),
    );

    const result = await service.getPlayerStats(
      PlayerStatsRequestSchema.parse({
        slugs,
        positions: Object.fromEntries(
          slugs.map((slug) => [slug, 'Defender']),
        ),
      }),
    );

    expect(result.cacheHits).toBe(2);
    expect(result.data).toHaveLength(2);
    expect(claimRefresh).toHaveBeenCalledTimes(1);
  });

  it('returns cached-name players while a cold name is resolved and warmed in the background', async () => {
    let finishColdResolution:
      | ((requests: SourcePlayerRequest[]) => void)
      | undefined;
    const coldResolution = new Promise<SourcePlayerRequest[]>((resolve) => {
      finishColdResolution = resolve;
    });
    const mock = new MockDataSource();
    const resolvePlayerNames = vi.fn(
      async (
        _names: readonly string[],
        _positions?: Readonly<Record<string, FootballPosition>>,
        options?: PlayerNameResolutionOptions,
      ): Promise<SourcePlayerRequest[]> => {
        if (options?.cacheOnly) {
          return [
            {
              slug: 'cached-player',
              position: 'Midfielder',
              resolvedFromName: 'Cached Player',
            },
          ];
        }
        return coldResolution;
      },
    );
    const fetchPlayers = vi.fn(mock.fetchPlayers.bind(mock));
    const source: PlayerStatsDataSource = {
      source: 'sorare',
      resolvePlayerNames,
      fetchPlayers,
      fetchNextGames: mock.fetchNextGames.bind(mock),
    };
    const backgroundTasks: Promise<void>[] = [];
    const service = new StatsService(
      source,
      new HistoricalGoalscorerProvider(),
      new TtlCache<PlayerStats>(60_000),
      true,
      new MockPlayerMarketOddsProvider(),
      (task) => backgroundTasks.push(task),
      1,
    );

    const result = await service.getPlayerStats(
      PlayerStatsRequestSchema.parse({
        playerNames: ['Cached Player', 'Cold Player'],
        positions: {
          'Cached Player': 'Midfielder',
          'Cold Player': 'Forward',
        },
      }),
    );

    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.slug).toBe('cached-player');
    expect(result.deferredPlayerNames).toEqual(['Cold Player']);
    expect(fetchPlayers).toHaveBeenCalledWith([
      expect.objectContaining({ slug: 'cached-player' }),
    ]);

    finishColdResolution?.([
      {
        slug: 'cold-player',
        position: 'Forward',
        resolvedFromName: 'Cold Player',
      },
    ]);
    await Promise.all(backgroundTasks);

    expect(fetchPlayers).toHaveBeenCalledWith([
      expect.objectContaining({ slug: 'cold-player', position: 'Forward' }),
    ]);
  });

  it('defers a stuck cold name within the short production budget', async () => {
    const never = new Promise<SourcePlayerRequest[]>(() => undefined);
    const source: PlayerStatsDataSource = {
      source: 'sorare',
      resolvePlayerNames: async (_names, _positions, options) =>
        options?.cacheOnly ? [] : never,
      fetchPlayers: vi.fn(async () => []),
      fetchNextGames: async () => [],
    };
    const backgroundTasks: Promise<void>[] = [];
    const service = new StatsService(
      source,
      new HistoricalGoalscorerProvider(),
      new TtlCache<PlayerStats>(60_000),
      true,
      new MockPlayerMarketOddsProvider(),
      (task) => backgroundTasks.push(task),
    );
    const startedAt = performance.now();

    const result = await service.getPlayerStats(
      PlayerStatsRequestSchema.parse({
        playerNames: ['Never Resolves'],
        positions: { 'Never Resolves': 'Midfielder' },
      }),
    );

    expect(performance.now() - startedAt).toBeLessThan(
      DEFAULT_NAME_RESOLUTION_BUDGET_MS + 500,
    );
    expect(result.data).toEqual([]);
    expect(result.deferredPlayerNames).toEqual(['Never Resolves']);
    expect(backgroundTasks).toHaveLength(1);
    expect(source.fetchPlayers).not.toHaveBeenCalled();
  });

  it('re-resolves a name-derived slug when it points to a completely empty player', async () => {
    const resolvePlayerNames = vi.fn(
      async (
        names: readonly string[],
        positions?: Readonly<Record<string, FootballPosition>>,
        options?: PlayerNameResolutionOptions,
      ): Promise<SourcePlayerRequest[]> =>
        names.map((name) => ({
          slug: options?.forceSearch
            ? 'david-ruiz-2004-02-08'
            : 'david-ruiz',
          ...(positions?.[name] ? { position: positions[name] } : {}),
          resolvedFromName: name,
          nameResolution: options?.forceSearch ? 'search' : 'direct',
        })),
    );
    const source: PlayerStatsDataSource = {
      source: 'sorare',
      resolvePlayerNames,
      fetchPlayers: vi.fn(async (requests) =>
        requests.map((request) => ({
          slug: request.slug,
          displayName: 'David Ruíz',
          position: request.position ?? 'Midfielder',
          appearances:
            request.slug === 'david-ruiz'
              ? []
              : [
                  {
                    date: '2026-07-25T23:30:00.000Z',
                    allAroundScore: 4.76,
                    goals: 0,
                    assists: 0,
                    minsPlayed: 60,
                    cleanSheet60: 0,
                    lowCoverage: false,
                    position: 'Midfielder',
                  },
                ],
          nextGame: null,
        }))),
      fetchNextGames: vi.fn(async () => []),
    };
    const service = new StatsService(
      source,
      new HistoricalGoalscorerProvider(),
      new TtlCache<PlayerStats>(60_000),
      true,
      new MockPlayerMarketOddsProvider(),
    );

    const result = await service.getPlayerStats(
      PlayerStatsRequestSchema.parse({
        playerNames: ['David Ruiz'],
        positions: { 'David Ruiz': 'Midfielder' },
      }),
    );

    expect(resolvePlayerNames).toHaveBeenNthCalledWith(
      1,
      ['David Ruiz'],
      { 'David Ruiz': 'Midfielder' },
    );
    expect(resolvePlayerNames).toHaveBeenNthCalledWith(
      2,
      ['David Ruiz'],
      { 'David Ruiz': 'Midfielder' },
      { forceSearch: true },
    );
    expect(result.data).toMatchObject([
      {
        slug: 'david-ruiz-2004-02-08',
        position: 'Midfielder',
        aaL10: { value: 4.76, sampleSize: 1 },
      },
    ]);
  });

  it('keeps cache hits when a force-search replacement load fails', async () => {
    const cache = new TtlCache<PlayerStats>(60_000);
    cache.set('cached-player:Midfielder:no-low', {
      slug: 'cached-player',
      displayName: 'Cached Player',
      position: 'Midfielder',
      aaL10: { value: 14, sampleSize: 10 },
      cleanSheetL10: { value: 0.2, sampleSize: 10 },
      goalL10: { value: 0.1, sampleSize: 10 },
      nextGame: null,
      excludedLowCoverage: 0,
    });
    const resolvePlayerNames = vi.fn(
      async (
        names: readonly string[],
        positions?: Readonly<Record<string, FootballPosition>>,
        options?: PlayerNameResolutionOptions,
      ): Promise<SourcePlayerRequest[]> =>
        names.map((name) => ({
          slug: options?.forceSearch
            ? 'corrected-empty-player'
            : 'empty-direct-player',
          ...(positions?.[name] ? { position: positions[name] } : {}),
          resolvedFromName: name,
          nameResolution: options?.forceSearch ? 'search' : 'direct',
        })),
    );
    const fetchPlayers = vi.fn<
      PlayerStatsDataSource['fetchPlayers']
    >(async (requests) => {
      if (
        requests.some(
          (request) => request.slug === 'corrected-empty-player',
        )
      ) {
        throw new Error('Replacement player load timed out');
      }
      return requests.map((request) => ({
        slug: request.slug,
        displayName: 'Empty Direct Player',
        position: request.position ?? 'Midfielder',
        appearances: [],
        nextGame: null,
      }));
    });
    const source: PlayerStatsDataSource = {
      source: 'sorare',
      resolvePlayerNames,
      fetchPlayers,
      fetchNextGames: async () => [],
    };
    const service = new StatsService(
      source,
      new HistoricalGoalscorerProvider(),
      cache,
      true,
      new MockPlayerMarketOddsProvider(),
    );

    const result = await service.getPlayerStats(
      PlayerStatsRequestSchema.parse({
        slugs: ['cached-player'],
        playerNames: ['Empty Player'],
        positions: {
          'cached-player': 'Midfielder',
          'Empty Player': 'Midfielder',
        },
      }),
    );

    expect(fetchPlayers).toHaveBeenCalledTimes(2);
    expect(result.cacheHits).toBe(1);
    expect(result.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: 'cached-player',
          aaL10: { value: 14, sampleSize: 10 },
        }),
      ]),
    );
  });

  it('does not queue bookmaker refreshes for provider-unsupported fixtures', async () => {
    const load = vi.fn<PlayerMarketOddsProvider['load']>(async () => new Map());
    const marketOddsProvider: PlayerMarketOddsProvider = {
      supports: () => false,
      load,
    };
    const scheduleBackground = vi.fn();
    const service = new StatsService(
      new MockDataSource(),
      new HistoricalGoalscorerProvider(),
      new TtlCache<PlayerStats>(60_000),
      true,
      marketOddsProvider,
      scheduleBackground,
    );

    const result = await service.getPlayerStats(
      PlayerStatsRequestSchema.parse({ slugs: ['jude-bellingham'] }),
    );

    expect(load).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        cacheOnly: true,
        cacheOnlyDeadlineMs: expect.any(Number),
      }),
    );
    expect(scheduleBackground).not.toHaveBeenCalled();
    expect(result.data[0]?.pendingRefreshes ?? []).not.toContain('marketOdds');
  });

  it('does not expose market refreshes for a fresh negative provider cache', async () => {
    const load = vi.fn<PlayerMarketOddsProvider['load']>(
      async (players, options) => {
        if (options?.refreshDueState) {
          options.refreshDueState.complete = true;
        }
        return new Map(
          players.map((player) => [playerMarketOddsKey(player), null]),
        );
      },
    );
    const marketOddsProvider: PlayerMarketOddsProvider = {
      reportsRefreshDue: true,
      supports: () => true,
      supportsMarket: () => true,
      drivesMarketRequest: () => true,
      load,
    };
    const scheduleBackground = vi.fn();
    const service = new StatsService(
      new MockDataSource(),
      new HistoricalGoalscorerProvider(),
      new TtlCache<PlayerStats>(60_000),
      true,
      marketOddsProvider,
      scheduleBackground,
    );

    const result = await service.getPlayerStats(
      PlayerStatsRequestSchema.parse({ slugs: ['jude-bellingham'] }),
    );

    expect(result.data[0]?.pendingRefreshes ?? []).not.toContain('marketOdds');
    expect(load).toHaveBeenCalledTimes(1);
    expect(scheduleBackground).not.toHaveBeenCalled();
  });

  it('schedules an isolated cached-price refresh when an available quote is stale', async () => {
    const load = vi.fn<PlayerMarketOddsProvider['load']>(
      async (players, options) => {
        if (options?.refreshDueState) {
          options.refreshDueState.complete = true;
        }
        for (const stats of players) {
          options?.refreshDuePlayerKeys?.add(playerMarketOddsKey(stats));
        }
        return new Map(
          players.map((stats) => [
            playerMarketOddsKey(stats),
            {
              source: 'odds-api-io' as const,
              capturedAt: '2026-08-25T09:26:30.030Z',
              goal: { probability: 0.25, bookmakerCount: 1 },
              assist: null,
              decisive: null,
            },
          ]),
        );
      },
    );
    const refreshCachedPrices = vi.fn(async () => undefined);
    const marketOddsProvider: PlayerMarketOddsProvider = {
      reportsRefreshDue: true,
      supports: () => true,
      supportsMarket: () => true,
      // Reproduce a player with a cached goal quote and a still-missing,
      // request-driving assist quote. Both refresh reasons must survive.
      drivesMarketRequest: () => true,
      load,
      refreshCachedPrices,
    };
    const backgroundTasks: Promise<void>[] = [];
    const service = new StatsService(
      new MockDataSource(),
      new HistoricalGoalscorerProvider(),
      new TtlCache<PlayerStats>(60_000),
      true,
      marketOddsProvider,
      (task) => backgroundTasks.push(task),
    );

    const result = await service.getPlayerStats(
      PlayerStatsRequestSchema.parse({ slugs: ['jude-bellingham'] }),
    );

    expect(result.data[0]?.pendingRefreshes).toContain('marketOdds');
    expect(backgroundTasks).toHaveLength(1);
    await Promise.all(backgroundTasks);
    expect(refreshCachedPrices).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenNthCalledWith(
      1,
      expect.any(Array),
      expect.objectContaining({ cacheOnly: true }),
    );
    expect(load).toHaveBeenNthCalledWith(2, expect.any(Array));
  });

  it('keeps fixture teammates pending while one shared market snapshot warms', async () => {
    const refreshedPlayers: string[][] = [];
    const load = vi.fn<PlayerMarketOddsProvider['load']>(
      async (players, options) => {
        if (options?.cacheOnly) {
          if (options.refreshDueState) {
            options.refreshDueState.complete = true;
          }
          const driver = players.find(
            (player) => player.slug === 'fixture-warmup-driver',
          );
          if (driver) {
            options.refreshDuePlayerKeys?.add(playerMarketOddsKey(driver));
          }
          return new Map(
            players.map((player) => [
              playerMarketOddsKey(player),
              player.slug === 'fixture-warmup-teammate'
                ? {
                    source: 'odds-api-io' as const,
                    capturedAt: '2026-08-22T08:00:00.000Z',
                    goal: { probability: 0.4, bookmakerCount: 1 },
                    assist: null,
                    decisive: null,
                  }
                : null,
            ]),
          );
        }
        refreshedPlayers.push(players.map(({ slug }) => slug));
        return new Map(
          players.map((player) => [playerMarketOddsKey(player), null]),
        );
      },
    );
    const marketOddsProvider: PlayerMarketOddsProvider = {
      reportsRefreshDue: true,
      supports: () => true,
      supportsMarket: (_player, market) =>
        market === 'goal' || market === 'assist',
      drivesMarketRequest: (_player, market) => market === 'goal',
      load,
    };
    const backgroundTasks: Promise<void>[] = [];
    const service = new StatsService(
      new MockDataSource(),
      new HistoricalGoalscorerProvider(),
      new TtlCache<PlayerStats>(60_000),
      true,
      marketOddsProvider,
      (task) => backgroundTasks.push(task),
    );

    const result = await service.getPlayerStats(
      PlayerStatsRequestSchema.parse({
        slugs: ['fixture-warmup-driver', 'fixture-warmup-teammate'],
        positions: {
          'fixture-warmup-driver': 'Forward',
          'fixture-warmup-teammate': 'Forward',
        },
      }),
    );

    expect(
      result.data.map(({ slug, pendingRefreshes }) => ({
        slug,
        pendingRefreshes,
      })),
    ).toEqual([
      {
        slug: 'fixture-warmup-driver',
        pendingRefreshes: ['marketOdds'],
      },
      {
        slug: 'fixture-warmup-teammate',
        pendingRefreshes: ['marketOdds'],
      },
    ]);
    expect(backgroundTasks).toHaveLength(1);
    await Promise.all(backgroundTasks);
    expect(refreshedPlayers).toEqual([['fixture-warmup-driver']]);
  });

  it('never starts provider work for an explicit odds-cache-only follow-up', async () => {
    const load = vi.fn<PlayerMarketOddsProvider['load']>(
      async (players, options) => {
        if (options?.refreshDueState) options.refreshDueState.complete = true;
        for (const player of players) {
          options?.refreshDuePlayerKeys?.add(playerMarketOddsKey(player));
        }
        return new Map(
          players.map((player) => [playerMarketOddsKey(player), null]),
        );
      },
    );
    const marketOddsProvider: PlayerMarketOddsProvider = {
      reportsRefreshDue: true,
      supports: () => true,
      supportsMarket: () => true,
      drivesMarketRequest: () => true,
      load,
    };
    const scheduleBackground = vi.fn();
    const service = new StatsService(
      new MockDataSource(),
      new HistoricalGoalscorerProvider(),
      new TtlCache<PlayerStats>(60_000),
      true,
      marketOddsProvider,
      scheduleBackground,
    );

    const result = await service.getPlayerStats(
      PlayerStatsRequestSchema.parse({
        slugs: ['cache-only-market-player'],
        positions: { 'cache-only-market-player': 'Forward' },
        oddsCacheOnly: true,
      }),
    );

    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ cacheOnly: true }),
    );
    expect(scheduleBackground).not.toHaveBeenCalled();
    expect(result.data[0]?.pendingRefreshes ?? []).not.toContain('marketOdds');
  });

  it('keeps cached market values in a fifty-player cache-only batch', async () => {
    let announcedBudgetMs = 0;
    const cachedOdds: PlayerMarketOdds = {
      source: 'sports-game-odds',
      capturedAt: '2026-08-28T10:00:00.000Z',
      goal: { probability: 0.4545454545, bookmakerCount: 4 },
      assist: null,
      decisive: null,
    };
    const load = vi.fn<PlayerMarketOddsProvider['load']>(
      async (players, options) => {
        expect(options?.cacheOnly).toBe(true);
        announcedBudgetMs =
          (options?.cacheOnlyDeadlineMs ?? Date.now()) - Date.now();
        await new Promise((resolve) => setTimeout(resolve, 400));
        return new Map(
          players.map((player) => [playerMarketOddsKey(player), cachedOdds]),
        );
      },
    );
    const slugs = Array.from(
      { length: 50 },
      (_, index) => `cached-sort-player-${index + 1}`,
    );
    const service = new StatsService(
      new MockDataSource(),
      new HistoricalGoalscorerProvider(),
      new TtlCache<PlayerStats>(60_000),
      true,
      { load },
    );

    const result = await service.getPlayerStats(
      PlayerStatsRequestSchema.parse({
        slugs,
        positions: Object.fromEntries(
          slugs.map((slug) => [slug, 'Forward' as const]),
        ),
        oddsCacheOnly: true,
      }),
    );

    expect(announcedBudgetMs).toBeGreaterThan(1_400);
    expect(load).toHaveBeenCalledTimes(1);
    expect(result.data).toHaveLength(50);
    expect(
      result.data.every(
        (stats) =>
          stats.nextGame?.marketOdds?.goal?.probability ===
          cachedOdds.goal?.probability,
      ),
    ).toBe(true);
  });

  it('returns a bounded deferred response while a cold slug warms in background', async () => {
    const never = new Promise<never>(() => undefined);
    const source: PlayerStatsDataSource = {
      source: 'sorare',
      resolvePlayerNames: async () => [],
      fetchPlayers: async () => never,
      fetchNextGames: async () => [],
    };
    const backgroundTasks: Promise<void>[] = [];
    const service = new StatsService(
      source,
      new HistoricalGoalscorerProvider(),
      new TtlCache<PlayerStats>(60_000),
      true,
      new UnavailablePlayerMarketOddsProvider(),
      (task) => backgroundTasks.push(task),
      DEFAULT_NAME_RESOLUTION_BUDGET_MS,
      new UnavailableFixtureMatchOddsProvider(),
      50,
      20,
    );

    const result = await service.getPlayerStats(
      PlayerStatsRequestSchema.parse({ slugs: ['cold-player'] }),
    );

    expect(result.data).toEqual([]);
    expect(result.deferredPlayerSlugs).toEqual(['cold-player']);
    expect(result.diagnostics.responseBudgetExceeded).toBe(true);
    expect(backgroundTasks).toHaveLength(1);
  });

  it('uses the cache result when filling a partial cache miss', async () => {
    const cache = new FillMissingCache();
    const service = new StatsService(
      new MockDataSource(),
      new HistoricalGoalscorerProvider(),
      cache,
      true,
      new MockPlayerMarketOddsProvider(() =>
        Date.parse('2026-07-24T12:00:00.000Z'),
      ),
    );

    const result = await service.getPlayerStats(
      PlayerStatsRequestSchema.parse({ slugs: ['jude-bellingham'] }),
    );

    expect(cache.fillMissingCalls).toBe(1);
    expect(cache.setCalls).toBe(0);
    expect(cache.getKeys).toContain('jude-bellingham:auto-v3:no-low');
    expect(result.data[0]?.displayName).toBe('Jude Bellingham (cached form)');
    expect(result.data[0]?.nextGame?.marketOdds).toMatchObject({
      source: 'mock',
      goal: { bookmakerCount: 3 },
      assist: { bookmakerCount: 3 },
    });
  });

  it('keeps an existing cache hit when a cold player load rejects', async () => {
    const cache = new TtlCache<PlayerStats>(60_000);
    cache.set('cached-player:auto-v3:no-low', {
      slug: 'cached-player',
      displayName: 'Cached Player',
      position: 'Midfielder',
      aaL10: { value: 14, sampleSize: 10 },
      cleanSheetL10: { value: 0.2, sampleSize: 10 },
      goalL10: { value: 0.1, sampleSize: 10 },
      nextGame: null,
      excludedLowCoverage: 0,
    });
    const source: PlayerStatsDataSource = {
      source: 'sorare',
      resolvePlayerNames: async () => [],
      fetchPlayers: vi.fn(async () => {
        throw new Error('Cold Sorare batch failed');
      }),
      fetchNextGames: async () => [],
    };
    const service = new StatsService(
      source,
      new HistoricalGoalscorerProvider(),
      cache,
      true,
      new MockPlayerMarketOddsProvider(),
    );

    const result = await service.getPlayerStats(
      PlayerStatsRequestSchema.parse({
        slugs: ['cached-player', 'cold-player'],
      }),
    );

    expect(result.cacheHits).toBe(1);
    expect(result.data).toMatchObject([
      {
        slug: 'cached-player',
        aaL10: { value: 14, sampleSize: 10 },
      },
    ]);
  });

  it('still reports a cold-load failure when no player can be returned', async () => {
    const source: PlayerStatsDataSource = {
      source: 'sorare',
      resolvePlayerNames: async () => [],
      fetchPlayers: vi.fn(async () => {
        throw new Error('Cold Sorare batch failed');
      }),
      fetchNextGames: async () => [],
    };
    const service = new StatsService(
      source,
      new HistoricalGoalscorerProvider(),
      new TtlCache<PlayerStats>(60_000),
      true,
      new MockPlayerMarketOddsProvider(),
    );

    await expect(
      service.getPlayerStats(
        PlayerStatsRequestSchema.parse({ slugs: ['cold-player'] }),
      ),
    ).rejects.toThrow('Cold Sorare batch failed');
  });

  it('loads and stores historical assist windows only when requested', async () => {
    const cache = new FillMissingCache();
    const source = new MockDataSource();
    const fetchPlayers = vi.spyOn(source, 'fetchPlayers');
    const service = new StatsService(
      source,
      new HistoricalGoalscorerProvider(),
      cache,
      true,
      new MockPlayerMarketOddsProvider(() =>
        Date.parse('2026-07-24T12:00:00.000Z'),
      ),
    );

    const result = await service.getPlayerStats(
      PlayerStatsRequestSchema.parse({
        slugs: ['jude-bellingham'],
        includeHistoricalAssists: true,
      }),
    );

    expect(fetchPlayers).toHaveBeenCalledWith([
      {
        slug: 'jude-bellingham',
        includeHistoricalAssists: true,
      },
    ]);
    expect(cache.fillMissingCalls).toBe(0);
    expect(cache.setCalls).toBe(1);
    expect(result.data[0]?.historicalAssists).toMatchObject({
      l10: { sampleSize: 10 },
      l15: { sampleSize: 15 },
      l40: { sampleSize: 40 },
    });
    expect(result.data[0]?.historicalGoals).toMatchObject({
      l10: { sampleSize: 10 },
      l15: { sampleSize: 15 },
      l40: { sampleSize: 40 },
    });
    expect(result.data[0]?.historicalDecisives).toMatchObject({
      l10: { sampleSize: 10 },
      l15: { sampleSize: 15 },
      l40: { sampleSize: 40 },
    });
  });

  it('returns an explicitly partial form immediately and caches only the completed history', async () => {
    let finishHistory:
      | ((players: Awaited<ReturnType<PlayerStatsDataSource['fetchPlayers']>>) => void)
      | undefined;
    const completedHistory = new Promise<
      Awaited<ReturnType<PlayerStatsDataSource['fetchPlayers']>>
    >((resolve) => {
      finishHistory = resolve;
    });
    const appearance = (index: number) => ({
      date: new Date(Date.UTC(2026, 6, 24 - index)).toISOString(),
      allAroundScore: 10 + index,
      goals: 0,
      assists: 0,
      minsPlayed: 90,
      cleanSheet60: 0,
      lowCoverage: false,
      position: 'Midfielder' as const,
    });
    const heldFixture = {
      date: '2026-07-29T18:00:00.000Z',
      competitionSlug: 'mlspa',
      homeTeamName: 'Held Home',
      awayTeamName: 'Held Away',
      playerTeamName: 'Held Home',
      opponentTeamName: 'Held Away',
      cleanSheetProbability: 0.3,
      matchProbabilities: { win: 0.5, draw: 0.25, loss: 0.25 },
    } as const;
    const laterFixture = {
      ...heldFixture,
      date: '2026-08-05T18:00:00.000Z',
      homeTeamName: 'Later Home',
      playerTeamName: 'Later Home',
    } as const;
    const source: PlayerStatsDataSource = {
      source: 'sorare',
      resolvePlayerNames: async () => [],
      fetchPlayersBase: vi.fn(async () => [
        {
          slug: 'cold-history-player',
          displayName: 'Cold History Player',
          position: 'Midfielder',
          appearances: [appearance(0), appearance(1)],
          nextGame: heldFixture,
          historyStatus: 'partial',
        },
      ]),
      fetchPlayers: vi.fn(async () => completedHistory),
      fetchNextGames: async () => [],
    };
    const cache = new SplitPlayerStatsCache(
      new TtlCache<PlayerFormStats>(60_000),
      new TtlCache<PlayerFixtureStats>(60_000),
    );
    const backgroundTasks: Promise<void>[] = [];
    const service = new StatsService(
      source,
      new HistoricalGoalscorerProvider(),
      cache,
      true,
      new MockPlayerMarketOddsProvider(),
      (task) => backgroundTasks.push(task),
    );

    const result = await service.getPlayerStats(
      PlayerStatsRequestSchema.parse({
        slugs: ['cold-history-player'],
        positions: { 'cold-history-player': 'Midfielder' },
        includeHistoricalAssists: true,
        supportsPartialFormHistory: true,
      }),
    );

    expect(result.data[0]).toMatchObject({
      slug: 'cold-history-player',
      aaL10: { sampleSize: 2 },
      pendingRefreshes: ['formHistory'],
    });
    expect(result.data[0]?.historicalAssists).toBeUndefined();
    expect(result.data[0]?.historicalGoals).toBeUndefined();
    expect(result.data[0]?.historicalDecisives).toBeUndefined();
    await expect(
      cache.get('cold-history-player:Midfielder:no-low'),
    ).resolves.toBeUndefined();
    expect(backgroundTasks).toHaveLength(1);

    finishHistory?.([
      {
        slug: 'cold-history-player',
        displayName: 'Cold History Player',
        position: 'Midfielder',
        appearances: Array.from({ length: 40 }, (_, index) =>
          appearance(index),
        ),
        nextGame: laterFixture,
        historyStatus: 'complete',
      },
    ]);
    await Promise.all(backgroundTasks);

    await expect(
      cache.get('cold-history-player:Midfielder:no-low'),
    ).resolves.toMatchObject({
      aaL10: { sampleSize: 10 },
      historicalAssists: { l40: { sampleSize: 40 } },
      nextGame: {
        date: heldFixture.date,
        homeTeamName: heldFixture.homeTeamName,
      },
    });
    expect(
      (
        await cache.get('cold-history-player:Midfielder:no-low')
      )?.pendingRefreshes,
    ).toBeUndefined();
  });

  it('claims one shared full-history refresh across service instances', async () => {
    let finishHistory:
      | ((
          players: Awaited<
            ReturnType<PlayerStatsDataSource['fetchPlayers']>
          >,
        ) => void)
      | undefined;
    const completedHistory = new Promise<
      Awaited<ReturnType<PlayerStatsDataSource['fetchPlayers']>>
    >((resolve) => {
      finishHistory = resolve;
    });
    const appearance = (index: number) => ({
      date: new Date(Date.UTC(2026, 6, 24 - index)).toISOString(),
      allAroundScore: 10 + index,
      goals: 0,
      assists: 0,
      minsPlayed: 90,
      cleanSheet60: 0,
      lowCoverage: false,
      position: 'Midfielder' as const,
    });
    const fetchPlayers = vi.fn(async () => completedHistory);
    const source: PlayerStatsDataSource = {
      source: 'sorare',
      resolvePlayerNames: async () => [],
      fetchPlayersBase: async () => [
        {
          slug: 'shared-history-player',
          displayName: 'Shared History Player',
          position: 'Midfielder',
          appearances: [appearance(0), appearance(1)],
          nextGame: null,
          historyStatus: 'partial',
        },
      ],
      fetchPlayers,
      fetchNextGames: async () => [],
    };
    const cache = new SplitPlayerStatsCache(
      new TtlCache<PlayerFormStats>(60_000),
      new TtlCache<PlayerFixtureStats>(60_000),
    );
    const backgroundTasks: Promise<void>[] = [];
    const createService = () =>
      new StatsService(
        source,
        new HistoricalGoalscorerProvider(),
        cache,
        true,
        new MockPlayerMarketOddsProvider(),
        (task) => backgroundTasks.push(task),
      );
    const request = PlayerStatsRequestSchema.parse({
      slugs: ['shared-history-player'],
      positions: { 'shared-history-player': 'Midfielder' },
      supportsPartialFormHistory: true,
    });

    const [first, second] = await Promise.all([
      createService().getPlayerStats(request),
      createService().getPlayerStats(request),
    ]);

    expect(first.data[0]?.pendingRefreshes).toContain('formHistory');
    expect(second.data[0]?.pendingRefreshes).toContain('formHistory');
    await vi.waitFor(() => expect(fetchPlayers).toHaveBeenCalledTimes(1));

    finishHistory?.([
      {
        slug: 'shared-history-player',
        displayName: 'Shared History Player',
        position: 'Midfielder',
        appearances: Array.from({ length: 10 }, (_, index) =>
          appearance(index),
        ),
        nextGame: null,
        historyStatus: 'complete',
      },
    ]);
    await Promise.all(backgroundTasks);

    await expect(
      cache.get('shared-history-player:Midfielder:no-low'),
    ).resolves.toMatchObject({
      aaL10: { sampleSize: 10 },
    });
  });

  it('releases a failed history-refresh claim so the next request can retry', async () => {
    const appearance = (index: number) => ({
      date: new Date(Date.UTC(2026, 6, 24 - index)).toISOString(),
      allAroundScore: 10 + index,
      goals: 0,
      assists: 0,
      minsPlayed: 90,
      cleanSheet60: 0,
      lowCoverage: false,
      position: 'Midfielder' as const,
    });
    const completePlayer = {
      slug: 'retry-history-player',
      displayName: 'Retry History Player',
      position: 'Midfielder' as const,
      appearances: Array.from({ length: 10 }, (_, index) =>
        appearance(index),
      ),
      nextGame: null,
      historyStatus: 'complete' as const,
    };
    const fetchPlayers = vi
      .fn<PlayerStatsDataSource['fetchPlayers']>()
      .mockRejectedValueOnce(new Error('Transient history failure'))
      .mockResolvedValueOnce([completePlayer]);
    const source: PlayerStatsDataSource = {
      source: 'sorare',
      resolvePlayerNames: async () => [],
      fetchPlayersBase: async () => [
        {
          ...completePlayer,
          appearances: completePlayer.appearances.slice(0, 2),
          historyStatus: 'partial',
        },
      ],
      fetchPlayers,
      fetchNextGames: async () => [],
    };
    const cache = new SplitPlayerStatsCache(
      new TtlCache<PlayerFormStats>(60_000),
      new TtlCache<PlayerFixtureStats>(60_000),
    );
    const backgroundTasks: Promise<void>[] = [];
    const service = new StatsService(
      source,
      new HistoricalGoalscorerProvider(),
      cache,
      true,
      new MockPlayerMarketOddsProvider(),
      (task) => backgroundTasks.push(task),
    );
    const request = PlayerStatsRequestSchema.parse({
      slugs: ['retry-history-player'],
      positions: { 'retry-history-player': 'Midfielder' },
      supportsPartialFormHistory: true,
    });

    await service.getPlayerStats(request);
    await expect(backgroundTasks[0]).rejects.toThrow(
      'player form history refreshes remained incomplete',
    );

    await service.getPlayerStats(request);
    await expect(backgroundTasks[1]).resolves.toBeUndefined();

    expect(fetchPlayers).toHaveBeenCalledTimes(2);
    await expect(
      cache.get('retry-history-player:Midfielder:no-low'),
    ).resolves.toMatchObject({
      aaL10: { sampleSize: 10 },
    });
  });

  it('keeps the complete synchronous history path for clients without the capability flag', async () => {
    const appearance = (index: number) => ({
      date: new Date(Date.UTC(2026, 6, 24 - index)).toISOString(),
      allAroundScore: 10 + index,
      goals: 0,
      assists: 0,
      minsPlayed: 90,
      cleanSheet60: 0,
      lowCoverage: false,
      position: 'Midfielder' as const,
    });
    const fetchPlayersBase = vi.fn(async () => {
      throw new Error('Legacy clients must never use the partial response path');
    });
    const fetchPlayers = vi.fn(async () => [
      {
        slug: 'legacy-client-player',
        displayName: 'Legacy Client Player',
        position: 'Midfielder' as const,
        appearances: Array.from({ length: 10 }, (_, index) =>
          appearance(index),
        ),
        nextGame: null,
        historyStatus: 'complete' as const,
      },
    ]);
    const source: PlayerStatsDataSource = {
      source: 'sorare',
      resolvePlayerNames: async () => [],
      fetchPlayersBase,
      fetchPlayers,
      fetchNextGames: async () => [],
    };
    const service = new StatsService(
      source,
      new HistoricalGoalscorerProvider(),
      new TtlCache<PlayerStats>(60_000),
      true,
      new MockPlayerMarketOddsProvider(),
      vi.fn(),
    );

    const result = await service.getPlayerStats(
      PlayerStatsRequestSchema.parse({
        slugs: ['legacy-client-player'],
        positions: { 'legacy-client-player': 'Midfielder' },
      }),
    );

    expect(fetchPlayersBase).not.toHaveBeenCalled();
    expect(fetchPlayers).toHaveBeenCalledOnce();
    expect(result.data[0]).toMatchObject({
      aaL10: { sampleSize: 10 },
    });
    expect(result.data[0]?.pendingRefreshes).toBeUndefined();
  });

  it('falls back to the complete path when partial history was requested without scheduler support', async () => {
    const source = new MockDataSource();
    const fetchPlayers = vi.spyOn(source, 'fetchPlayers');
    const service = new StatsService(
      source,
      new HistoricalGoalscorerProvider(),
      new TtlCache<PlayerStats>(60_000),
      true,
      new MockPlayerMarketOddsProvider(),
    );

    const result = await service.getPlayerStats(
      PlayerStatsRequestSchema.parse({
        slugs: ['jude-bellingham'],
        supportsPartialFormHistory: true,
      }),
    );

    expect(fetchPlayers).toHaveBeenCalledOnce();
    expect(result.data[0]?.aaL10.sampleSize).toBe(10);
    expect(result.data[0]?.pendingRefreshes).toBeUndefined();
  });

  it('returns cached L10 immediately and refreshes only an expired fixture', async () => {
    let now = 0;
    const cache = new SplitPlayerStatsCache(
      new TtlCache<PlayerFormStats>(24_000, () => now),
      new TtlCache<PlayerFixtureStats>(4_000, () => now),
    );
    const cached: PlayerStats = {
      slug: 'jude-bellingham',
      displayName: 'Jude Bellingham',
      position: 'Midfielder',
      aaL10: { value: 14.2, sampleSize: 10 },
      cleanSheetL10: { value: 0.2, sampleSize: 10 },
      goalL10: { value: 0.3, sampleSize: 10 },
      nextGame: {
        date: '2026-07-25T18:00:00.000Z',
        homeTeamName: 'Old Home',
        awayTeamName: 'Old Away',
        playerTeamName: 'Old Home',
        opponentTeamName: 'Old Away',
        cleanSheetProbability: null,
        matchProbabilities: { win: 0.5, draw: 0.25, loss: 0.25 },
      },
      excludedLowCoverage: 0,
    };
    await cache.set('jude-bellingham:auto-v3:no-low', cached);
    now = 5_000;

    const source = new MockDataSource();
    const fetchPlayers = vi.spyOn(source, 'fetchPlayers');
    const fetchNextGames = vi
      .spyOn(source, 'fetchNextGames')
      .mockResolvedValue([
        {
          slug: 'jude-bellingham',
          nextGame: {
            date: '2026-08-01T18:00:00.000Z',
            homeTeamName: 'New Home',
            awayTeamName: 'New Away',
            playerTeamName: 'New Home',
            opponentTeamName: 'New Away',
            cleanSheetProbability: null,
            matchProbabilities: { win: 0.6, draw: 0.2, loss: 0.2 },
          },
        },
      ]);
    const load = vi.fn(
      async (players: readonly PlayerStats[]) =>
        new Map<string, PlayerMarketOdds | null>(
          players.map((player) => [playerMarketOddsKey(player), null]),
        ),
    );
    const backgroundTasks: Promise<void>[] = [];
    const service = new StatsService(
      source,
      new HistoricalGoalscorerProvider(),
      cache,
      true,
      { load },
      (task) => backgroundTasks.push(task),
    );

    const result = await service.getPlayerStats(
      PlayerStatsRequestSchema.parse({ slugs: ['jude-bellingham'] }),
    );

    expect(result.cacheHits).toBe(1);
    expect(result.data[0]).toMatchObject({
      aaL10: { value: 14.2, sampleSize: 10 },
      nextGame: null,
      pendingRefreshes: ['fixture'],
    });
    expect(fetchPlayers).not.toHaveBeenCalled();
    expect(fetchNextGames).toHaveBeenCalledWith([
      { slug: 'jude-bellingham' },
    ]);

    await Promise.all(backgroundTasks);

    expect(fetchPlayers).not.toHaveBeenCalled();
    await expect(cache.get('jude-bellingham:auto-v3:no-low')).resolves.toMatchObject({
      aaL10: { value: 14.2, sampleSize: 10 },
      nextGame: {
        date: '2026-08-01T18:00:00.000Z',
        homeTeamName: 'New Home',
      },
    });
  });

  it('refreshes due missing CS and H-D-A values only after that cached card is requested', async () => {
    const existingFixture: NonNullable<PlayerFixtureStats> = {
      date: '2026-08-01T18:00:00.000Z',
      homeTeamName: 'Demand Home',
      awayTeamName: 'Demand Away',
      playerTeamName: 'Demand Home',
      opponentTeamName: 'Demand Away',
      cleanSheetProbability: null,
      matchProbabilities: { win: null, draw: null, loss: null },
    };
    let cachedFixture: PlayerFixtureStats = existingFixture;
    const claimRefresh = vi.fn(async () => true);
    const refresh = vi.fn(
      async (_key: string, value: PlayerFixtureStats) => {
        cachedFixture =
          value === null
            ? existingFixture
            : {
                ...existingFixture,
                cleanSheetProbability: value.cleanSheetProbability,
                matchProbabilities: value.matchProbabilities,
              };
        return cachedFixture;
      },
    );
    const fixtureCache: Cache<PlayerFixtureStats> & {
      claimRefresh: typeof claimRefresh;
      refresh: typeof refresh;
    } = {
      get: () => cachedFixture,
      set: (_key, value) => {
        cachedFixture = value;
      },
      fillMissing: (_key, value) => cachedFixture ?? value,
      claimRefresh,
      refresh,
    };
    const formCache = new TtlCache<PlayerFormStats>(60_000);
    const cache = new SplitPlayerStatsCache(formCache, fixtureCache);
    formCache.set('demand-player:Defender:no-low', {
      slug: 'demand-player',
      displayName: 'Demand Player',
      position: 'Defender',
      aaL10: { value: 12, sampleSize: 10 },
      cleanSheetL10: { value: 0.3, sampleSize: 10 },
      goalL10: { value: 0.1, sampleSize: 10 },
      excludedLowCoverage: 0,
    });
    const source = new MockDataSource();
    const fetchPlayers = vi.spyOn(source, 'fetchPlayers');
    const fetchNextGames = vi.spyOn(source, 'fetchNextGames').mockResolvedValue([
      {
        slug: 'demand-player',
        nextGame: {
          ...existingFixture,
          cleanSheetProbability: 0.38,
          matchProbabilities: { win: 0.51, draw: 0.27, loss: 0.22 },
        },
      },
    ]);
    const backgroundTasks: Promise<void>[] = [];
    const service = new StatsService(
      source,
      new HistoricalGoalscorerProvider(),
      cache,
      true,
      new MockPlayerMarketOddsProvider(),
      (task) => backgroundTasks.push(task),
    );

    expect(fetchNextGames).not.toHaveBeenCalled();
    const result = await service.getPlayerStats(
      PlayerStatsRequestSchema.parse({
        slugs: ['demand-player'],
        positions: { 'demand-player': 'Defender' },
      }),
    );

    expect(fetchPlayers).not.toHaveBeenCalled();
    expect(result.data[0]).toMatchObject({
      nextGame: {
        cleanSheetProbability: null,
        matchProbabilities: { win: null, draw: null, loss: null },
      },
      pendingRefreshes: ['fixture'],
    });
    expect(fetchNextGames).toHaveBeenCalledTimes(1);

    await Promise.all(backgroundTasks);
    expect(refresh).toHaveBeenCalledTimes(1);
    await expect(cache.get('demand-player:Defender:no-low')).resolves.toMatchObject({
      nextGame: {
        cleanSheetProbability: 0.38,
        matchProbabilities: { win: 0.51, draw: 0.27, loss: 0.22 },
      },
    });
  });

  it.each([
    {
      label: 'throws',
      fetchNextGames: async () => {
        throw new Error('Temporary Sorare fixture outage');
      },
    },
    {
      label: 'returns no player row',
      fetchNextGames: async () => [],
    },
  ])(
    'refreshes both bookmaker paths for the held fixture when Sorare $label',
    async ({ fetchNextGames }) => {
      const result = await runFixtureRefreshScenario({ fetchNextGames });

      expect(result.refreshFixture).not.toHaveBeenCalled();
      expect(result.marketRefreshes).toHaveLength(1);
      expect(result.matchRefreshes).toHaveLength(1);
      expect(result.marketRefreshes[0]?.[0]?.nextGame).toEqual(heldFixture);
      expect(result.matchRefreshes[0]?.[0]?.nextGame).toEqual(heldFixture);
    },
  );

  it('keeps a due cached-price refresh when the Sorare fixture refresh runs at the same time', async () => {
    const result = await runFixtureRefreshScenario({
      fetchNextGames: async () => [],
      priceRefreshDue: true,
    });

    expect(result.marketRefreshes).toHaveLength(1);
    expect(result.priceRefreshes).toHaveLength(1);
    expect(result.priceRefreshes[0]).toHaveLength(1);
    expect(result.priceRefreshes[0]?.[0]?.nextGame).toEqual(heldFixture);
  });

  it.each([
    {
      label: 'same fixture identity',
      fetchedFixture: {
        ...heldFixture,
        cleanSheetProbability: 0.4,
      },
    },
    {
      label: 'following fixture held until rollover',
      fetchedFixture: followingFixture,
    },
  ])(
    'intentionally refreshes the held fixture when the cache keeps it for $label',
    async ({ fetchedFixture }) => {
      const result = await runFixtureRefreshScenario({
        fetchNextGames: async () => [
          { slug: fixtureRefreshPlayerSlug, nextGame: fetchedFixture },
        ],
        refreshFixture: async () => heldFixture,
      });

      expect(result.refreshFixture).toHaveBeenCalledOnce();
      expect(result.marketRefreshes).toHaveLength(1);
      expect(result.matchRefreshes).toHaveLength(1);
      expect(result.marketRefreshes[0]?.[0]?.nextGame).toEqual(heldFixture);
      expect(result.matchRefreshes[0]?.[0]?.nextGame).toEqual(heldFixture);
    },
  );

  it('refreshes both bookmaker paths exactly once with an accepted new fixture', async () => {
    const result = await runFixtureRefreshScenario({
      fetchNextGames: async () => [
        { slug: fixtureRefreshPlayerSlug, nextGame: followingFixture },
      ],
      refreshFixture: async (_key, value) => value,
    });

    expect(result.refreshFixture).toHaveBeenCalledOnce();
    expect(result.marketRefreshes).toHaveLength(1);
    expect(result.matchRefreshes).toHaveLength(1);
    expect(result.marketRefreshes[0]).toHaveLength(1);
    expect(result.matchRefreshes[0]).toHaveLength(1);
    expect(result.marketRefreshes[0]?.[0]?.nextGame).toEqual(followingFixture);
    expect(result.matchRefreshes[0]?.[0]?.nextGame).toEqual(followingFixture);
    expect(result.marketRefreshes.flat()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ nextGame: heldFixture })]),
    );
    expect(result.matchRefreshes.flat()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ nextGame: heldFixture })]),
    );
  });

  it('skips bookmaker refreshes when persisting a distinct new fixture fails', async () => {
    const result = await runFixtureRefreshScenario({
      fetchNextGames: async () => [
        { slug: fixtureRefreshPlayerSlug, nextGame: followingFixture },
      ],
      refreshFixture: async () => {
        throw new Error('Fixture write failed');
      },
    });

    expect(result.refreshFixture).toHaveBeenCalledOnce();
    expect(result.marketRefreshes).toEqual([]);
    expect(result.matchRefreshes).toEqual([]);
  });

  it('hydrates a missing fixture in the follow-up response without relying on the cache write', async () => {
    const formCache = new TtlCache<PlayerFormStats>(60_000);
    const fixtureCache = new TtlCache<PlayerFixtureStats>(60_000);
    const cache = new SplitPlayerStatsCache(formCache, fixtureCache);
    formCache.set('jude-bellingham:auto-v3:no-low', {
      slug: 'jude-bellingham',
      displayName: 'Jude Bellingham',
      position: 'Midfielder',
      aaL10: { value: 14.2, sampleSize: 10 },
      cleanSheetL10: { value: 0.2, sampleSize: 10 },
      goalL10: { value: 0.3, sampleSize: 10 },
      excludedLowCoverage: 0,
    });
    const source = new MockDataSource();
    vi.spyOn(source, 'fetchNextGames').mockResolvedValue([
      {
        slug: 'jude-bellingham',
        nextGame: {
          date: '2026-08-01T18:00:00.000Z',
          homeTeamName: 'New Home',
          awayTeamName: 'New Away',
          playerTeamName: 'New Home',
          opponentTeamName: 'New Away',
          cleanSheetProbability: 0.32,
          matchProbabilities: { win: 0.6, draw: 0.2, loss: 0.2 },
        },
      },
    ]);
    const service = new StatsService(
      source,
      new HistoricalGoalscorerProvider(),
      cache,
      true,
      new MockPlayerMarketOddsProvider(),
    );

    const result = await service.getPlayerStats(
      PlayerStatsRequestSchema.parse({
        slugs: ['jude-bellingham'],
        refreshFixtures: true,
      }),
    );

    expect(result.cacheHits).toBe(1);
    expect(result.data[0]).toMatchObject({
      aaL10: { value: 14.2, sampleSize: 10 },
      nextGame: {
        homeTeamName: 'New Home',
        cleanSheetProbability: 0.32,
        matchProbabilities: { win: 0.6, draw: 0.2, loss: 0.2 },
      },
    });
    expect(result.data[0]?.pendingRefreshes).toBeUndefined();
  });

  it('returns one held fixture for cached players on the same current team', async () => {
    const cache = new SplitPlayerStatsCache(
      new TtlCache<PlayerFormStats>(60_000),
      new TtlCache<PlayerFixtureStats>(60_000),
    );
    const heldFixture: NonNullable<PlayerFixtureStats> = {
      date: '2026-07-28T18:45:00.000Z',
      homeTeamName: 'Previous Opponent',
      awayTeamName: 'Shared Team',
      playerTeamName: 'Shared Team',
      opponentTeamName: 'Previous Opponent',
      cleanSheetProbability: 0.19,
      matchProbabilities: { win: 0.26, draw: 0.22, loss: 0.52 },
    };
    const nextFixture: NonNullable<PlayerFixtureStats> = {
      date: '2026-08-01T15:00:00.000Z',
      homeTeamName: 'Next Opponent',
      awayTeamName: 'Shared Team',
      playerTeamName: 'Shared Team',
      opponentTeamName: 'Next Opponent',
      cleanSheetProbability: 0.35,
      matchProbabilities: { win: 0.49, draw: 0.26, loss: 0.25 },
    };
    const playerStats = (
      slug: string,
      nextGame: NonNullable<PlayerFixtureStats>,
    ): PlayerStats => ({
      slug,
      displayName: slug,
      position: 'Defender',
      aaL10: { value: 12, sampleSize: 10 },
      cleanSheetL10: { value: 0.3, sampleSize: 10 },
      goalL10: { value: 0.1, sampleSize: 10 },
      nextGame,
      excludedLowCoverage: 0,
    });
    await cache.set(
      'held-teammate:Defender:no-low',
      playerStats('held-teammate', heldFixture),
    );
    await cache.set(
      'cold-teammate:Defender:no-low',
      playerStats('cold-teammate', nextFixture),
    );
    const service = new StatsService(
      new MockDataSource(),
      new HistoricalGoalscorerProvider(),
      cache,
      true,
      new MockPlayerMarketOddsProvider(),
    );

    const result = await service.getPlayerStats(
      PlayerStatsRequestSchema.parse({
        slugs: ['cold-teammate', 'held-teammate'],
        positions: {
          'cold-teammate': 'Defender',
          'held-teammate': 'Defender',
        },
      }),
    );

    expect(result.data).toHaveLength(2);
    for (const player of result.data) {
      expect(player.nextGame).toMatchObject({
        date: '2026-07-28T18:45:00.000Z',
        playerTeamName: 'Shared Team',
        cleanSheetProbability: 0.19,
      });
    }
  });

  it('fills a missing player fixture from a requested teammate without copying player props', async () => {
    const cache = new SplitPlayerStatsCache(
      new TtlCache<PlayerFormStats>(60_000),
      new TtlCache<PlayerFixtureStats>(60_000),
    );
    const sharedFixture: NonNullable<PlayerFixtureStats> = {
      date: '2026-08-12T02:30:00.000Z',
      homeTeamName: 'Seattle Sounders FC',
      awayTeamName: 'Queretaro FC',
      playerTeamName: 'Seattle Sounders FC',
      opponentTeamName: 'Queretaro FC',
      cleanSheetProbability: 0.32,
      matchProbabilities: { win: 0.51, draw: 0.24, loss: 0.25 },
    };
    const form = (slug: string): PlayerFormStats => ({
      slug,
      displayName: slug,
      position: 'Forward',
      aaL10: { value: 8, sampleSize: 10 },
      cleanSheetL10: { value: 0.2, sampleSize: 10 },
      goalL10: { value: 0.3, sampleSize: 10 },
      excludedLowCoverage: 0,
    });
    await cache.set('known-teammate:Forward:no-low', {
      ...form('known-teammate'),
      nextGame: sharedFixture,
    });
    await cache.setForm(
      'missing-fixture-teammate:Forward:no-low',
      form('missing-fixture-teammate'),
    );
    const source = new MockDataSource();
    vi.spyOn(source, 'resolvePlayerNames').mockResolvedValue([
      {
        slug: 'known-teammate',
        position: 'Forward',
        resolvedFromName: 'Known Teammate',
        teamSlug: 'seattle-sounders-renton-washington',
      },
      {
        slug: 'missing-fixture-teammate',
        position: 'Forward',
        resolvedFromName: 'Missing Fixture Teammate',
        teamSlug: 'seattle-sounders-renton-washington',
      },
    ]);
    const service = new StatsService(
      source,
      new HistoricalGoalscorerProvider(),
      cache,
      true,
      new UnavailablePlayerMarketOddsProvider(),
    );

    const result = await service.getPlayerStats(
      PlayerStatsRequestSchema.parse({
        playerNames: ['Known Teammate', 'Missing Fixture Teammate'],
        positions: {
          'Known Teammate': 'Forward',
          'Missing Fixture Teammate': 'Forward',
        },
        playerTeams: {
          'Known Teammate': 'seattle-sounders-renton-washington',
          'Missing Fixture Teammate':
            'seattle-sounders-renton-washington',
        },
      }),
    );

    const missing = result.data.find(
      (player) => player.slug === 'missing-fixture-teammate',
    );
    expect(missing?.nextGame).toMatchObject({
      date: sharedFixture.date,
      playerTeamName: 'Seattle Sounders FC',
      cleanSheetProbability: 0.32,
      matchProbabilities: { win: 0.51, draw: 0.24, loss: 0.25 },
      marketOdds: null,
    });
  });

  it('serves an isolated cached player from the persistent team fixture without refreshing Sorare', async () => {
    const teamFixture: NonNullable<PlayerFixtureStats> = {
      date: '2026-08-12T02:30:00.000Z',
      homeTeamName: 'Seattle Sounders FC',
      awayTeamName: 'Queretaro FC',
      playerTeamName: 'Seattle Sounders FC',
      opponentTeamName: 'Queretaro FC',
      playerTeamSlug: 'seattle-sounders-renton-washington',
      cleanSheetProbability: 0.32,
      matchProbabilities: { win: 0.51, draw: 0.24, loss: 0.25 },
    };
    const fixtureCache = new TeamAwareFixtureCache(
      new Map([[teamFixture.playerTeamSlug!, teamFixture]]),
    );
    const cache = new SplitPlayerStatsCache(
      new TtlCache<PlayerFormStats>(60_000),
      fixtureCache,
    );
    const key = 'isolated-team-player:Forward:no-low';
    await cache.setForm(key, {
      slug: 'isolated-team-player',
      displayName: 'Isolated Team Player',
      position: 'Forward',
      aaL10: { value: 9, sampleSize: 10 },
      cleanSheetL10: { value: 0.2, sampleSize: 10 },
      goalL10: { value: 0.3, sampleSize: 10 },
      excludedLowCoverage: 0,
    });
    fixtureCache.set('isolated-team-player:auto-v3:no-low', null);
    const source = new MockDataSource();
    const fetchPlayers = vi.spyOn(source, 'fetchPlayers');
    const fetchNextGames = vi.spyOn(source, 'fetchNextGames');
    const backgroundTasks: Promise<void>[] = [];
    const service = new StatsService(
      source,
      new HistoricalGoalscorerProvider(),
      cache,
      true,
      new UnavailablePlayerMarketOddsProvider(),
      (task) => backgroundTasks.push(task),
    );

    const result = await service.getPlayerStats(
      PlayerStatsRequestSchema.parse({
        slugs: ['isolated-team-player'],
        positions: { 'isolated-team-player': 'Forward' },
        playerTeams: {
          'isolated-team-player': 'seattle-sounders-renton-washington',
        },
      }),
    );

    expect(result.data[0]?.nextGame).toMatchObject({
      playerTeamSlug: 'seattle-sounders-renton-washington',
      cleanSheetProbability: 0.32,
      matchProbabilities: { win: 0.51, draw: 0.24, loss: 0.25 },
      marketOdds: null,
    });
    expect(result.data[0]?.pendingRefreshes).toBeUndefined();
    expect(fetchPlayers).not.toHaveBeenCalled();
    expect(fetchNextGames).not.toHaveBeenCalled();
    expect(backgroundTasks).toHaveLength(0);
    expect(
      fixtureCache.get('isolated-team-player:auto-v3:no-low'),
    ).toBeNull();
  });

  it('repairs a cached fixture side from a server-confirmed name resolution', async () => {
    const cache = new SplitPlayerStatsCache(
      new TtlCache<PlayerFormStats>(60_000),
      new TtlCache<PlayerFixtureStats>(60_000),
    );
    const playerKey = 'carlos-henrique-casimiro:Midfielder:no-low';
    await cache.set(playerKey, {
      slug: 'carlos-henrique-casimiro',
      displayName: 'Casemiro',
      position: 'Midfielder',
      aaL10: { value: 15.12, sampleSize: 10 },
      cleanSheetL10: { value: 0.3, sampleSize: 10 },
      goalL10: { value: 0.1, sampleSize: 10 },
      nextGame: {
        date: '2026-08-19T23:30:00.000Z',
        homeTeamName: 'Philadelphia Union',
        awayTeamName: 'Inter Miami',
        homeTeamSlug: 'philadelphia-union-chester-pennsylvania',
        awayTeamSlug: 'inter-miami',
        playerTeamName: null,
        opponentTeamName: null,
        cleanSheetProbability: null,
        matchProbabilities: null,
      },
      excludedLowCoverage: 0,
    });
    const fetchPlayers = vi.fn<PlayerStatsDataSource['fetchPlayers']>();
    const source: PlayerStatsDataSource = {
      source: 'sorare',
      resolvePlayerNames: async () => [
        {
          slug: 'carlos-henrique-casimiro',
          position: 'Midfielder',
          teamSlug: 'inter-miami',
          resolvedFromName: 'Casemiro',
          nameResolution: 'search',
        },
      ],
      fetchPlayers,
      fetchNextGames: async () => [],
    };
    const service = new StatsService(
      source,
      new HistoricalGoalscorerProvider(),
      cache,
      true,
      new UnavailablePlayerMarketOddsProvider(),
    );

    const result = await service.getPlayerStats(
      PlayerStatsRequestSchema.parse({
        playerNames: ['Casemiro'],
        positions: { Casemiro: 'Midfielder' },
        playerTeams: { Casemiro: 'inter-miami' },
      }),
    );

    expect(result.data[0]?.nextGame).toMatchObject({
      playerTeamName: 'Inter Miami',
      opponentTeamName: 'Philadelphia Union',
      playerTeamSlug: 'inter-miami',
    });
    expect(fetchPlayers).not.toHaveBeenCalled();
    await expect(cache.get(playerKey)).resolves.toMatchObject({
      nextGame: {
        playerTeamName: 'Inter Miami',
        playerTeamSlug: 'inter-miami',
      },
    });
  });

  it('prefers a still-active canonical team fixture over a later player nextGame', async () => {
    const heldFixture: NonNullable<PlayerFixtureStats> = {
      date: '2026-08-20T00:00:00.000Z',
      competitionSlug: 'uefa-europa-conference-league',
      homeTeamName: 'Motherwell',
      awayTeamName: 'Freiburg',
      playerTeamName: 'Freiburg',
      opponentTeamName: 'Motherwell',
      playerTeamSlug: 'freiburg-freiburg-im-breisgau',
      cleanSheetProbability: null,
      matchProbabilities: null,
    };
    const fixtureCache = new TeamAwareFixtureCache(
      new Map([[heldFixture.playerTeamSlug!, heldFixture]]),
    );
    const cache = new SplitPlayerStatsCache(
      new TtlCache<PlayerFormStats>(60_000),
      fixtureCache,
    );
    const playerKey = 'matthias-ginter:Defender:no-low';
    await cache.set(playerKey, {
      slug: 'matthias-ginter',
      displayName: 'Matthias Ginter',
      position: 'Defender',
      aaL10: { value: 14.1, sampleSize: 10 },
      cleanSheetL10: { value: 0.2, sampleSize: 10 },
      goalL10: { value: 0.2, sampleSize: 10 },
      nextGame: {
        date: '2026-08-30T13:30:00.000Z',
        competitionSlug: 'bundesliga-de',
        homeTeamName: 'Freiburg',
        awayTeamName: 'Werder Bremen',
        playerTeamName: 'Freiburg',
        opponentTeamName: 'Werder Bremen',
        cleanSheetProbability: null,
        matchProbabilities: null,
      },
      excludedLowCoverage: 0,
    });
    const source: PlayerStatsDataSource = {
      source: 'sorare',
      resolvePlayerNames: async () => [
        {
          slug: 'matthias-ginter',
          position: 'Defender',
          teamSlug: 'freiburg-freiburg-im-breisgau',
          resolvedFromName: 'Matthias Ginter',
          nameResolution: 'search',
        },
      ],
      fetchPlayers: vi.fn(),
      fetchNextGames: vi.fn(),
    };
    const service = new StatsService(
      source,
      new HistoricalGoalscorerProvider(),
      cache,
      true,
      new UnavailablePlayerMarketOddsProvider(),
    );

    const result = await service.getPlayerStats(
      PlayerStatsRequestSchema.parse({
        playerNames: ['Matthias Ginter'],
        positions: { 'Matthias Ginter': 'Defender' },
        playerTeams: {
          'Matthias Ginter': 'freiburg-freiburg-im-breisgau',
        },
      }),
    );

    expect(result.data[0]?.nextGame).toMatchObject({
      date: heldFixture.date,
      competitionSlug: 'uefa-europa-conference-league',
      homeTeamName: 'Motherwell',
      awayTeamName: 'Freiburg',
      playerTeamSlug: 'freiburg-freiburg-im-breisgau',
    });
    await expect(cache.get(playerKey)).resolves.toMatchObject({
      nextGame: { date: heldFixture.date },
    });
  });

  it('never harmonizes fixtures with different Sorare-confirmed team slugs', async () => {
    const cache = new SplitPlayerStatsCache(
      new TtlCache<PlayerFormStats>(60_000),
      new TtlCache<PlayerFixtureStats>(60_000),
    );
    const form = (slug: string): PlayerFormStats => ({
      slug,
      displayName: slug,
      position: 'Defender',
      aaL10: { value: 10, sampleSize: 10 },
      cleanSheetL10: { value: 0.3, sampleSize: 10 },
      goalL10: { value: 0.1, sampleSize: 10 },
      excludedLowCoverage: 0,
    });
    await cache.set('team-a-player:Defender:no-low', {
      ...form('team-a-player'),
      nextGame: {
        date: '2026-08-12T18:00:00.000Z',
        homeTeamName: 'Shared Display Name',
        awayTeamName: 'Opponent A',
        playerTeamName: 'Shared Display Name',
        opponentTeamName: 'Opponent A',
        playerTeamSlug: 'canonical-team-a',
        cleanSheetProbability: 0.41,
        matchProbabilities: { win: 0.55, draw: 0.25, loss: 0.2 },
      },
    });
    await cache.set('team-b-player:Defender:no-low', {
      ...form('team-b-player'),
      nextGame: {
        date: '2026-08-13T18:00:00.000Z',
        homeTeamName: 'Shared Display Name',
        awayTeamName: 'Opponent B',
        playerTeamName: 'Shared Display Name',
        opponentTeamName: 'Opponent B',
        playerTeamSlug: 'canonical-team-b',
        cleanSheetProbability: 0.22,
        matchProbabilities: { win: 0.33, draw: 0.27, loss: 0.4 },
      },
    });
    const service = new StatsService(
      new MockDataSource(),
      new HistoricalGoalscorerProvider(),
      cache,
      true,
      new UnavailablePlayerMarketOddsProvider(),
    );

    const result = await service.getPlayerStats(
      PlayerStatsRequestSchema.parse({
        slugs: ['team-a-player', 'team-b-player'],
        positions: {
          'team-a-player': 'Defender',
          'team-b-player': 'Defender',
        },
        // Deliberately misleading client hints must not override canonical
        // identities already confirmed by Sorare.
        playerTeams: {
          'team-a-player': 'same-client-hint',
          'team-b-player': 'same-client-hint',
        },
      }),
    );

    expect(
      result.data.find(({ slug }) => slug === 'team-a-player')?.nextGame,
    ).toMatchObject({
      playerTeamSlug: 'canonical-team-a',
      opponentTeamName: 'Opponent A',
      cleanSheetProbability: 0.41,
    });
    expect(
      result.data.find(({ slug }) => slug === 'team-b-player')?.nextGame,
    ).toMatchObject({
      playerTeamSlug: 'canonical-team-b',
      opponentTeamName: 'Opponent B',
      cleanSheetProbability: 0.22,
    });
  });

  it('never sends goalkeepers to a market-odds provider', async () => {
    const source = new MockDataSource();
    const load = vi.fn(
      async (players: readonly PlayerStats[]) =>
        new Map<string, PlayerMarketOdds | null>(
          players.map((player) => [playerMarketOddsKey(player), null]),
        ),
    );
    const provider: PlayerMarketOddsProvider = { load };
    const backgroundTasks: Promise<void>[] = [];
    const service = new StatsService(
      source,
      new HistoricalGoalscorerProvider(),
      new TtlCache<PlayerStats>(60_000),
      true,
      provider,
      (task) => backgroundTasks.push(task),
    );

    const result = await service.getPlayerStats(
      PlayerStatsRequestSchema.parse({
        slugs: ['matt-turner', 'jude-bellingham'],
        positions: {
          'matt-turner': 'Goalkeeper',
          'jude-bellingham': 'Midfielder',
        },
      }),
    );
    await Promise.all(backgroundTasks);

    expect(result.data).toHaveLength(2);
    expect(load).toHaveBeenCalled();
    for (const [players] of load.mock.calls) {
      expect(players.every((player) => player.position !== 'Goalkeeper')).toBe(
        true,
      );
    }
  });

  it('does not wait for external odds before returning available statistics', async () => {
    let releaseOdds:
      | ((value: Map<string, PlayerMarketOdds | null>) => void)
      | undefined;
    const blockedOdds = new Promise<Map<string, PlayerMarketOdds | null>>(
      (resolve) => {
        releaseOdds = resolve;
      },
    );
    const load = vi.fn(
      (
        players: readonly PlayerStats[],
        options?: { cacheOnly?: boolean },
      ): Promise<Map<string, PlayerMarketOdds | null>> => {
        if (options?.cacheOnly) {
          return Promise.resolve(
            new Map(
              players.map((player) => [playerMarketOddsKey(player), null]),
            ),
          );
        }
        return blockedOdds;
      },
    );
    const backgroundTasks: Promise<void>[] = [];
    const service = new StatsService(
      new MockDataSource(),
      new HistoricalGoalscorerProvider(),
      new TtlCache<PlayerStats>(60_000),
      true,
      { load },
      (task) => backgroundTasks.push(task),
    );

    const result = await service.getPlayerStats(
      PlayerStatsRequestSchema.parse({
        slugs: ['jude-bellingham'],
        positions: { 'jude-bellingham': 'Midfielder' },
      }),
    );

    expect(result.data[0]).toMatchObject({
      slug: 'jude-bellingham',
      aaL10: { sampleSize: 10 },
      pendingRefreshes: ['marketOdds'],
    });
    expect(backgroundTasks).toHaveLength(1);

    releaseOdds?.(new Map());
    await Promise.all(backgroundTasks);
  });

  it('does not let a stuck cache-only odds read block available statistics', async () => {
    const never = new Promise<Map<string, PlayerMarketOdds | null>>(
      () => undefined,
    );
    const load = vi.fn<
      PlayerMarketOddsProvider['load']
    >(async (players, options) =>
      options?.cacheOnly
        ? never
        : new Map(
            players.map((player) => [playerMarketOddsKey(player), null]),
          ),
    );
    const scheduleBackground = vi.fn();
    const service = new StatsService(
      new MockDataSource(),
      new HistoricalGoalscorerProvider(),
      new TtlCache<PlayerStats>(60_000),
      true,
      { load },
      scheduleBackground,
      3_000,
      new UnavailableFixtureMatchOddsProvider(),
      1,
    );

    const result = await Promise.race([
      service.getPlayerStats(
        PlayerStatsRequestSchema.parse({
          slugs: ['jude-bellingham'],
          positions: { 'jude-bellingham': 'Midfielder' },
        }),
      ),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('Cache-only odds read blocked the response')),
          100,
        ),
      ),
    ]);

    expect(result.data[0]).toMatchObject({
      slug: 'jude-bellingham',
      aaL10: { sampleSize: 10 },
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenNthCalledWith(
      1,
      expect.any(Array),
      expect.objectContaining({
        cacheOnly: true,
        cacheOnlyDeadlineMs: expect.any(Number),
      }),
    );
    expect(load).toHaveBeenNthCalledWith(2, expect.any(Array));
    expect(scheduleBackground).toHaveBeenCalledTimes(1);
  });

  it('fills missing H-D-A and CS values while keeping Sorare probabilities authoritative', async () => {
    const mock = new MockDataSource();
    const source: PlayerStatsDataSource = {
      source: 'sorare',
      resolvePlayerNames: mock.resolvePlayerNames.bind(mock),
      fetchNextGames: mock.fetchNextGames.bind(mock),
      fetchPlayers: async (requests) =>
        (await mock.fetchPlayers(requests)).map((player) => ({
          ...player,
          nextGame: player.nextGame
            ? {
              ...player.nextGame,
                cleanSheetProbability: null,
                matchProbabilities: {
                  win: null,
                  draw: 0.24,
                  loss: null,
                },
              }
            : null,
        })),
    };
    const fallback = {
      win: 0.51,
      draw: 0.22,
      loss: 0.27,
      cleanSheetProbability: 0.41,
    };
    const fixtureProvider: FixtureMatchOddsProvider = {
      supports: () => true,
      load: async (players) =>
        new Map(
          players.map((player) => [
            playerMarketOddsKey(player),
            fallback,
          ]),
        ),
    };
    const service = new StatsService(
      source,
      new HistoricalGoalscorerProvider(),
      new TtlCache<PlayerStats>(60_000),
      true,
      new MockPlayerMarketOddsProvider(),
      undefined,
      3_000,
      fixtureProvider,
    );

    const result = await service.getPlayerStats(
      PlayerStatsRequestSchema.parse({
        slugs: ['jude-bellingham'],
        positions: { 'jude-bellingham': 'Midfielder' },
      }),
    );

    expect(result.data[0]?.nextGame?.matchProbabilities).toEqual({
      win: 0.51,
      draw: 0.24,
      loss: 0.27,
    });
    expect(result.data[0]?.nextGame?.cleanSheetProbability).toBe(0.41);
  });
});
