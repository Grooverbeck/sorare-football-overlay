import type { PlayerStats } from '@sorare-overlay/shared';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export type PlayerFormStats = Omit<PlayerStats, 'nextGame'>;
export type PlayerFixtureStats = PlayerStats['nextGame'];

export interface Cache<T> {
  get(key: string): T | undefined | Promise<T | undefined>;
  set(key: string, value: T): void | Promise<void>;
  fillMissing?(key: string, value: T): T | Promise<T>;
}

export interface ReadonlyCache<T> {
  get(key: string): T | undefined | Promise<T | undefined>;
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

export class SplitPlayerStatsCache implements Cache<PlayerStats> {
  constructor(
    private readonly formCache: Cache<PlayerFormStats>,
    private readonly fixtureCache: Cache<PlayerFixtureStats>,
    private readonly legacyCache?: ReadonlyCache<PlayerStats>,
  ) {}

  async get(key: string): Promise<PlayerStats | undefined> {
    const [form, fixture] = await Promise.all([
      this.formCache.get(key),
      this.fixtureCache.get(key),
    ]);

    if (form !== undefined && fixture !== undefined) {
      return { ...form, nextGame: fixture };
    }

    // Only consult the old combined cache before either new cache part exists.
    // This migrates existing entries without allowing a 24h legacy fixture to
    // override an intentionally shorter fixture TTL later.
    if (form === undefined && fixture === undefined && this.legacyCache) {
      const legacy = await this.legacyCache.get(key);
      if (legacy) {
        await this.set(key, legacy);
        return legacy;
      }
    }

    return undefined;
  }

  async set(key: string, value: PlayerStats): Promise<void> {
    const { nextGame, ...form } = value;
    await Promise.all([
      this.formCache.set(key, form),
      this.fixtureCache.set(key, nextGame),
    ]);
  }

  async fillMissing(key: string, value: PlayerStats): Promise<PlayerStats> {
    const { nextGame, ...form } = value;
    const [existingForm, existingFixture] = await Promise.all([
      this.formCache.get(key),
      this.fixtureCache.get(key),
    ]);
    const writes: Array<void | Promise<void>> = [];
    if (existingForm === undefined) writes.push(this.formCache.set(key, form));
    if (existingFixture === undefined) {
      writes.push(this.fixtureCache.set(key, nextGame));
    }
    await Promise.all(writes);
    return {
      ...(existingForm ?? form),
      nextGame: existingFixture === undefined ? nextGame : existingFixture,
    };
  }
}
