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
  MarketSupplementBatchSchema,
  MarketSnapshotSchema,
  marketFixtureKey,
  mergeSupplementBatch,
  normalizeTeamName,
  type MarketSupplementBatch,
  type MarketSupplementPlayer,
  type MarketSnapshot,
  type MarketSnapshotStore,
  type OddsMarketKey,
} from '../providers/market-odds-provider.js';
import {
  MatchOddsSnapshotSchema,
  type MatchOddsSnapshot,
  type MatchOddsSnapshotStore,
} from '../providers/match-odds-provider.js';
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
  playerTeamFixtureIdentity,
  sameFixtureIdentity,
} from '../services/fixture-identity.js';
import {
  MlsAaBenchmarkSnapshotSchema,
  type MlsAaBenchmarkStore,
} from '../services/mls-aa-benchmark.js';

const SourcePlayerRequestSchema = z.object({
  slug: z.string().trim().min(1).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i),
  position: FootballPositionSchema.optional(),
  teamSlug: z.string().trim().min(1).max(180).optional(),
  nameResolution: z.enum(['direct', 'search']).optional(),
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
  putIfAbsent?(
    key: string,
    value: string,
    options?: { expiration?: number; expirationTtl?: number },
  ): Promise<boolean>;
  putEarlierFixture?(
    key: string,
    value: string,
    options?: { expiration?: number; expirationTtl?: number },
  ): Promise<void>;
  /**
   * D1 can merge the short-lived bookmaker supplement queue in one SQL
   * statement. Keeping this optional preserves the KV/in-memory fallback,
   * while preventing concurrent Worker isolates from overwriting players.
   */
  mergeMarketSupplementBatch?(
    key: string,
    playersJson: string,
    queuedAt: string,
    readyAt: string,
    expirationTtl: number,
  ): Promise<string>;
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
const HOUR_MS = 60 * 60 * 1_000;
const FORM_HISTORY_REFRESH_LEASE_SECONDS = 60;
const FORM_HISTORY_REFRESH_LEASE_PREFIX =
  'player-form-history-refresh:v1:';
const FIXTURE_ODDS_REFRESH_LEASE_SECONDS = 15 * 60;
const FIXTURE_ODDS_CHECK_PREFIX = 'sorare-fixture-odds-check:v1:';
const PLAYER_TEAM_FIXTURE_PREFIX = 'player-team-fixture:v1:';
const PLAYER_TEAM_FIXTURE_SLUG_PREFIX = 'player-team-fixture:v2:';

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
  if (fixtureExpiration === null) return minimumExpiration;

  const kickoffMs = Date.parse(fixtureDate);
  const nowSeconds = Math.floor(nowMs / 1_000);
  // Once a match has started, do not let a new minimum TTL extend the held
  // fixture beyond the configured morning rollover.
  if (
    Number.isFinite(kickoffMs) &&
    kickoffMs <= nowMs &&
    fixtureExpiration > nowSeconds
  ) {
    return fixtureExpiration;
  }
  return Math.max(minimumExpiration, fixtureExpiration);
}

