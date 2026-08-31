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
  aaL10TeamWinRate: { value: 0.4, sampleSize: 10 },
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

class BatchOnlyCache<T> implements Cache<T> {
  getManyCalls = 0;

  constructor(private readonly values: Map<string, T>) {}

  get(): T | undefined {
    throw new Error('Individual reads must not be used');
  }

  getMany(keys: readonly string[]): Map<string, T> {
    this.getManyCalls += 1;
    return new Map(
      keys.flatMap((key) =>
        this.values.has(key) ? [[key, this.values.get(key)!] as const] : [],
      ),
    );
  }

  set(key: string, value: T): void {
    this.values.set(key, value);
  }
}

describe('SplitPlayerStatsCache', () => {
  it('loads form and canonical fixture entries in two batch reads', async () => {
    const firstKey = 'first-player:Midfielder:no-low';
    const secondKey = 'second-player:Forward:no-low';
    const firstForm = { ...stats, slug: 'first-player', nextGame: undefined };
    const secondForm = { ...stats, slug: 'second-player', nextGame: undefined };
    const {
      nextGame: _firstNextGame,
      pendingRefreshes: _firstPending,
      mlsAaContext: _firstContext,
      ...firstFormStats
    } = firstForm;
    const {
      nextGame: _secondNextGame,
      pendingRefreshes: _secondPending,
      mlsAaContext: _secondContext,
      ...secondFormStats
    } = secondForm;
    const formCache = new BatchOnlyCache<PlayerFormStats>(
      new Map([
        [firstKey, firstFormStats],
        [secondKey, secondFormStats],
      ]),
    );
    const fixtureCache = new BatchOnlyCache<PlayerFixtureStats>(
      new Map([
        ['first-player:auto-v3:no-low', stats.nextGame],
        ['second-player:auto-v3:no-low', stats.nextGame],
      ]),
    );
    const cache = new SplitPlayerStatsCache(formCache, fixtureCache);

    const values = await cache.getPartsMany([firstKey, secondKey]);

    expect(values.get(firstKey)).toEqual({
      form: firstFormStats,
      fixture: stats.nextGame,
    });
    expect(values.get(secondKey)).toEqual({
      form: secondFormStats,
      fixture: stats.nextGame,
    });
    expect(formCache.getManyCalls).toBe(1);
    expect(fixtureCache.getManyCalls).toBe(1);
  });

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

  it('replaces a cached null once an authoritative fixture becomes available', async () => {
    const cache = new SplitPlayerStatsCache(
      new TtlCache<PlayerFormStats>(24_000),
      new TtlCache<PlayerFixtureStats>(4_000),
    );
    await cache.set('player', { ...stats, nextGame: null });

    const resolved = await cache.setFixture('player', stats.nextGame);

    expect(resolved).toEqual(stats.nextGame);
    await expect(cache.get('player')).resolves.toEqual(stats);
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

  it('lazily enriches an old form while preserving historical windows', async () => {
    const formCache = new TtlCache<PlayerFormStats>(24_000);
    const fixtureCache = new TtlCache<PlayerFixtureStats>(24_000);
    const cache = new SplitPlayerStatsCache(formCache, fixtureCache);
    const {
      nextGame,
      aaL10TeamWinRate: _oldWinRate,
      ...oldForm
    } = stats;
    const historical = {
      l10: { value: 0.2, sampleSize: 10 },
      l15: { value: 0.2, sampleSize: 15 },
      l40: { value: 0.2, sampleSize: 40 },
    };
    formCache.set('player', { ...oldForm, historicalAssists: historical });
    fixtureCache.set('player', nextGame);

    const enriched = await cache.fillMissing('player', stats);

    expect(enriched).toMatchObject({
      aaL10TeamWinRate: { value: 0.4, sampleSize: 10 },
      historicalAssists: historical,
    });
    expect(formCache.get('player')).toMatchObject({
      aaL10TeamWinRate: { value: 0.4, sampleSize: 10 },
      historicalAssists: historical,
    });
  });

  it('shares one held fixture across card positions while keeping form values separate', async () => {
    const formCache = new TtlCache<PlayerFormStats>(24_000);
    const fixtureCache = new TtlCache<PlayerFixtureStats>(24_000);
    const cache = new SplitPlayerStatsCache(formCache, fixtureCache);
    const heldFixture: NonNullable<PlayerFixtureStats> = {
      ...stats.nextGame!,
      date: '2026-07-28T18:45:00.000Z',
      cleanSheetProbability: 0.19,
    };
    const nextFixture: NonNullable<PlayerFixtureStats> = {
      ...stats.nextGame!,
      date: '2026-08-01T15:00:00.000Z',
      cleanSheetProbability: 0.35,
    };

    await cache.set('same-player:auto-v3:no-low', {
      ...stats,
      slug: 'same-player',
      aaL10: { value: 9, sampleSize: 10 },
      nextGame: heldFixture,
    });
    const defender = await cache.fillMissing('same-player:Defender:no-low', {
      ...stats,
      slug: 'same-player',
      position: 'Defender',
      aaL10: { value: 17, sampleSize: 10 },
      nextGame: nextFixture,
    });

    expect(defender).toMatchObject({
      position: 'Defender',
      aaL10: { value: 17, sampleSize: 10 },
      nextGame: {
        date: '2026-07-28T18:45:00.000Z',
        cleanSheetProbability: 0.19,
      },
    });
    await expect(
      cache.get('same-player:auto-v3:no-low'),
    ).resolves.toMatchObject({
      aaL10: { value: 9, sampleSize: 10 },
      nextGame: { cleanSheetProbability: 0.19 },
    });
    expect(fixtureCache.get('same-player:Defender:no-low')).toBeUndefined();
    expect(
      fixtureCache.get('same-player:auto-v3:no-low'),
    ).toEqual(heldFixture);
  });

  it('lazily migrates an old position-specific fixture to the canonical player key', async () => {
    const formCache = new TtlCache<PlayerFormStats>(24_000);
    const fixtureCache = new TtlCache<PlayerFixtureStats>(24_000);
    const cache = new SplitPlayerStatsCache(formCache, fixtureCache);
    const key = 'legacy-player:Defender:no-low';
    const legacyFixture: NonNullable<PlayerFixtureStats> = {
      ...stats.nextGame!,
      cleanSheetProbability: 0.27,
    };
    const { nextGame: _nextGame, ...form } = {
      ...stats,
      slug: 'legacy-player',
      position: 'Defender' as const,
    };
    formCache.set(key, form);
    fixtureCache.set(key, legacyFixture);

    await expect(cache.get(key)).resolves.toMatchObject({
      slug: 'legacy-player',
      position: 'Defender',
      nextGame: { cleanSheetProbability: 0.27 },
    });
    expect(
      fixtureCache.get('legacy-player:auto-v3:no-low'),
    ).toEqual(legacyFixture);
  });
});
