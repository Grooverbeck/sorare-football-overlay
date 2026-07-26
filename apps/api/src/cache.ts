import type { PlayerStats } from '@sorare-overlay/shared';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export type PlayerFormStats = Omit<
  PlayerStats,
  'nextGame' | 'pendingRefreshes' | 'mlsAaContext'
>;
export type PlayerFixtureStats = PlayerStats['nextGame'];

export interface PlayerStatsCacheParts {
  form?: PlayerFormStats;
  fixture?: PlayerFixtureStats;
}

export interface Cache<T> {
  get(key: string): T | undefined | Promise<T | undefined>;
  set(key: string, value: T): void | Promise<void>;
  fillMissing?(key: string, value: T): T | Promise<T>;
}

export interface ReadonlyCache<T> {
  get(key: string): T | undefined | Promise<T | undefined>;
}

export interface SplitPlayerStatsCacheAccess extends Cache<PlayerStats> {
  getParts(key: string): Promise<PlayerStatsCacheParts>;
  setFixture(
    key: string,
    value: PlayerFixtureStats,
  ): PlayerFixtureStats | Promise<PlayerFixtureStats>;
}

export function supportsSplitPlayerStatsCache(
  cache: Cache<PlayerStats>,
): cache is SplitPlayerStatsCacheAccess {
  const candidate = cache as Partial<SplitPlayerStatsCacheAccess>;
  return (
    typeof candidate.getParts === 'function' &&
    typeof candidate.setFixture === 'function'
  );
}

export class TtlCache<T> implements Cache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  fillMissing(key: string, value: T): T {
    const existing = this.get(key);
    if (existing !== undefined) return existing;
    this.set(key, value);
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}

export class SplitPlayerStatsCache implements SplitPlayerStatsCacheAccess {
  constructor(
    private readonly formCache: Cache<PlayerFormStats>,
    private readonly fixtureCache: Cache<PlayerFixtureStats>,
    private readonly legacyCache?: ReadonlyCache<PlayerStats>,
  ) {}

  async getParts(key: string): Promise<PlayerStatsCacheParts> {
    const [form, fixture] = await Promise.all([
      this.formCache.get(key),
      this.fixtureCache.get(key),
    ]);

    // Only consult the old combined cache before either new cache part exists.
    // This migrates existing entries without allowing a 24h legacy fixture to
    // override an intentionally shorter fixture TTL later.
    if (form === undefined && fixture === undefined && this.legacyCache) {
      const legacy = await this.legacyCache.get(key);
      if (legacy) {
        await this.set(key, legacy);
        const {
          nextGame,
          pendingRefreshes: _pendingRefreshes,
          mlsAaContext: _mlsAaContext,
          ...legacyForm
        } = legacy;
        return { form: legacyForm, fixture: nextGame };
      }
    }

    return {
      ...(form !== undefined ? { form } : {}),
      ...(fixture !== undefined ? { fixture } : {}),
    };
  }

  async get(key: string): Promise<PlayerStats | undefined> {
    const parts = await this.getParts(key);
    if (parts.form === undefined || parts.fixture === undefined) {
      return undefined;
    }
    return { ...parts.form, nextGame: parts.fixture };
  }

  async set(key: string, value: PlayerStats): Promise<void> {
    const {
      nextGame,
      pendingRefreshes: _pendingRefreshes,
      mlsAaContext: _mlsAaContext,
      ...form
    } = value;
    await Promise.all([
      this.formCache.set(key, form),
      this.fixtureCache.set(key, nextGame),
    ]);
  }

  async setFixture(
    key: string,
    value: PlayerFixtureStats,
  ): Promise<PlayerFixtureStats> {
    if (this.fixtureCache.fillMissing) {
      return this.fixtureCache.fillMissing(key, value);
    }
    await this.fixtureCache.set(key, value);
    return value;
  }

  async fillMissing(key: string, value: PlayerStats): Promise<PlayerStats> {
    const {
      nextGame,
      pendingRefreshes: _pendingRefreshes,
      mlsAaContext: _mlsAaContext,
      ...form
    } = value;
    const [existingForm, existingFixture] = await Promise.all([
      this.formCache.get(key),
      this.fixtureCache.get(key),
    ]);
    const writes: Array<void | Promise<void>> = [];
    let resolvedFixture = existingFixture;
    if (existingForm === undefined) writes.push(this.formCache.set(key, form));
    if (existingFixture === undefined) {
      if (this.fixtureCache.fillMissing) {
        resolvedFixture = await this.fixtureCache.fillMissing(key, nextGame);
      } else {
        writes.push(this.fixtureCache.set(key, nextGame));
        resolvedFixture = nextGame;
      }
    }
    await Promise.all(writes);
    return {
      ...(existingForm ?? form),
      nextGame: resolvedFixture ?? null,
    };
  }
}
