import {
  PlayerStatsRequestSchema,
  type FootballPosition,
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
});