export function fixtureOddsRefreshIntervalMs(
  millisecondsUntilKickoff: number,
): number {
  if (millisecondsUntilKickoff <= 24 * HOUR_MS) return 2 * HOUR_MS;
  if (millisecondsUntilKickoff <= 72 * HOUR_MS) return 6 * HOUR_MS;
  return 12 * HOUR_MS;
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

function playerTeamFixtureSlugKey(teamSlug: string): string {
  return `${PLAYER_TEAM_FIXTURE_SLUG_PREFIX}${encodeURIComponent(
    teamSlug.trim().toLowerCase(),
  )}`;
}

function playerTeamFixtureLegacyKey(
  fixture: NonNullable<PlayerFixtureStats>,
): string | null {
  const team = playerTeamFixtureIdentity(fixture);
  return team
    ? `${PLAYER_TEAM_FIXTURE_PREFIX}${encodeURIComponent(team)}`
    : null;
}

function playerTeamFixtureKey(
  fixture: NonNullable<PlayerFixtureStats>,
): string | null {
  return fixture.playerTeamSlug
    ? playerTeamFixtureSlugKey(fixture.playerTeamSlug)
    : playerTeamFixtureLegacyKey(fixture);
}

function teamFixtureEnvelope(
  fixture: NonNullable<PlayerFixtureStats>,
): z.infer<typeof PlayerFixtureEnvelopeSchema> {
  const { marketOdds: _marketOdds, ...identity } = fixture;
  return PlayerFixtureEnvelopeSchema.parse({
    nextGame: {
      ...identity,
      // CS and H-D-A live in the fixture/team-side odds cache. Keeping them
      // out of this shared identity row also prevents concurrent teammate
      // writes from leaking stale values into one another.
      cleanSheetProbability: null,
      matchProbabilities: null,
    },
    cachePolicyVersion: PLAYER_FIXTURE_CACHE_POLICY_VERSION,
  });
}

export function fixtureTeamOddsKey(
  fixture: NonNullable<PlayerFixtureStats>,
): string | null {
  const fixtureKey = marketFixtureKey(fixture);
  const side = fixtureTeamSide(fixture);
  if (!fixtureKey || !side) return null;
  return `fixture-team-odds:v1:${encodeURIComponent(fixtureKey)}:${side}`;
}

function fixtureOddsCheckKey(
  fixture: NonNullable<PlayerFixtureStats>,
): string | null {
  const teamOddsKey = fixtureTeamOddsKey(fixture);
  return teamOddsKey
    ? `${FIXTURE_ODDS_CHECK_PREFIX}${encodeURIComponent(teamOddsKey)}`
    : null;
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

  async claimRefreshLease(
    fixtureKey: string,
    requestGroup: string,
    ttlMs: number,
  ): Promise<boolean> {
    if (!this.namespace.putIfAbsent) return true;
    return this.namespace.putIfAbsent(
      this.refreshLeaseKey(fixtureKey, requestGroup),
      JSON.stringify({ claimedAt: new Date().toISOString() }),
      { expirationTtl: Math.max(1, Math.ceil(ttlMs / 1_000)) },
    );
  }

  async releaseRefreshLease(
    fixtureKey: string,
    requestGroup: string,
  ): Promise<void> {
    await this.namespace.delete(
      this.refreshLeaseKey(fixtureKey, requestGroup),
    );
  }

  async enqueueSupplementPlayers(
    fixtureKey: string,
    requestGroup: string,
    players: readonly MarketSupplementPlayer[],
    delayMs: number,
    ttlMs: number,
  ): Promise<MarketSupplementBatch> {
    const key = this.supplementBatchKey(fixtureKey, requestGroup);
    const now = Date.now();
    const created = mergeSupplementBatch(undefined, players, now, delayMs);
    const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1_000));
    if (this.namespace.mergeMarketSupplementBatch) {
      const raw = await this.namespace.mergeMarketSupplementBatch(
        key,
        JSON.stringify(created.players),
        created.queuedAt,
        created.readyAt,
        ttlSeconds,
      );
      const parsed = MarketSupplementBatchSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    }
    if (this.namespace.putIfAbsent) {
      const inserted = await this.namespace.putIfAbsent(
        key,
        JSON.stringify(created),
        { expirationTtl: ttlSeconds },
      );
      if (inserted) return created;
    }

    const raw = await this.namespace.get<unknown>(key, 'json');
    const existing = MarketSupplementBatchSchema.safeParse(raw);
    const merged = mergeSupplementBatch(
      existing.success ? existing.data : undefined,
      players,
      now,
      delayMs,
    );
    await this.namespace.put(key, JSON.stringify(merged), {
      expirationTtl: ttlSeconds,
    });
    return merged;
  }

  async getSupplementBatch(
    fixtureKey: string,
    requestGroup: string,
  ): Promise<MarketSupplementBatch | undefined> {
    const key = this.supplementBatchKey(fixtureKey, requestGroup);
    const raw = await this.namespace.get<unknown>(key, 'json');
    if (raw === null) return undefined;
    const parsed = MarketSupplementBatchSchema.safeParse(raw);
    if (!parsed.success) {
      await this.namespace.delete(key);
      return undefined;
    }
    return parsed.data;
  }

  async clearSupplementBatch(
    fixtureKey: string,
    requestGroup: string,
  ): Promise<void> {
    await this.namespace.delete(
      this.supplementBatchKey(fixtureKey, requestGroup),
    );
  }

  private key(fixtureKey: string, market: OddsMarketKey): string {
    return `market-odds:v1:${encodeURIComponent(fixtureKey)}:${market}`;
  }

  private refreshLeaseKey(
    fixtureKey: string,
    requestGroup: string,
  ): string {
    return `market-odds-refresh-lease:v1:${encodeURIComponent(
      requestGroup,
    )}:${encodeURIComponent(fixtureKey)}`;
  }

  private supplementBatchKey(
    fixtureKey: string,
    requestGroup: string,
  ): string {
    return `market-odds-supplement-batch:v1:${encodeURIComponent(
      requestGroup,
    )}:${encodeURIComponent(fixtureKey)}`;
  }
}

