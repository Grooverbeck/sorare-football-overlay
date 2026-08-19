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
  getMany?(
    keys: readonly string[],
  ): Map<string, T> | Promise<Map<string, T>>;
  set(key: string, value: T): void | Promise<void>;
  fillMissing?(key: string, value: T): T | Promise<T>;
}

export interface ReadonlyCache<T> {
  get(key: string): T | undefined | Promise<T | undefined>;
  getMany?(
    keys: readonly string[],
  ): Map<string, T> | Promise<Map<string, T>>;
}

const playerPositions = new Set([
  'auto-v3',
  'Goalkeeper',
  'Defender',
  'Midfielder',
  'Forward',
]);
const FORM_HISTORY_REFRESH_LEASE_MS = 60_000;

/**
 * Form values depend on the concrete card position, but a player's next
 * fixture does not. Reuse the existing automatic-position key as the
 * canonical fixture identity so old cache entries migrate without a bulk
 * rewrite.
 */
export function playerFixtureCacheKey(key: string): string {
  const [slug, position, coverage, ...remainder] = key.split(':');
  if (
    remainder.length > 0 ||
    !slug ||
    !position ||
    !coverage ||
    !playerPositions.has(position) ||
    !['no-low', 'all'].includes(coverage)
  ) {
    return key;
  }
  return `${slug}:auto-v3:${coverage}`;
}

