import {
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
  playerMarketOddsKey,
  type PlayerMarketOddsProvider,
} from '../providers/market-odds-provider.js';
import type { FixtureMatchOddsProvider } from '../providers/match-odds-provider.js';
import type {
  PlayerNameResolutionOptions,
  PlayerStatsDataSource,
  SourcePlayerRequest,
} from '../services/data-source.js';
import { StatsService } from '../services/stats-service.js';

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

describe('StatsService cache writes', () => {
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
                    minsPlayed: 20,
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

    expect(load).toHaveBeenCalledWith([], { cacheOnly: true });
    expect(scheduleBackground).not.toHaveBeenCalled();
    expect(result.data[0]?.pendingRefreshes ?? []).not.toContain('marketOdds');
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

  it('fills only missing H-D-A values and keeps Sorare probabilities authoritative', async () => {
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
                matchProbabilities: {
                  win: null,
                  draw: 0.24,
                  loss: null,
                },
              }
            : null,
        })),
    };
    const fallback: MatchProbabilities = {
      win: 0.51,
      draw: 0.22,
      loss: 0.27,
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
  });
});
