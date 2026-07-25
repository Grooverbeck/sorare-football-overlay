import type { PlayerStats } from '@sorare-overlay/shared';
import { describe, expect, it } from 'vitest';
import {
  SplitPlayerStatsCache,
  TtlCache,
  type Cache,
  type PlayerFixtureStats,
  type PlayerFormStats,
} from '../cache.js';

const stats: PlayerStats = {
  slug: 'cache-test-player',
  displayName: 'Cache Test Player',
  position: 'Midfielder',
  aaL10: { value: 10.5, sampleSize: 10 },
  cleanSheetL10: { value: 0.2, sampleSize: 10 },
  goalL10: { value: 0.3, sampleSize: 10 },
  nextGame: {
    date: '2026-07-25T18:00:00.000Z',
    cleanSheetProbability: 0.4,
    matchProbabilities: { win: 0.5, draw: 0.25, loss: 0.25 },
  },
  excludedLowCoverage: 0,
};

class CountingCache<T> implements Cache<T> {
  setCalls = 0;

  constructor(private readonly inner: Cache<T>) {}

  get(key: string): T | undefined | Promise<T | undefined> {
    return this.inner.get(key);
  }

  set(key: string, value: T): void | Promise<void> {
    this.setCalls += 1;
    return this.inner.set(key, value);
  }
}

describe('SplitPlayerStatsCache', () => {
  it('expires fixture data independently from longer-lived form data', async () => {
    let now = 0;
    const formCache = new TtlCache<PlayerFormStats>(24_000, () => now);
    const fixtureCache = new TtlCache<PlayerFixtureStats>(4_000, () => now);
    const cache = new SplitPlayerStatsCache(formCache, fixtureCache);

    await cache.set('player', stats);
    await expect(cache.get('player')).resolves.toEqual(stats);

    now = 5_000;
    await expect(cache.get('player')).resolves.toBeUndefined();
    await expect(cache.getParts('player')).resolves.toEqual({
      form: expect.objectContaining({
        slug: 'cache-test-player',
        aaL10: { value: 10.5, sampleSize: 10 },
      }),
    });
    expect(formCache.get('player')).toBeDefined();
    expect(fixtureCache.get('player')).toBeUndefined();
  });

  it('treats a cached null fixture as data rather than a cache miss', async () => {
    const cache = new SplitPlayerStatsCache(
      new TtlCache<PlayerFormStats>(24_000),
      new TtlCache<PlayerFixtureStats>(4_000),
    );
    const withoutFixture = { ...stats, nextGame: null };

    await cache.set('player', withoutFixture);

    await expect(cache.get('player')).resolves.toEqual(withoutFixture);
  });

  it('writes only the fixture when the form entry is still valid', async () => {
    let now = 0;
    const formCache = new CountingCache(
      new TtlCache<PlayerFormStats>(24_000, () => now),
    );
    const fixtureCache = new CountingCache(
      new TtlCache<PlayerFixtureStats>(4_000, () => now),
    );
    const cache = new SplitPlayerStatsCache(formCache, fixtureCache);
    await cache.set('player', stats);

    now = 5_000;
    await expect(cache.get('player')).resolves.toBeUndefined();
    const refreshed = {
      ...stats,
      aaL10: { value: 99, sampleSize: 10 },
      nextGame: {
        ...stats.nextGame!,
        cleanSheetProbability: 0.55,
      },
    };
    const stored = await cache.fillMissing('player', refreshed);

    expect(formCache.setCalls).toBe(1);
    expect(fixtureCache.setCalls).toBe(2);
    expect(stored).toEqual({
      ...stats,
      nextGame: refreshed.nextGame,
    });
    await expect(cache.get('player')).resolves.toEqual(stored);
  });

  it('writes only the form when the fixture entry is still valid', async () => {
    let now = 0;
    const formCache = new CountingCache(
      new TtlCache<PlayerFormStats>(4_000, () => now),
    );
    const fixtureCache = new CountingCache(
      new TtlCache<PlayerFixtureStats>(24_000, () => now),
    );
    const cache = new SplitPlayerStatsCache(formCache, fixtureCache);
    await cache.set('player', stats);

    now = 5_000;
    await expect(cache.get('player')).resolves.toBeUndefined();
    const refreshed = {
      ...stats,
      aaL10: { value: 12.5, sampleSize: 10 },
      nextGame: {
        ...stats.nextGame!,
        cleanSheetProbability: 0.9,
      },
    };
    const stored = await cache.fillMissing('player', refreshed);

    expect(formCache.setCalls).toBe(2);
    expect(fixtureCache.setCalls).toBe(1);
    expect(stored).toEqual({
      ...refreshed,
      nextGame: stats.nextGame,
    });
    await expect(cache.get('player')).resolves.toEqual(stored);
  });

  it('migrates a legacy entry once without reviving its stale fixture later', async () => {
    let now = 0;
    const formCache = new TtlCache<PlayerFormStats>(24_000, () => now);
    const fixtureCache = new TtlCache<PlayerFixtureStats>(4_000, () => now);
    const legacyCache = new TtlCache<PlayerStats>(24_000, () => now);
    legacyCache.set('player', stats);
    const cache = new SplitPlayerStatsCache(formCache, fixtureCache, legacyCache);

    await expect(cache.get('player')).resolves.toEqual(stats);

    now = 5_000;
    await expect(cache.get('player')).resolves.toBeUndefined();
    expect(legacyCache.get('player')).toEqual(stats);
  });
});
