import {PlayerStatsRequestSchema, type PlayerStats} from '@sorare-overlay/shared';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {SplitPlayerStatsCache, TtlCache, type PlayerFixtureStats, type PlayerFormStats} from '../cache.js';
import {HistoricalGoalscorerProvider} from '../providers/goalscorer-provider.js';
import {UnavailablePlayerMarketOddsProvider} from '../providers/market-odds-provider.js';
import type {PlayerStatsDataSource} from '../services/data-source.js';
import {StatsService} from '../services/stats-service.js';

afterEach(() => vi.useRealTimers());

async function cachedPool(count: number, teamSize = 1) {
  const cache = new SplitPlayerStatsCache(new TtlCache<PlayerFormStats>(60_000), new TtlCache<PlayerFixtureStats>(60_000));
  const slugs = Array.from({length: count}, (_, i) => `cached-player-${i}`);
  for (const [i, slug] of slugs.entries()) {
    const team = Math.floor(i / teamSize);
    await cache.set(`${slug}:auto-v3:no-low`, {
      slug, displayName: slug, position: 'Defender', excludedLowCoverage: 0,
      aaL10: {value: 12, sampleSize: 10}, goalL10: {value: .1, sampleSize: 10},
      cleanSheetL10: {value: .3, sampleSize: 10},
      nextGame: {
        date: '2026-09-16T18:00:00Z', playerTeamSlug: `home-${team}`,
        homeTeamSlug: `home-${team}`, awayTeamSlug: `away-${team}`,
        playerTeamName: `Home ${team}`, opponentTeamName: `Away ${team}`,
        homeTeamName: `Home ${team}`, awayTeamName: `Away ${team}`,
        cleanSheetProbability: null, matchProbabilities: null,
      },
    });
  }
  const source: PlayerStatsDataSource = {
    source: 'sorare', resolvePlayerNames: vi.fn(async () => []),
    fetchPlayers: vi.fn(async () => []), fetchNextGames: vi.fn(async () => []),
  };
  const provider = new UnavailablePlayerMarketOddsProvider();
  const loadOdds = vi.spyOn(provider, 'load');
  const background: Promise<void>[] = [];
  const service = new StatsService(source, new HistoricalGoalscorerProvider(), cache, true, provider,
    task => background.push(task));
  const request = PlayerStatsRequestSchema.parse({slugs, oddsCacheOnly: true, refreshFixtures: true});
  return {cache, source, loadOdds, background, service, request};
}

describe('cached sort batch fixture checks', () => {
  it('checks fifty cached fixtures with bounded concurrency instead of fifty serial round trips', async () => {
    vi.useFakeTimers();
    const {cache, service, request, source, loadOdds} = await cachedPool(50);
    let active = 0, peak = 0;
    const claim = vi.spyOn(cache, 'claimFixtureRefresh').mockImplementation(async () => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 200));
      active--;
      return false;
    });
    const started = Date.now();
    const pending = service.getPlayerStats(request);
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.data).toHaveLength(50);
    expect(result.cacheHits).toBe(50);
    expect(result.diagnostics.responseBudgetExceeded).toBe(false);
    expect(Date.now() - started).toBeLessThanOrEqual(1_800);
    expect(peak).toBe(6);
    expect(claim).toHaveBeenCalledTimes(50);
    expect(source.fetchPlayers).not.toHaveBeenCalled();
    expect(source.fetchNextGames).not.toHaveBeenCalled();
    expect(loadOdds.mock.calls.every(([, options]) => options?.cacheOnly)).toBe(true);
  });

  it('still claims only once per team fixture while checks overlap', async () => {
    vi.useFakeTimers();
    const {cache, service, request, source} = await cachedPool(50, 2);
    const claim = vi.spyOn(cache, 'claimFixtureRefresh').mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 200));
      return true;
    });
    const pending = service.getPlayerStats(request);
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(claim).toHaveBeenCalledTimes(25);
    expect(source.fetchNextGames).toHaveBeenCalledTimes(1);
    expect(vi.mocked(source.fetchNextGames).mock.calls[0]![0]).toHaveLength(25);
    expect(result.data).toHaveLength(50);
  });

  it('returns all cached form values at the deadline even if refresh checks stall', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance']});
    const {cache, service, request, background} = await cachedPool(50);
    let release!: (value: boolean) => void;
    const blocked = new Promise<boolean>(resolve => {release = resolve;});
    vi.spyOn(cache, 'claimFixtureRefresh').mockImplementation(() => blocked);
    const pending = service.getPlayerStats(request);
    await vi.advanceTimersByTimeAsync(9_001);
    const result = await pending;
    expect(result.diagnostics.responseBudgetExceeded).toBe(true);
    expect(result.diagnostics.durationsMs.cache).toBeGreaterThanOrEqual(9_000);
    expect(result.data).toHaveLength(50);
    expect(result.cacheHits).toBe(50);
    expect(result.data.every(player => player.aaL10.value === 12 && player.pendingRefreshes?.includes('fixture'))).toBe(true);
    release(false);
    await Promise.all(background);
  });
});
