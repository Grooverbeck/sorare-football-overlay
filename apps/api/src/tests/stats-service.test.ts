import {
  PlayerStatsRequestSchema,
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