export interface SplitPlayerStatsCacheAccess extends Cache<PlayerStats> {
  getParts(key: string): Promise<PlayerStatsCacheParts>;
  getPartsMany(
    keys: readonly string[],
  ): Promise<Map<string, PlayerStatsCacheParts>>;
  setForm(key: string, value: PlayerFormStats): void | Promise<void>;
  claimFormHistoryRefresh(key: string): boolean | Promise<boolean>;
  releaseFormHistoryRefresh(key: string): void | Promise<void>;
  claimFixtureRefresh(value: PlayerFixtureStats): boolean | Promise<boolean>;
  getTeamFixture(
    playerCacheKey: string,
    teamSlug: string,
  ): Promise<PlayerFixtureStats | undefined>;
  setFixture(
    key: string,
    value: PlayerFixtureStats,
  ): PlayerFixtureStats | Promise<PlayerFixtureStats>;
  refreshFixture(
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
    typeof candidate.getPartsMany === 'function' &&
    typeof candidate.setForm === 'function' &&
    typeof candidate.claimFormHistoryRefresh === 'function' &&
    typeof candidate.releaseFormHistoryRefresh === 'function' &&
    typeof candidate.claimFixtureRefresh === 'function' &&
    typeof candidate.getTeamFixture === 'function' &&
    typeof candidate.setFixture === 'function' &&
    typeof candidate.refreshFixture === 'function'
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

  getMany(keys: readonly string[]): Map<string, T> {
    return new Map(
      [...new Set(keys)].flatMap((key) => {
        const value = this.get(key);
        return value === undefined ? [] : [[key, value] as const];
      }),
    );
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
  private readonly formHistoryRefreshLeases = new Map<string, number>();

  constructor(
    private readonly formCache: Cache<PlayerFormStats>,
    private readonly fixtureCache: Cache<PlayerFixtureStats>,
    private readonly legacyCache?: ReadonlyCache<PlayerStats>,
    private readonly now: () => number = Date.now,
  ) {}

  async getParts(key: string): Promise<PlayerStatsCacheParts> {
    const [form, fixture] = await Promise.all([
      this.formCache.get(key),
      this.getFixture(key),
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

  async getPartsMany(
    keys: readonly string[],
  ): Promise<Map<string, PlayerStatsCacheParts>> {
    const uniqueKeys = [...new Set(keys)];
    if (uniqueKeys.length === 0) return new Map();
    const fixtureKeyByPlayer = new Map(
      uniqueKeys.map((key) => [key, playerFixtureCacheKey(key)]),
    );
    const [forms, canonicalFixtures] = await Promise.all([
      this.readMany(this.formCache, uniqueKeys),
      this.readMany(this.fixtureCache, [
        ...new Set(fixtureKeyByPlayer.values()),
      ]),
    ]);

    const fixtureByPlayer = new Map<string, PlayerFixtureStats>();
    for (const key of uniqueKeys) {
      const fixtureKey = fixtureKeyByPlayer.get(key)!;
      if (canonicalFixtures.has(fixtureKey)) {
        fixtureByPlayer.set(key, canonicalFixtures.get(fixtureKey)!);
      }
    }

    // Older split-cache versions stored fixtures under the concrete position.
    // Read only those misses in one batch and lazily migrate any hits.
    const legacyFixtureKeys = uniqueKeys.filter(
      (key) =>
        !fixtureByPlayer.has(key) && fixtureKeyByPlayer.get(key) !== key,
    );
    const legacyFixtures = await this.readMany(
      this.fixtureCache,
      legacyFixtureKeys,
    );
    const fixtureMigrations: Promise<unknown>[] = [];
    for (const key of legacyFixtureKeys) {
      if (!legacyFixtures.has(key)) continue;
      const fixture = legacyFixtures.get(key)!;
      fixtureByPlayer.set(key, fixture);
      const fixtureKey = fixtureKeyByPlayer.get(key)!;
      fixtureMigrations.push(
        Promise.resolve(
          this.fixtureCache.fillMissing
            ? this.fixtureCache.fillMissing(fixtureKey, fixture)
            : this.fixtureCache.set(fixtureKey, fixture),
        ),
      );
    }

    // Consult the combined v1 cache only when neither split part exists,
    // preserving the original migration policy without N+1 reads.
    const legacyCandidates = uniqueKeys.filter(
      (key) => !forms.has(key) && !fixtureByPlayer.has(key),
    );
    const legacyPlayers = this.legacyCache
      ? await this.readMany(this.legacyCache, legacyCandidates)
      : new Map<string, PlayerStats>();
    const legacyMigrations: Promise<unknown>[] = [];
    const result = new Map<string, PlayerStatsCacheParts>();
    for (const key of uniqueKeys) {
      const legacy = legacyPlayers.get(key);
      if (legacy) {
        const {
          nextGame,
          pendingRefreshes: _pendingRefreshes,
          mlsAaContext: _mlsAaContext,
          ...legacyForm
        } = legacy;
        result.set(key, { form: legacyForm, fixture: nextGame });
        legacyMigrations.push(Promise.resolve(this.set(key, legacy)));
        continue;
      }
      const parts: PlayerStatsCacheParts = {};
      if (forms.has(key)) parts.form = forms.get(key)!;
      if (fixtureByPlayer.has(key)) {
        parts.fixture = fixtureByPlayer.get(key)!;
      }
      result.set(key, parts);
    }
    await Promise.all([...fixtureMigrations, ...legacyMigrations]);
    return result;
  }

  async get(key: string): Promise<PlayerStats | undefined> {
    const parts = await this.getParts(key);
    if (parts.form === undefined || parts.fixture === undefined) {
      return undefined;
    }
    return { ...parts.form, nextGame: parts.fixture };
  }

  async claimFixtureRefresh(value: PlayerFixtureStats): Promise<boolean> {
    const refreshable = this.fixtureCache as Cache<PlayerFixtureStats> & {
      claimRefresh?: (
        fixture: PlayerFixtureStats,
      ) => boolean | Promise<boolean>;
    };
    return refreshable.claimRefresh
      ? refreshable.claimRefresh(value)
      : false;
  }

  async claimFormHistoryRefresh(key: string): Promise<boolean> {
    const claimable = this.formCache as Cache<PlayerFormStats> & {
      claimFormHistoryRefresh?: (
        cacheKey: string,
      ) => boolean | Promise<boolean>;
    };
    if (claimable.claimFormHistoryRefresh) {
      return claimable.claimFormHistoryRefresh(key);
    }

    const now = this.now();
    const expiresAt = this.formHistoryRefreshLeases.get(key);
    if (expiresAt !== undefined && expiresAt > now) return false;
    this.formHistoryRefreshLeases.set(
      key,
      now + FORM_HISTORY_REFRESH_LEASE_MS,
    );
    return true;
  }

  async releaseFormHistoryRefresh(key: string): Promise<void> {
    const claimable = this.formCache as Cache<PlayerFormStats> & {
      releaseFormHistoryRefresh?: (
        cacheKey: string,
      ) => void | Promise<void>;
    };
    if (claimable.releaseFormHistoryRefresh) {
      await claimable.releaseFormHistoryRefresh(key);
      return;
    }
    this.formHistoryRefreshLeases.delete(key);
  }

  async setForm(key: string, value: PlayerFormStats): Promise<void> {
    await this.formCache.set(key, value);
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
      this.fixtureCache.set(playerFixtureCacheKey(key), nextGame),
    ]);
  }

  async setFixture(
    key: string,
    value: PlayerFixtureStats,
  ): Promise<PlayerFixtureStats> {
    const existing = await this.getFixture(key);
    const fixtureKey = playerFixtureCacheKey(key);
    if (existing !== undefined) {
      // A negative fixture lookup is not authoritative forever. Once Sorare
      // or the canonical team cache supplies a fixture, replace the cached
      // null instead of hiding that fixture until the negative TTL expires.
      if (existing === null && value !== null) {
        await this.fixtureCache.set(fixtureKey, value);
        return (await this.fixtureCache.get(fixtureKey)) ?? value;
      }
      return existing;
    }
    if (this.fixtureCache.fillMissing) {
      return this.fixtureCache.fillMissing(fixtureKey, value);
    }
    await this.fixtureCache.set(fixtureKey, value);
    return value;
  }

  async getTeamFixture(
    playerCacheKey: string,
    teamSlug: string,
  ): Promise<PlayerFixtureStats | undefined> {
    const teamAware = this.fixtureCache as Cache<PlayerFixtureStats> & {
      getTeamFixture?: (
        cacheKey: string,
        canonicalTeamSlug: string,
      ) => Promise<PlayerFixtureStats | undefined>;
    };
    return teamAware.getTeamFixture
      ? teamAware.getTeamFixture(
          playerFixtureCacheKey(playerCacheKey),
          teamSlug,
        )
      : undefined;
  }

  async refreshFixture(
    key: string,
    value: PlayerFixtureStats,
  ): Promise<PlayerFixtureStats> {
    const fixtureKey = playerFixtureCacheKey(key);
    const refreshable = this.fixtureCache as Cache<PlayerFixtureStats> & {
      refresh?: (
        cacheKey: string,
        fixture: PlayerFixtureStats,
      ) => PlayerFixtureStats | Promise<PlayerFixtureStats>;
    };
    if (refreshable.refresh) {
      return refreshable.refresh(fixtureKey, value);
    }
    await this.fixtureCache.set(fixtureKey, value);
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
      this.getFixture(key),
    ]);
    const writes: Array<void | Promise<void>> = [];
    let resolvedFixture = existingFixture;
    if (existingForm === undefined) writes.push(this.formCache.set(key, form));
    if (existingFixture === undefined) {
      const fixtureKey = playerFixtureCacheKey(key);
      if (this.fixtureCache.fillMissing) {
        resolvedFixture = await this.fixtureCache.fillMissing(
          fixtureKey,
          nextGame,
        );
      } else {
        writes.push(this.fixtureCache.set(fixtureKey, nextGame));
        resolvedFixture = nextGame;
      }
    }
    await Promise.all(writes);
    return {
      ...(existingForm ?? form),
      nextGame: resolvedFixture ?? null,
    };
  }

  private async getFixture(
    key: string,
  ): Promise<PlayerFixtureStats | undefined> {
    const fixtureKey = playerFixtureCacheKey(key);
    const fixture = await this.fixtureCache.get(fixtureKey);
    if (fixture !== undefined || fixtureKey === key) return fixture;

    // One-time lazy migration for fixture entries written by older versions
    // under a concrete position key.
    const legacyFixture = await this.fixtureCache.get(key);
    if (legacyFixture === undefined) return undefined;
    if (this.fixtureCache.fillMissing) {
      return this.fixtureCache.fillMissing(fixtureKey, legacyFixture);
    }
    await this.fixtureCache.set(fixtureKey, legacyFixture);
    return legacyFixture;
  }

  private async readMany<TValue>(
    cache: ReadonlyCache<TValue>,
    keys: readonly string[],
  ): Promise<Map<string, TValue>> {
    const uniqueKeys = [...new Set(keys)];
    if (uniqueKeys.length === 0) return new Map();
    if (cache.getMany) return cache.getMany(uniqueKeys);
    const entries = await Promise.all(
      uniqueKeys.map(async (key) => [key, await cache.get(key)] as const),
    );
    return new Map(
      entries.flatMap(([key, value]) =>
        value === undefined ? [] : ([[key, value]] as const),
      ),
    );
  }
}
