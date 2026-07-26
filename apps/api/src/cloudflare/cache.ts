import {
  FootballPositionSchema,
  MLS_AA_BENCHMARKS,
  MatchProbabilitiesSchema,
  PlayerStatsSchema,
  type FootballPosition,
  type MatchProbabilities,
  type MlsAaBenchmarkSnapshot,
  type PlayerStats,
} from '@sorare-overlay/shared';
import { z } from 'zod';
import {
  SplitPlayerStatsCache,
  type Cache,
  type PlayerFixtureStats,
  type PlayerFormStats,
  type PlayerStatsCacheParts,
  type ReadonlyCache,
  type SplitPlayerStatsCacheAccess,
} from '../cache.js';
import {
  MarketSnapshotSchema,
  marketFixtureKey,
  normalizeTeamName,
  type MarketSnapshot,
  type MarketSnapshotStore,
  type OddsMarketKey,
} from '../providers/market-odds-provider.js';
import {
  ProviderQuotaUsageSchema,
  type OddsProviderName,
  type ProviderQuotaUsage,
  type ProviderQuotaUsageStore,
} from '../providers/odds-usage.js';
import type {
  PlayerNameResolutionCache,
  SourcePlayerRequest,
} from '../services/data-source.js';
import {
  MlsAaBenchmarkSnapshotSchema,
  type MlsAaBenchmarkStore,
} from '../services/mls-aa-benchmark.js';

const SourcePlayerRequestSchema = z.object({
  slug: z.string().trim().min(1).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i),
  position: FootballPositionSchema.optional(),
});

const NameResolutionEnvelopeSchema = z.discriminatedUnion('found', [
  z.object({ found: z.literal(true), value: SourcePlayerRequestSchema }),
  z.object({ found: z.literal(false) }),
]);

const PlayerFormStatsSchema = PlayerStatsSchema.omit({
  nextGame: true,
  pendingRefreshes: true,
  mlsAaContext: true,
});
// v3 adds the Sorare competition slug used to route bookmaker requests only
// to explicitly supported competitions. Older fixtures refresh lazily.
const PLAYER_FIXTURE_CACHE_POLICY_VERSION = 3;
const PlayerFixtureEnvelopeSchema = z.object({
  nextGame: PlayerStatsSchema.shape.nextGame,
  cachePolicyVersion: z
    .literal(PLAYER_FIXTURE_CACHE_POLICY_VERSION)
    .optional(),
});
const FixtureTeamOddsSchema = z.object({
  cleanSheetProbability: z.number().min(0).max(1).nullable(),
  matchProbabilities: MatchProbabilitiesSchema.nullable(),
});

type FixtureTeamOdds = z.infer<typeof FixtureTeamOddsSchema>;
type FixtureTeamSide = 'home' | 'away';