export class CloudflareMatchOddsSnapshotStore
  implements MatchOddsSnapshotStore
{
  constructor(private readonly namespace: JsonKeyValueStore) {}

  async get(fixtureKey: string): Promise<MatchOddsSnapshot | undefined> {
    const key = this.key(fixtureKey);
    const raw = await this.namespace.get<unknown>(key, 'json');
    if (raw === null) return undefined;
    const parsed = MatchOddsSnapshotSchema.safeParse(raw);
    if (!parsed.success) {
      await this.namespace.delete(key);
      return undefined;
    }
    if (Date.parse(parsed.data.expiresAt) <= Date.now()) {
      await this.namespace.delete(key);
      return undefined;
    }
    return parsed.data;
  }

  async set(
    fixtureKey: string,
    snapshot: MatchOddsSnapshot,
  ): Promise<void> {
    const parsed = MatchOddsSnapshotSchema.parse(snapshot);
    await this.namespace.put(this.key(fixtureKey), JSON.stringify(parsed), {
      expiration: Math.floor(Date.parse(parsed.expiresAt) / 1_000),
    });
  }

  async claimRefreshLease(
    fixtureKey: string,
    requestGroup: string,
    ttlMs: number,
  ): Promise<boolean> {
    if (!this.namespace.putIfAbsent) return true;
    return this.namespace.putIfAbsent(
      `match-odds-refresh-lease:v1:${encodeURIComponent(
        requestGroup,
      )}:${encodeURIComponent(fixtureKey)}`,
      JSON.stringify({ claimedAt: new Date().toISOString() }),
      { expirationTtl: Math.max(1, Math.ceil(ttlMs / 1_000)) },
    );
  }

  async releaseRefreshLease(
    fixtureKey: string,
    requestGroup: string,
  ): Promise<void> {
    await this.namespace.delete(
      `match-odds-refresh-lease:v1:${encodeURIComponent(
        requestGroup,
      )}:${encodeURIComponent(fixtureKey)}`,
    );
  }

  private key(fixtureKey: string): string {
    return `match-odds:v1:${encodeURIComponent(fixtureKey)}`;
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

  async claimRefreshLease(
    provider: OddsProviderName,
    lease: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    if (!this.namespace.putIfAbsent) return true;
    return this.namespace.putIfAbsent(
      `odds-provider-refresh-lease:v1:${provider}:${encodeURIComponent(lease)}`,
      JSON.stringify({ claimedAt: new Date().toISOString() }),
      { expirationTtl: Math.max(1, ttlSeconds) },
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
    const cacheKey = `player-form:v2:${key}`;
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
      `player-form:v2:${key}`,
      PlayerFormStatsSchema.parse(value),
      nextMondayFormExpiration(this.now(), this.ttlSeconds),
    );
  }

  async claimFormHistoryRefresh(key: string): Promise<boolean> {
    const leaseKey = `${FORM_HISTORY_REFRESH_LEASE_PREFIX}${encodeURIComponent(
      key,
    )}`;
    const value = JSON.stringify({
      claimedAt: new Date(this.now()).toISOString(),
    });
    if (this.namespace.putIfAbsent) {
      return this.namespace.putIfAbsent(leaseKey, value, {
        expirationTtl: FORM_HISTORY_REFRESH_LEASE_SECONDS,
      });
    }
    const existing = await this.namespace.get<unknown>(leaseKey, 'json');
    if (existing !== null) return false;
    await this.namespace.put(
      leaseKey,
      value,
      { expirationTtl: FORM_HISTORY_REFRESH_LEASE_SECONDS },
    );
    return true;
  }

  async releaseFormHistoryRefresh(key: string): Promise<void> {
    await this.namespace.delete(
      `${FORM_HISTORY_REFRESH_LEASE_PREFIX}${encodeURIComponent(key)}`,
    );
  }
}

class CloudflarePlayerFixtureCache
  extends CloudflareKvCache
  implements Cache<PlayerFixtureStats>
{
  private readonly teamFixtureResolutions = new Map<
    string,
    Promise<NonNullable<PlayerFixtureStats>>
  >();

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
    return this.resolvePlayerTeamFixture(key, fixture);
  }

  async getTeamFixture(
    playerCacheKey: string,
    teamSlug: string,
  ): Promise<PlayerFixtureStats | undefined> {
    const normalizedTeamSlug = teamSlug.trim().toLowerCase();
    if (!normalizedTeamSlug) return undefined;
    const fixture = await this.readPlayerTeamFixture(
      playerTeamFixtureSlugKey(normalizedTeamSlug),
      normalizedTeamSlug,
    );
    return fixture
      ? this.resolveFixtureTeamOdds(playerCacheKey, fixture)
      : undefined;
  }

  async set(key: string, value: PlayerFixtureStats): Promise<void> {
    const resolved =
      value === null ? null : await this.resolvePlayerTeamFixture(key, value);
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
    if (resolved) await this.rememberFixtureRefreshAttempt(resolved);
  }

  async fillMissing(
    key: string,
    value: PlayerFixtureStats,
  ): Promise<PlayerFixtureStats> {
    const existing = await this.get(key);
    if (existing !== undefined) return existing;
    const resolved =
      value === null ? null : await this.resolvePlayerTeamFixture(key, value);
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
    if (resolved) await this.rememberFixtureRefreshAttempt(resolved);
    return resolved;
  }

  async claimRefresh(value: PlayerFixtureStats): Promise<boolean> {
    if (
      value === null ||
      !needsFixtureTeamOddsFallback(fixtureTeamOddsFrom(value))
    ) {
      return false;
    }
    const kickoffMs = Date.parse(value.date);
    if (!Number.isFinite(kickoffMs) || kickoffMs <= this.now()) return false;
    const key = fixtureOddsCheckKey(value);
    if (!key) return false;
    const leaseValue = JSON.stringify({
      checkedAt: new Date(this.now()).toISOString(),
    });
    if (this.namespace.putIfAbsent) {
      return this.namespace.putIfAbsent(key, leaseValue, {
        expirationTtl: FIXTURE_ODDS_REFRESH_LEASE_SECONDS,
      });
    }
    const existing = await this.namespace.get<unknown>(key, 'json');
    if (existing !== null) return false;
    await this.namespace.put(
      key,
      leaseValue,
      { expirationTtl: FIXTURE_ODDS_REFRESH_LEASE_SECONDS },
    );
    return true;
  }

  async refresh(
    key: string,
    value: PlayerFixtureStats,
  ): Promise<PlayerFixtureStats> {
    const existing = await this.get(key);
    if (existing === undefined) {
      await this.set(key, value);
      return value;
    }
    if (existing === null && value !== null) {
      await this.set(key, value);
      return (await this.get(key)) ?? value;
    }
    if (
      existing !== null &&
      value !== null &&
      existing.playerTeamSlug &&
      value.playerTeamSlug &&
      existing.playerTeamSlug.toLowerCase() !==
        value.playerTeamSlug.toLowerCase()
    ) {
      // A server-confirmed club change is authoritative. Holding the previous
      // club's fixture until its rollover would attach the wrong match to a
      // transferred player.
      await this.set(key, value);
      return (await this.get(key)) ?? value;
    }
    if (
      existing === null ||
      value === null ||
      !samePlayerFixture(existing, value)
    ) {
      if (existing) await this.rememberFixtureRefreshAttempt(existing);
      return existing;
    }

    const mergedOdds = mergeFixtureTeamOdds(
      fixtureTeamOddsFrom(value),
      fixtureTeamOddsFrom(existing),
    );
    const refreshed = withFixtureTeamOdds(existing, mergedOdds);
    if (hasFixtureTeamOdds(mergedOdds)) {
      await this.rememberFixtureTeamOdds(existing, mergedOdds);
    }
    this.persistUntil(
      `player-fixture:v1:${key}`,
      PlayerFixtureEnvelopeSchema.parse({
        nextGame: refreshed,
        cachePolicyVersion: PLAYER_FIXTURE_CACHE_POLICY_VERSION,
      }),
      playerFixtureExpiration(
        refreshed.date,
        this.ttlSeconds,
        this.now(),
      ),
    );
    await this.rememberFixtureRefreshAttempt(refreshed);
    return refreshed;
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
    const rolloverExpiration = fixture
      ? fixtureRolloverExpiration(fixture.date)
      : null;
    if (
      fixture &&
      rolloverExpiration !== null &&
      rolloverExpiration <= Math.floor(this.now() / 1_000)
    ) {
      // Old rows written with a previous minimum-TTL policy must not revive
      // the completed match after the configured morning rollover.
      this.removeInvalid(cacheKey);
      return undefined;
    }
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

  private async resolvePlayerTeamFixture(
    playerCacheKey: string,
    fixture: NonNullable<PlayerFixtureStats>,
  ): Promise<NonNullable<PlayerFixtureStats>> {
    const teamKey = playerTeamFixtureKey(fixture);
    if (!teamKey) {
      return this.resolveFixtureTeamOdds(playerCacheKey, fixture);
    }
    const previous = this.teamFixtureResolutions.get(teamKey);
    const resolution = (async () => {
      if (previous) await previous.catch(() => undefined);
      return this.resolvePlayerTeamFixtureUnlocked(
        playerCacheKey,
        fixture,
        teamKey,
      );
    })();
    this.teamFixtureResolutions.set(teamKey, resolution);
    try {
      return await resolution;
    } finally {
      if (this.teamFixtureResolutions.get(teamKey) === resolution) {
        this.teamFixtureResolutions.delete(teamKey);
      }
    }
  }

  private async resolvePlayerTeamFixtureUnlocked(
    playerCacheKey: string,
    fixture: NonNullable<PlayerFixtureStats>,
    teamKey: string,
  ): Promise<NonNullable<PlayerFixtureStats>> {
    const candidate = await this.resolveFixtureTeamOdds(
      playerCacheKey,
      fixture,
    );
    const expectedTeamSlug = candidate.playerTeamSlug?.trim().toLowerCase();
    const rolloverExpiration = fixtureRolloverExpiration(candidate.date);
    if (
      rolloverExpiration !== null &&
      rolloverExpiration <= Math.floor(this.now() / 1_000)
    ) {
      // A delayed old Sorare response must never replace the already known
      // next fixture after the configured morning rollover.
      const current = await this.readPlayerTeamFixture(
        teamKey,
        expectedTeamSlug,
      );
      if (current) {
        return this.resolveFixtureTeamOdds(playerCacheKey, current);
      }
      const { marketOdds: _marketOdds, ...playerFixture } = candidate;
      return playerFixture;
    }

    const incomingEnvelope = teamFixtureEnvelope(candidate);
    const incomingFixture = incomingEnvelope.nextGame;
    if (!incomingFixture) return candidate;
    const expiration = playerFixtureExpiration(
      incomingFixture.date,
      this.ttlSeconds,
      this.now(),
    );

    if (this.namespace.putEarlierFixture) {
      await this.namespace.putEarlierFixture(
        teamKey,
        JSON.stringify(incomingEnvelope),
        { expiration },
      );
    } else {
      const existing = await this.readPlayerTeamFixture(
        teamKey,
        expectedTeamSlug,
      );
      const selected = existing
        ? this.selectPlayerTeamFixture(existing, incomingFixture)
        : incomingFixture;
      if (!existing || !sameFixtureIdentity(existing, selected)) {
        await this.namespace.put(
          teamKey,
          JSON.stringify(teamFixtureEnvelope(selected)),
          { expiration },
        );
      }
    }

    const selected =
      (await this.readPlayerTeamFixture(teamKey, expectedTeamSlug)) ??
      incomingFixture;
    if (sameFixtureIdentity(selected, candidate)) {
      const { marketOdds: _marketOdds, ...playerFixture } = candidate;
      return playerFixture;
    }
    return this.resolveFixtureTeamOdds(playerCacheKey, selected);
  }

  private async readPlayerTeamFixture(
    teamKey: string,
    expectedTeamSlug?: string,
  ): Promise<NonNullable<PlayerFixtureStats> | undefined> {
    const raw = await this.namespace.get<unknown>(teamKey, 'json');
    if (raw === null) return undefined;
    const parsed = PlayerFixtureEnvelopeSchema.safeParse(raw);
    const fixture = parsed.success ? parsed.data.nextGame : undefined;
    if (!fixture) {
      this.removeInvalid(teamKey);
      return undefined;
    }
    if (
      expectedTeamSlug !== undefined &&
      fixture.playerTeamSlug?.trim().toLowerCase() !== expectedTeamSlug
    ) {
      this.removeInvalid(teamKey);
      return undefined;
    }
    const rolloverExpiration = fixtureRolloverExpiration(fixture.date);
    if (
      rolloverExpiration !== null &&
      rolloverExpiration <= Math.floor(this.now() / 1_000)
    ) {
      this.removeInvalid(teamKey);
      return undefined;
    }
    return fixture;
  }

  private selectPlayerTeamFixture(
    existing: NonNullable<PlayerFixtureStats>,
    incoming: NonNullable<PlayerFixtureStats>,
  ): NonNullable<PlayerFixtureStats> {
    if (sameFixtureIdentity(existing, incoming)) return existing;

    const existingKickoff = Date.parse(existing.date);
    const incomingKickoff = Date.parse(incoming.date);
    if (!Number.isFinite(existingKickoff)) return incoming;
    if (!Number.isFinite(incomingKickoff)) return existing;
    return incomingKickoff < existingKickoff ? incoming : existing;
  }

  private async resolveFixtureTeamOdds(
    playerCacheKey: string,
    fixture: NonNullable<PlayerFixtureStats>,
  ): Promise<NonNullable<PlayerFixtureStats>> {
    const shared = await this.readFixtureTeamOdds(fixture);
    const direct = fixtureTeamOddsFrom(fixture);
    // Once captured for a fixture/team side, shared values are authoritative.
    // A later player cache may fill gaps but must not replace existing values.
    let resolvedOdds = shared
      ? mergeFixtureTeamOdds(shared, direct)
      : direct;

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

  private async rememberFixtureRefreshAttempt(
    fixture: NonNullable<PlayerFixtureStats>,
  ): Promise<void> {
    if (!needsFixtureTeamOddsFallback(fixtureTeamOddsFrom(fixture))) return;
    const kickoffMs = Date.parse(fixture.date);
    const nowMs = this.now();
    if (!Number.isFinite(kickoffMs) || kickoffMs <= nowMs) return;
    const key = fixtureOddsCheckKey(fixture);
    if (!key) return;
    await this.namespace.put(
      key,
      JSON.stringify({ checkedAt: new Date(nowMs).toISOString() }),
      {
        expirationTtl: Math.max(
          60,
          Math.ceil(fixtureOddsRefreshIntervalMs(kickoffMs - nowMs) / 1_000),
        ),
      },
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

  setForm(key: string, value: PlayerFormStats): Promise<void> {
    return this.splitCache.setForm(key, value);
  }

  claimFormHistoryRefresh(key: string): boolean | Promise<boolean> {
    return this.splitCache.claimFormHistoryRefresh(key);
  }

  releaseFormHistoryRefresh(key: string): void | Promise<void> {
    return this.splitCache.releaseFormHistoryRefresh(key);
  }

  claimFixtureRefresh(
    value: PlayerFixtureStats,
  ): boolean | Promise<boolean> {
    return this.splitCache.claimFixtureRefresh(value);
  }

  getTeamFixture(
    playerCacheKey: string,
    teamSlug: string,
  ): Promise<PlayerFixtureStats | undefined> {
    return this.splitCache.getTeamFixture(playerCacheKey, teamSlug);
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

  refreshFixture(
    key: string,
    value: PlayerFixtureStats,
  ): PlayerFixtureStats | Promise<PlayerFixtureStats> {
    return this.splitCache.refreshFixture(key, value);
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
    teamSlug?: string,
  ): Promise<SourcePlayerRequest | null | undefined> {
    const cacheKey = this.key(name, position, teamSlug);
    const raw = await this.namespace.get<unknown>(cacheKey, 'json');
    if (raw === null) return undefined;
    const parsed = NameResolutionEnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      this.removeInvalid(cacheKey);
      return undefined;
    }
    if (!parsed.data.found) return null;
    return {
      slug: parsed.data.value.slug,
      ...(parsed.data.value.position
        ? { position: parsed.data.value.position }
        : {}),
      ...(parsed.data.value.teamSlug
        ? { teamSlug: parsed.data.value.teamSlug }
        : {}),
      ...(parsed.data.value.nameResolution
        ? { nameResolution: parsed.data.value.nameResolution }
        : {}),
    };
  }

  set(
    name: string,
    position: FootballPosition | undefined,
    value: SourcePlayerRequest | null,
    teamSlug?: string,
  ): void {
    const envelope = value
      ? { found: true as const, value: SourcePlayerRequestSchema.parse(value) }
      : { found: false as const };
    this.persist(
      this.key(name, position, teamSlug),
      envelope,
      value ? this.positiveTtlSeconds : this.negativeTtlSeconds,
    );
  }

  private key(
    name: string,
    position: FootballPosition | undefined,
    teamSlug?: string,
  ): string {
    if (!teamSlug) {
      return `player-name:v5:${encodeURIComponent(normalizeName(name))}:${position ?? 'any'}`;
    }
    return `player-name:v7:${encodeURIComponent(normalizeName(name))}:${position ?? 'any'}:${encodeURIComponent(teamSlug.toLowerCase())}`;
  }
}