export interface JsonKeyValueStore {
  get<T = unknown>(key: string, type: 'json'): Promise<T | null>;
  put(
    key: string,
    value: string,
    options?: { expiration?: number; expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase();
}

abstract class CloudflareKvCache {
  constructor(
    protected readonly namespace: JsonKeyValueStore,
    protected readonly context: ExecutionContext,
  ) {}

  protected removeInvalid(key: string): void {
    this.context.waitUntil(this.namespace.delete(key));
  }

  protected persist(key: string, value: unknown, ttlSeconds: number): void {
    this.context.waitUntil(
      this.namespace.put(key, JSON.stringify(value), {
        expirationTtl: ttlSeconds,
      }),
    );
  }

  protected persistUntil(
    key: string,
    value: unknown,
    expiration: number,
  ): void {
    this.context.waitUntil(
      this.namespace.put(key, JSON.stringify(value), { expiration }),
    );
  }
}

const MONDAY_UTC = 1;
const WEEKLY_FORM_REFRESH_HOUR_UTC = 10;
const FIXTURE_ROLLOVER_HOUR_UTC = 8;
const FIXTURE_MINIMUM_POST_KICKOFF_SECONDS = 6 * 60 * 60;

export function nextMondayFormExpiration(
  nowMs: number,
  maximumTtlSeconds: number,
): number {
  const now = new Date(nowMs);
  const target = new Date(nowMs);
  target.setUTCHours(WEEKLY_FORM_REFRESH_HOUR_UTC, 0, 0, 0);
  const daysUntilMonday = (MONDAY_UTC - now.getUTCDay() + 7) % 7;
  target.setUTCDate(target.getUTCDate() + daysUntilMonday);
  if (target.getTime() <= nowMs + 60_000) {
    target.setUTCDate(target.getUTCDate() + 7);
  }
  const boundedTarget = Math.min(
    target.getTime(),
    nowMs + maximumTtlSeconds * 1_000,
  );
  return Math.floor(boundedTarget / 1_000);
}

export function fixtureTeamOddsExpiration(
  fixtureDate: string,
  minimumTtlSeconds: number,
  nowMs: number = Date.now(),
): number {
  const minimumExpiration = Math.floor(nowMs / 1_000) + minimumTtlSeconds;
  const fixtureExpiration = fixtureRolloverExpiration(fixtureDate);
  return fixtureExpiration === null
    ? minimumExpiration
    : Math.max(minimumExpiration, fixtureExpiration);
}

export function playerFixtureExpiration(
  fixtureDate: string | null,
  minimumTtlSeconds: number,
  nowMs: number = Date.now(),
): number {
  const minimumExpiration = Math.floor(nowMs / 1_000) + minimumTtlSeconds;
  if (fixtureDate === null) return minimumExpiration;
  const fixtureExpiration = fixtureRolloverExpiration(fixtureDate);
  return fixtureExpiration === null
    ? minimumExpiration
    : Math.max(minimumExpiration, fixtureExpiration);
}

function fixtureRolloverExpiration(fixtureDate: string): number | null {
  const kickoffMs = Date.parse(fixtureDate);
  if (!Number.isFinite(kickoffMs)) return null;

  const kickoff = new Date(kickoffMs);
  const nextDayMorningMs = Date.UTC(
    kickoff.getUTCFullYear(),
    kickoff.getUTCMonth(),
    kickoff.getUTCDate() + 1,
    FIXTURE_ROLLOVER_HOUR_UTC,
  );
  const safelyAfterKickoffMs =
    kickoffMs + FIXTURE_MINIMUM_POST_KICKOFF_SECONDS * 1_000;

  return Math.floor(Math.max(nextDayMorningMs, safelyAfterKickoffMs) / 1_000);
}

function hasFixtureTeamOdds(value: FixtureTeamOdds): boolean {
  const match = value.matchProbabilities;
  return (
    value.cleanSheetProbability !== null ||
    (match !== null &&
      [match.win, match.draw, match.loss].some(
        (probability) => probability !== null,
      ))
  );
}

function needsFixtureTeamOddsFallback(value: FixtureTeamOdds): boolean {
  const match = value.matchProbabilities;
  return (
    value.cleanSheetProbability === null ||
    match === null ||
    [match.win, match.draw, match.loss].some(
      (probability) => probability === null,
    )
  );
}

function mergeMatchProbabilities(
  primary: MatchProbabilities | null,
  fallback: MatchProbabilities | null,
): MatchProbabilities | null {
  if (primary === null) return fallback;
  if (fallback === null) return primary;
  return {
    win: primary.win ?? fallback.win,
    draw: primary.draw ?? fallback.draw,
    loss: primary.loss ?? fallback.loss,
  };
}

function mergeFixtureTeamOdds(
  primary: FixtureTeamOdds,
  fallback: FixtureTeamOdds | null,
): FixtureTeamOdds {
  if (fallback === null) return primary;
  return {
    cleanSheetProbability:
      primary.cleanSheetProbability ?? fallback.cleanSheetProbability,
    matchProbabilities: mergeMatchProbabilities(
      primary.matchProbabilities,
      fallback.matchProbabilities,
    ),
  };
}

function fixtureTeamOddsFrom(
  fixture: NonNullable<PlayerFixtureStats>,
): FixtureTeamOdds {
  return {
    cleanSheetProbability: fixture.cleanSheetProbability,
    matchProbabilities: fixture.matchProbabilities,
  };
}

function fixtureTeamSide(
  fixture: NonNullable<PlayerFixtureStats>,
): FixtureTeamSide | null {
  if (
    !fixture.homeTeamName ||
    !fixture.awayTeamName ||
    !fixture.playerTeamName
  ) {
    return null;
  }
  const playerTeam = normalizeTeamName(fixture.playerTeamName);
  if (playerTeam === normalizeTeamName(fixture.homeTeamName)) return 'home';
  if (playerTeam === normalizeTeamName(fixture.awayTeamName)) return 'away';
  return null;
}

function samePlayerFixture(
  left: NonNullable<PlayerFixtureStats>,
  right: NonNullable<PlayerFixtureStats>,
): boolean {
  if (
    !left.homeTeamName ||
    !left.awayTeamName ||
    !left.playerTeamName ||
    !right.homeTeamName ||
    !right.awayTeamName ||
    !right.playerTeamName
  ) {
    return false;
  }
  const leftKickoff = Date.parse(left.date);
  const rightKickoff = Date.parse(right.date);
  if (
    !Number.isFinite(leftKickoff) ||
    !Number.isFinite(rightKickoff) ||
    leftKickoff !== rightKickoff ||
    normalizeTeamName(left.playerTeamName) !==
      normalizeTeamName(right.playerTeamName)
  ) {
    return false;
  }
  const leftTeams = [left.homeTeamName, left.awayTeamName]
    .map(normalizeTeamName)
    .sort();
  const rightTeams = [right.homeTeamName, right.awayTeamName]
    .map(normalizeTeamName)
    .sort();
  return leftTeams[0] === rightTeams[0] && leftTeams[1] === rightTeams[1];
}

export function fixtureTeamOddsKey(
  fixture: NonNullable<PlayerFixtureStats>,
): string | null {
  const fixtureKey = marketFixtureKey(fixture);
  const side = fixtureTeamSide(fixture);
  if (!fixtureKey || !side) return null;
  return `fixture-team-odds:v1:${encodeURIComponent(fixtureKey)}:${side}`;
}

function withFixtureTeamOdds(
  fixture: NonNullable<PlayerFixtureStats>,
  odds: FixtureTeamOdds,
): NonNullable<PlayerFixtureStats> {
  return {
    ...fixture,
    cleanSheetProbability: odds.cleanSheetProbability,
    matchProbabilities: odds.matchProbabilities,
  };
}

function legacyAutomaticPositionKey(key: string): string | null {
  const [slug, position, coverage, ...remainder] = key.split(':');
  if (
    remainder.length > 0 ||
    !slug ||
    !position ||
    !coverage ||
    position === 'auto-v3' ||
    !['Goalkeeper', 'Defender', 'Midfielder', 'Forward'].includes(position) ||
    !['no-low', 'all'].includes(coverage)
  ) {
    return null;
  }
  return `${slug}:auto-v3:${coverage}`;
}

export class CloudflareMarketSnapshotStore
  extends CloudflareKvCache
  implements MarketSnapshotStore
{
  constructor(
    namespace: JsonKeyValueStore,
    private readonly missTtlSeconds: number,
    context: ExecutionContext,
  ) {
    super(namespace, context);
  }

  async get(
    fixtureKey: string,
    market: OddsMarketKey,
  ): Promise<MarketSnapshot | undefined> {
    const key = this.key(fixtureKey, market);
    const raw = await this.namespace.get<unknown>(key, 'json');
    if (raw === null) return undefined;
    const parsed = MarketSnapshotSchema.safeParse(raw);
    if (!parsed.success) {
      this.removeInvalid(key);
      return undefined;
    }
    return parsed.data;
  }

  async set(fixtureKey: string, snapshot: MarketSnapshot): Promise<void> {
    const key = this.key(fixtureKey, snapshot.market);
    const value = JSON.stringify(MarketSnapshotSchema.parse(snapshot));
    if (snapshot.status === 'available') {
      // A successful pre-match market capture is immutable by design. This
      // avoids paid API re-fetches and keeps every user on the same snapshot.
      await this.namespace.put(key, value);
      return;
    }
    if (snapshot.expiresAt) {
      await this.namespace.put(key, value, {
        expiration: Math.floor(Date.parse(snapshot.expiresAt) / 1_000),
      });
      return;
    }
    await this.namespace.put(key, value, {
      expirationTtl: this.missTtlSeconds,
    });
  }

  private key(fixtureKey: string, market: OddsMarketKey): string {
    return `market-odds:v1:${encodeURIComponent(fixtureKey)}:${market}`;
  }
}

export class CloudflareProviderQuotaUsageStore
  implements ProviderQuotaUsageStore
{
  constructor(private readonly namespace: JsonKeyValueStore) {}

  async get(
    provider: OddsProviderName,
  ): Promise<ProviderQuotaUsage | undefined> {
    const key = this.key(provider);
    const raw = await this.namespace.get<unknown>(key, 'json');
    if (raw === null) return undefined;
    const parsed = ProviderQuotaUsageSchema.safeParse(raw);
    if (!parsed.success) {
      await this.namespace.delete(key);
      return undefined;
    }
    return parsed.data;
  }

  async set(usage: ProviderQuotaUsage): Promise<void> {
    const value = ProviderQuotaUsageSchema.parse(usage);
    await this.namespace.put(
      this.key(value.provider),
      JSON.stringify(value),
    );
  }

  private key(provider: OddsProviderName): string {
    return `odds-provider-usage:v1:${provider}`;
  }
}

class CloudflarePlayerFormCache
  extends CloudflareKvCache
  implements Cache<PlayerFormStats>
{
  constructor(
    namespace: JsonKeyValueStore,
    private readonly ttlSeconds: number,
    context: ExecutionContext,
    private readonly now: () => number = Date.now,
  ) {
    super(namespace, context);
  }

  async get(key: string): Promise<PlayerFormStats | undefined> {
    const cacheKey = `player-form:v1:${key}`;
    const raw = await this.namespace.get<unknown>(cacheKey, 'json');
    if (raw === null) return undefined;
    const parsed = PlayerFormStatsSchema.safeParse(raw);
    if (!parsed.success) {
      this.removeInvalid(cacheKey);
      return undefined;
    }
    return parsed.data;
  }

  set(key: string, value: PlayerFormStats): void {
    this.persistUntil(
      `player-form:v1:${key}`,
      PlayerFormStatsSchema.parse(value),
      nextMondayFormExpiration(this.now(), this.ttlSeconds),
    );
  }
}

class CloudflarePlayerFixtureCache
  extends CloudflareKvCache
  implements Cache<PlayerFixtureStats>
{
  constructor(
    namespace: JsonKeyValueStore,
    private readonly ttlSeconds: number,
    context: ExecutionContext,
    private readonly now: () => number = Date.now,
  ) {
    super(namespace, context);
  }

  async get(key: string): Promise<PlayerFixtureStats | undefined> {
    const fixture = await this.readPlayerFixture(key);
    if (fixture === undefined || fixture === null) return fixture;
    return this.resolveFixtureTeamOdds(key, fixture);
  }

  async set(key: string, value: PlayerFixtureStats): Promise<void> {
    const resolved =
      value === null ? null : await this.resolveFixtureTeamOdds(key, value);
    this.persistUntil(
      `player-fixture:v1:${key}`,
      PlayerFixtureEnvelopeSchema.parse({
        nextGame: resolved,
        cachePolicyVersion: PLAYER_FIXTURE_CACHE_POLICY_VERSION,
      }),
      playerFixtureExpiration(
        resolved?.date ?? null,
        this.ttlSeconds,
        this.now(),
      ),
    );
  }

  async fillMissing(
    key: string,
    value: PlayerFixtureStats,
  ): Promise<PlayerFixtureStats> {
    const existing = await this.get(key);
    if (existing !== undefined) return existing;
    const resolved =
      value === null ? null : await this.resolveFixtureTeamOdds(key, value);
    this.persistUntil(
      `player-fixture:v1:${key}`,
      PlayerFixtureEnvelopeSchema.parse({
        nextGame: resolved,
        cachePolicyVersion: PLAYER_FIXTURE_CACHE_POLICY_VERSION,
      }),
      playerFixtureExpiration(
        resolved?.date ?? null,
        this.ttlSeconds,
        this.now(),
      ),
    );
    return resolved;
  }

  private async readPlayerFixture(
    key: string,
  ): Promise<PlayerFixtureStats | undefined> {
    const cacheKey = `player-fixture:v1:${key}`;
    const raw = await this.namespace.get<unknown>(cacheKey, 'json');
    if (raw === null) return undefined;
    const parsed = PlayerFixtureEnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      this.removeInvalid(cacheKey);
      return undefined;
    }
    const fixture = parsed.data.nextGame;
    if (
      fixture &&
      (!Object.hasOwn(fixture, 'homeTeamName') ||
        !Object.hasOwn(fixture, 'awayTeamName') ||
        !Object.hasOwn(fixture, 'playerTeamName') ||
        !Object.hasOwn(fixture, 'opponentTeamName'))
    ) {
      // Lazily refresh older v1 fixtures only when that player is requested.
      // Keeping the key avoids a bulk migration and duplicate KV populations.
      return undefined;
    }
    if (
      parsed.data.cachePolicyVersion !== PLAYER_FIXTURE_CACHE_POLICY_VERSION
    ) {
      this.persistUntil(
        cacheKey,
        PlayerFixtureEnvelopeSchema.parse({
          nextGame: fixture,
          cachePolicyVersion: PLAYER_FIXTURE_CACHE_POLICY_VERSION,
        }),
        playerFixtureExpiration(
          fixture?.date ?? null,
          this.ttlSeconds,
          this.now(),
        ),
      );
    }
    return fixture;
  }

  private async resolveFixtureTeamOdds(
    playerCacheKey: string,
    fixture: NonNullable<PlayerFixtureStats>,
  ): Promise<NonNullable<PlayerFixtureStats>> {
    const shared = await this.readFixtureTeamOdds(fixture);
    let resolvedOdds = mergeFixtureTeamOdds(
      fixtureTeamOddsFrom(fixture),
      shared,
    );

    if (needsFixtureTeamOddsFallback(resolvedOdds)) {
      const legacyKey = legacyAutomaticPositionKey(playerCacheKey);
      const legacyFixture = legacyKey
        ? await this.readPlayerFixture(legacyKey)
        : undefined;
      if (
        legacyFixture &&
        samePlayerFixture(legacyFixture, fixture)
      ) {
        resolvedOdds = mergeFixtureTeamOdds(
          resolvedOdds,
          fixtureTeamOddsFrom(legacyFixture),
        );
      }
    }

    if (hasFixtureTeamOdds(resolvedOdds)) {
      await this.rememberFixtureTeamOdds(fixture, resolvedOdds);
    }
    return withFixtureTeamOdds(fixture, resolvedOdds);
  }

  private async readFixtureTeamOdds(
    fixture: NonNullable<PlayerFixtureStats>,
  ): Promise<FixtureTeamOdds | null> {
    const key = fixtureTeamOddsKey(fixture);
    if (!key) return null;
    const raw = await this.namespace.get<unknown>(key, 'json');
    if (raw === null) return null;
    const parsed = FixtureTeamOddsSchema.safeParse(raw);
    if (!parsed.success) {
      this.removeInvalid(key);
      return null;
    }
    return parsed.data;
  }

  private async rememberFixtureTeamOdds(
    fixture: NonNullable<PlayerFixtureStats>,
    incoming: FixtureTeamOdds,
  ): Promise<void> {
    const key = fixtureTeamOddsKey(fixture);
    if (!key || !hasFixtureTeamOdds(incoming)) return;
    const existing = await this.readFixtureTeamOdds(fixture);
    const merged = mergeFixtureTeamOdds(incoming, existing);
    if (
      existing &&
      existing.cleanSheetProbability === merged.cleanSheetProbability &&
      existing.matchProbabilities?.win === merged.matchProbabilities?.win &&
      existing.matchProbabilities?.draw === merged.matchProbabilities?.draw &&
      existing.matchProbabilities?.loss === merged.matchProbabilities?.loss
    ) {
      return;
    }
    this.persistUntil(
      key,
      FixtureTeamOddsSchema.parse(merged),
      fixtureTeamOddsExpiration(
        fixture.date,
        this.ttlSeconds,
        this.now(),
      ),
    );
  }
}

class CloudflareLegacyPlayerStatsCache
  extends CloudflareKvCache
  implements ReadonlyCache<PlayerStats>
{
  async get(key: string): Promise<PlayerStats | undefined> {
    const cacheKey = `player-stats:v1:${key}`;
    const raw = await this.namespace.get<unknown>(cacheKey, 'json');
    if (raw === null) return undefined;
    const parsed = PlayerStatsSchema.safeParse(raw);
    if (!parsed.success) {
      this.removeInvalid(cacheKey);
      return undefined;
    }
    return parsed.data;
  }
}

export class CloudflarePlayerStatsCache
  implements SplitPlayerStatsCacheAccess
{
  private readonly splitCache: SplitPlayerStatsCache;

  constructor(
    namespace: JsonKeyValueStore,
    formTtlSeconds: number,
    fixtureTtlSeconds: number,
    context: ExecutionContext,
    now: () => number = Date.now,
  ) {
    this.splitCache = new SplitPlayerStatsCache(
      new CloudflarePlayerFormCache(namespace, formTtlSeconds, context, now),
      new CloudflarePlayerFixtureCache(
        namespace,
        fixtureTtlSeconds,
        context,
        now,
      ),
      new CloudflareLegacyPlayerStatsCache(namespace, context),
    );
  }

  get(key: string): Promise<PlayerStats | undefined> {
    return this.splitCache.get(key);
  }

  getParts(key: string): Promise<PlayerStatsCacheParts> {
    return this.splitCache.getParts(key);
  }

  set(key: string, value: PlayerStats): Promise<void> {
    return this.splitCache.set(key, value);
  }

  fillMissing(key: string, value: PlayerStats): Promise<PlayerStats> {
    return this.splitCache.fillMissing(key, value);
  }

  setFixture(
    key: string,
    value: PlayerFixtureStats,
  ): PlayerFixtureStats | Promise<PlayerFixtureStats> {
    return this.splitCache.setFixture(key, value);
  }
}

export class CloudflareMlsAaBenchmarkStore
  implements MlsAaBenchmarkStore
{
  private static readonly key = 'mls-aa-benchmark:v1';
  private readonly fallback = MlsAaBenchmarkSnapshotSchema.parse(
    MLS_AA_BENCHMARKS,
  );

  constructor(private readonly namespace: JsonKeyValueStore) {}

  async get(): Promise<MlsAaBenchmarkSnapshot> {
    const raw = await this.namespace.get<unknown>(
      CloudflareMlsAaBenchmarkStore.key,
      'json',
    );
    if (raw === null) return this.fallback;
    const parsed = MlsAaBenchmarkSnapshotSchema.safeParse(raw);
    if (!parsed.success) {
      await this.namespace.delete(CloudflareMlsAaBenchmarkStore.key);
      return this.fallback;
    }
    return parsed.data;
  }

  async set(snapshot: MlsAaBenchmarkSnapshot): Promise<void> {
    await this.namespace.put(
      CloudflareMlsAaBenchmarkStore.key,
      JSON.stringify(MlsAaBenchmarkSnapshotSchema.parse(snapshot)),
    );
  }
}

export class CloudflareNameResolutionCache
  extends CloudflareKvCache
  implements PlayerNameResolutionCache
{
  constructor(
    namespace: JsonKeyValueStore,
    private readonly positiveTtlSeconds: number,
    private readonly negativeTtlSeconds: number,
    context: ExecutionContext,
  ) {
    super(namespace, context);
  }

  async get(
    name: string,
    position: FootballPosition | undefined,
  ): Promise<SourcePlayerRequest | null | undefined> {
    const cacheKey = this.key(name, position);
    const raw = await this.namespace.get<unknown>(cacheKey, 'json');
    if (raw === null) return undefined;
    const parsed = NameResolutionEnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      this.removeInvalid(cacheKey);
      return undefined;
    }
    if (!parsed.data.found) return null;
    return parsed.data.value.position
      ? { slug: parsed.data.value.slug, position: parsed.data.value.position }
      : { slug: parsed.data.value.slug };
  }

  set(
    name: string,
    position: FootballPosition | undefined,
    value: SourcePlayerRequest | null,
  ): void {
    const envelope = value
      ? { found: true as const, value: SourcePlayerRequestSchema.parse(value) }
      : { found: false as const };
    this.persist(
      this.key(name, position),
      envelope,
      value ? this.positiveTtlSeconds : this.negativeTtlSeconds,
    );
  }

  private key(name: string, position: FootballPosition | undefined): string {
    return `player-name:v2:${encodeURIComponent(normalizeName(name))}:${position ?? 'any'}`;
  }
}
