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
  FIXTURE_IDENTITY_VERSION,
  MarketSupplementBatchSchema,
  MarketSnapshotSchema,
  marketFixtureKey,
  mergeSupplementBatch,
  normalizeTeamName,
  type MarketSupplementBatch,
  type MarketSupplementPlayer,
  type MarketSnapshot,
  type MarketSnapshotRead,
  type MarketSnapshotStore,
  type MarketIdentityProvider,
  type OddsMarketKey,
  type ProviderTeamAlias,
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
  PlayerNameResolutionCacheRead,
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

const ProviderTeamAliasEnvelopeSchema = z.object({
  canonicalTeamSlug: z
    .string()
    .trim()
    .min(1)
    .max(180)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i),
  learnedAt: z.string().datetime(),
});

const ProviderRequestBlockSchema = z.object({
  blockedUntil: z.string().datetime(),
});

const PlayerFormStatsSchema = PlayerStatsSchema.omit({
  nextGame: true,
  pendingRefreshes: true,
  mlsAaContext: true,
});
const HISTORICAL_CLUB_SCOPE_VERSION = 1;
const CachedPlayerFormStatsSchema = PlayerFormStatsSchema.extend({
  historicalClubScopeVersion: z
    .literal(HISTORICAL_CLUB_SCOPE_VERSION)
    .optional(),
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
  getMany?<T = unknown>(
    keys: readonly string[],
    type: 'json',
  ): Promise<Map<string, T>>;
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

  protected async readMany<T = unknown>(
    keys: readonly string[],
  ): Promise<Map<string, T>> {
    const uniqueKeys = [...new Set(keys)];
    if (uniqueKeys.length === 0) return new Map();
    if (this.namespace.getMany) {
      return this.namespace.getMany<T>(uniqueKeys, 'json');
    }
    const entries = await Promise.all(
      uniqueKeys.map(async (key) => [
        key,
        await this.namespace.get<T>(key, 'json'),
      ] as const),
    );
    return new Map(
      entries.flatMap(([key, value]) =>
        value === null ? [] : ([[key, value]] as const),
      ),
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

function sameFixtureTeamOdds(
  left: FixtureTeamOdds | null,
  right: FixtureTeamOdds,
): boolean {
  return (
    left !== null &&
    left.cleanSheetProbability === right.cleanSheetProbability &&
    left.matchProbabilities?.win === right.matchProbabilities?.win &&
    left.matchProbabilities?.draw === right.matchProbabilities?.draw &&
    left.matchProbabilities?.loss === right.matchProbabilities?.loss
  );
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

  async getMany(
    requests: readonly MarketSnapshotRead[],
  ): Promise<Array<MarketSnapshot | undefined>> {
    if (requests.length === 0) return [];
    const keys = requests.map(({ fixtureKey, market }) =>
      this.key(fixtureKey, market),
    );
    if (!this.namespace.getMany) {
      return Promise.all(
        requests.map(({ fixtureKey, market }) => this.get(fixtureKey, market)),
      );
    }
    const rawByKey = await this.namespace.getMany<unknown>(keys, 'json');
    return keys.map((key) => {
      const raw = rawByKey.get(key);
      if (raw === undefined) return undefined;
      const parsed = MarketSnapshotSchema.safeParse(raw);
      if (parsed.success) return parsed.data;
      this.removeInvalid(key);
      return undefined;
    });
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

  async getEvidence(
    fixtureKey: string,
    provider: string,
  ): Promise<unknown | undefined> {
    const raw = await this.namespace.get<unknown>(
      this.evidenceKey(fixtureKey, provider),
      'json',
    );
    return raw === null ? undefined : raw;
  }

  async setEvidence(
    fixtureKey: string,
    provider: string,
    evidence: unknown,
    expiresAt: string,
  ): Promise<void> {
    const expiration = Math.floor(Date.parse(expiresAt) / 1_000);
    if (
      !Number.isFinite(expiration) ||
      expiration <= Math.floor(Date.now() / 1_000)
    ) {
      return;
    }
    await this.namespace.put(
      this.evidenceKey(fixtureKey, provider),
      JSON.stringify(evidence),
      { expiration },
    );
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

  async getProviderTeamAliases(
    provider: MarketIdentityProvider,
    providerTeamNames: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const normalizedNames = [
      ...new Set(providerTeamNames.map(normalizeTeamName)),
    ];
    const keys = normalizedNames.map((name) =>
      this.providerTeamAliasKey(provider, name),
    );
    const rawByKey = this.namespace.getMany
      ? await this.namespace.getMany<unknown>(keys, 'json')
      : new Map(
          await Promise.all(
            keys.map(async (key) => [
              key,
              (await this.namespace.get<unknown>(key, 'json')) ?? undefined,
            ] as const),
          ),
        );
    return new Map(
      normalizedNames.flatMap((name, index) => {
        const parsed = ProviderTeamAliasEnvelopeSchema.safeParse(
          rawByKey.get(keys[index] ?? ''),
        );
        return parsed.success
          ? [[name, parsed.data.canonicalTeamSlug] as const]
          : [];
      }),
    );
  }

  async setProviderTeamAliases(
    provider: MarketIdentityProvider,
    aliases: readonly ProviderTeamAlias[],
  ): Promise<void> {
    await Promise.all(
      aliases.map((alias) =>
        this.namespace.put(
          this.providerTeamAliasKey(
            provider,
            normalizeTeamName(alias.providerTeamName),
          ),
          JSON.stringify(
            ProviderTeamAliasEnvelopeSchema.parse({
              canonicalTeamSlug: alias.canonicalTeamSlug,
              learnedAt: new Date().toISOString(),
            }),
          ),
        ),
      ),
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

  private evidenceKey(fixtureKey: string, provider: string): string {
    return `market-evidence:v1:${encodeURIComponent(
      provider,
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

  private providerTeamAliasKey(
    provider: MarketIdentityProvider,
    normalizedProviderTeamName: string,
  ): string {
    return `provider-team-alias:v1:${encodeURIComponent(
      provider,
    )}:${encodeURIComponent(normalizedProviderTeamName)}`;
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
    if (
      parsed.data.status === 'unavailable' &&
      parsed.data.fixtureIdentityVersion !== FIXTURE_IDENTITY_VERSION
    ) {
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

  async getRequestBlockedUntil(
    provider: OddsProviderName,
  ): Promise<number | undefined> {
    const key = this.requestBlockKey(provider);
    const raw = await this.namespace.get<unknown>(key, 'json');
    if (raw === null) return undefined;
    const parsed = ProviderRequestBlockSchema.safeParse(raw);
    if (!parsed.success) {
      await this.namespace.delete(key);
      return undefined;
    }
    const blockedUntil = Date.parse(parsed.data.blockedUntil);
    if (!Number.isFinite(blockedUntil) || blockedUntil <= Date.now()) {
      await this.namespace.delete(key);
      return undefined;
    }
    return blockedUntil;
  }

  async setRequestBlockedUntil(
    provider: OddsProviderName,
    blockedUntil: number,
  ): Promise<void> {
    const expiration = Math.ceil(blockedUntil / 1_000);
    if (
      !Number.isFinite(expiration) ||
      expiration <= Math.floor(Date.now() / 1_000)
    ) {
      return;
    }
    await this.namespace.put(
      this.requestBlockKey(provider),
      JSON.stringify(
        ProviderRequestBlockSchema.parse({
          blockedUntil: new Date(blockedUntil).toISOString(),
        }),
      ),
      { expiration },
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

  private requestBlockKey(provider: OddsProviderName): string {
    return `odds-provider-request-block:v1:${provider}`;
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
    const cacheKey = `player-form:v3:${key}`;
    const raw = await this.namespace.get<unknown>(cacheKey, 'json');
    if (raw === null) return undefined;
    return this.parse(cacheKey, raw);
  }

  async getMany(
    keys: readonly string[],
  ): Promise<Map<string, PlayerFormStats>> {
    const cacheKeyByPlayer = new Map(
      [...new Set(keys)].map((key) => [key, `player-form:v3:${key}`]),
    );
    const raw = await this.readMany<unknown>([...cacheKeyByPlayer.values()]);
    const values = new Map<string, PlayerFormStats>();
    for (const [key, cacheKey] of cacheKeyByPlayer) {
      if (!raw.has(cacheKey)) continue;
      const parsed = this.parse(cacheKey, raw.get(cacheKey));
      if (parsed) values.set(key, parsed);
    }
    return values;
  }

  private parse(
    cacheKey: string,
    raw: unknown,
  ): PlayerFormStats | undefined {
    const parsed = CachedPlayerFormStatsSchema.safeParse(raw);
    if (!parsed.success) {
      this.removeInvalid(cacheKey);
      return undefined;
    }
    if (parsed.data.aaL10TeamWinRate === undefined) {
      // This metric needs the original appearance results and cannot be
      // reconstructed from an older aggregate-only form entry. Treat that
      // entry as a lazy cache miss so only requested players are enriched.
      this.removeInvalid(cacheKey);
      return undefined;
    }
    const {
      historicalClubScopeVersion,
      historicalGoals,
      historicalAssists,
      historicalDecisives,
      ...baseForm
    } = parsed.data;
    const hasHistoricalMetrics =
      historicalGoals !== undefined ||
      historicalAssists !== undefined ||
      historicalDecisives !== undefined;
    if (
      hasHistoricalMetrics &&
      historicalClubScopeVersion !== HISTORICAL_CLUB_SCOPE_VERSION
    ) {
      return baseForm;
    }
    return {
      ...baseForm,
      ...(historicalGoals !== undefined ? { historicalGoals } : {}),
      ...(historicalAssists !== undefined ? { historicalAssists } : {}),
      ...(historicalDecisives !== undefined
        ? { historicalDecisives }
        : {}),
    };
  }

  set(key: string, value: PlayerFormStats): void {
    const parsed = PlayerFormStatsSchema.parse(value);
    this.persistUntil(
      `player-form:v3:${key}`,
      {
        ...parsed,
        historicalClubScopeVersion: HISTORICAL_CLUB_SCOPE_VERSION,
      },
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
  private readonly teamFixtureLocks = new Map<
    string,
    Promise<NonNullable<PlayerFixtureStats>>
  >();
  private readonly teamFixtureReads = new Map<
    string,
    Promise<NonNullable<PlayerFixtureStats> | undefined>
  >();
  private readonly fixtureTeamOddsReads = new Map<
    string,
    Promise<FixtureTeamOdds | null>
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

  async getMany(
    keys: readonly string[],
  ): Promise<Map<string, PlayerFixtureStats>> {
    const cacheKeyByPlayer = new Map(
      [...new Set(keys)].map((key) => [key, `player-fixture:v1:${key}`]),
    );
    const raw = await this.readMany<unknown>([...cacheKeyByPlayer.values()]);
    const loaded = await Promise.all(
      [...cacheKeyByPlayer].map(async ([key, cacheKey]) => {
        if (!raw.has(cacheKey)) return [key, undefined] as const;
        const fixture = this.parsePlayerFixture(cacheKey, raw.get(cacheKey));
        if (fixture === undefined || fixture === null) {
          return [key, fixture] as const;
        }
        return [key, await this.resolvePlayerTeamFixture(key, fixture)] as const;
      }),
    );
    return new Map(
      loaded.flatMap(([key, fixture]) =>
        fixture === undefined ? [] : ([[key, fixture]] as const),
      ),
    );
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
    if (existing !== null && value !== null && value.playerTeamSlug) {
      const existingTeamSlug = existing.playerTeamSlug?.toLowerCase();
      const valueTeamSlug = value.playerTeamSlug.toLowerCase();
      const existingKickoff = Date.parse(existing.date);
      const valueKickoff = Date.parse(value.date);
      const valueRollover = fixtureRolloverExpiration(value.date);
      const valueIsActive =
        valueRollover !== null &&
        valueRollover > Math.floor(this.now() / 1_000);
      if (
        valueIsActive &&
        (!existingTeamSlug || existingTeamSlug === valueTeamSlug) &&
        Number.isFinite(existingKickoff) &&
        Number.isFinite(valueKickoff) &&
        valueKickoff < existingKickoff
      ) {
        // A canonical team fixture can be earlier than a stale player-level
        // nextGame (notably Sorare games represented as midnight placeholders).
        // Prefer the still-active held fixture without letting an expired old
        // match overwrite a genuine future game.
        await this.set(key, value);
        return (await this.get(key)) ?? value;
      }
    }
    if (
      existing === null ||
      value === null ||
      (!samePlayerFixture(existing, value) &&
        !sameFixtureIdentity(existing, value))
    ) {
      if (existing) await this.rememberFixtureRefreshAttempt(existing);
      return existing;
    }

    const mergedOdds = mergeFixtureTeamOdds(
      fixtureTeamOddsFrom(value),
      fixtureTeamOddsFrom(existing),
    );
    const identityHydrated =
      value.playerTeamSlug &&
      value.playerTeamName &&
      value.opponentTeamName &&
      (!existing.playerTeamSlug ||
        !existing.playerTeamName ||
        !existing.opponentTeamName)
        ? {
            ...value,
            ...(existing.marketOdds !== undefined
              ? { marketOdds: existing.marketOdds }
              : {}),
          }
        : existing;
    const identityWasHydrated = identityHydrated !== existing;
    const refreshed = withFixtureTeamOdds(identityHydrated, mergedOdds);
    if (hasFixtureTeamOdds(mergedOdds)) {
      await this.rememberFixtureTeamOdds(refreshed, mergedOdds);
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
    if (!identityWasHydrated || hasFixtureTeamOdds(mergedOdds)) {
      await this.rememberFixtureRefreshAttempt(refreshed);
    }
    return refreshed;
  }

  private async readPlayerFixture(
    key: string,
  ): Promise<PlayerFixtureStats | undefined> {
    const cacheKey = `player-fixture:v1:${key}`;
    const raw = await this.namespace.get<unknown>(cacheKey, 'json');
    if (raw === null) return undefined;
    return this.parsePlayerFixture(cacheKey, raw);
  }

  private parsePlayerFixture(
    cacheKey: string,
    raw: unknown,
  ): PlayerFixtureStats | undefined {
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
    const directOdds = fixtureTeamOddsFrom(fixture);
    const resolutionKey = [
      teamKey,
      marketFixtureKey(fixture) ?? fixture.date,
      fixture.playerTeamSlug ?? fixture.playerTeamName ?? '',
      directOdds.cleanSheetProbability ?? '',
      directOdds.matchProbabilities?.win ?? '',
      directOdds.matchProbabilities?.draw ?? '',
      directOdds.matchProbabilities?.loss ?? '',
    ].join('|');
    const existing = this.teamFixtureResolutions.get(resolutionKey);
    if (existing) return existing;

    const previous = this.teamFixtureLocks.get(teamKey);
    const resolution = (async () => {
      if (previous) await previous.catch(() => undefined);
      return this.resolvePlayerTeamFixtureUnlocked(
        playerCacheKey,
        fixture,
        teamKey,
      );
    })();
    // Identical teammate candidates share the full resolution. A genuinely
    // different fixture or odds payload remains serialized behind the team
    // lock so transfer and rollover ordering stays unchanged.
    this.teamFixtureResolutions.set(resolutionKey, resolution);
    this.teamFixtureLocks.set(teamKey, resolution);
    return resolution;
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
    const existing = await this.readPlayerTeamFixture(
      teamKey,
      expectedTeamSlug,
    );
    const selectedCandidate = existing
      ? this.selectPlayerTeamFixture(existing, incomingFixture)
      : incomingFixture;
    const shouldPersist =
      !existing || !sameFixtureIdentity(existing, selectedCandidate);

    let selected = selectedCandidate;
    if (shouldPersist) {
      if (this.namespace.putEarlierFixture) {
        // Keep the cross-isolate compare-and-set for cold or genuinely earlier
        // fixtures, while allowing the overwhelmingly common warm read to stay
        // free of D1 writes.
        await this.namespace.putEarlierFixture(
          teamKey,
          JSON.stringify(incomingEnvelope),
          { expiration },
        );
      } else {
        await this.namespace.put(
          teamKey,
          JSON.stringify(teamFixtureEnvelope(selectedCandidate)),
          { expiration },
        );
      }
      this.clearTeamFixtureReads(teamKey);
      // The atomic D1 write may have retained an earlier fixture inserted by a
      // concurrent isolate, so only a real write candidate needs this reread.
      selected =
        (await this.readPlayerTeamFixture(teamKey, expectedTeamSlug)) ??
        incomingFixture;
    }
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
    const memoKey = `${teamKey}|${expectedTeamSlug ?? ''}`;
    const existing = this.teamFixtureReads.get(memoKey);
    if (existing) return existing;
    const pending = (async () => {
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
    })();
    this.teamFixtureReads.set(memoKey, pending);
    return pending;
  }

  private clearTeamFixtureReads(teamKey: string): void {
    const prefix = `${teamKey}|`;
    for (const key of this.teamFixtureReads.keys()) {
      if (key.startsWith(prefix)) this.teamFixtureReads.delete(key);
    }
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

    if (
      hasFixtureTeamOdds(resolvedOdds) &&
      !sameFixtureTeamOdds(shared, resolvedOdds)
    ) {
      await this.rememberFixtureTeamOdds(fixture, resolvedOdds, shared);
    }
    return withFixtureTeamOdds(fixture, resolvedOdds);
  }

  private async readFixtureTeamOdds(
    fixture: NonNullable<PlayerFixtureStats>,
  ): Promise<FixtureTeamOdds | null> {
    const key = fixtureTeamOddsKey(fixture);
    if (!key) return null;
    const existing = this.fixtureTeamOddsReads.get(key);
    if (existing) return existing;
    const pending = (async () => {
      const raw = await this.namespace.get<unknown>(key, 'json');
      if (raw === null) return null;
      const parsed = FixtureTeamOddsSchema.safeParse(raw);
      if (!parsed.success) {
        this.removeInvalid(key);
        return null;
      }
      return parsed.data;
    })();
    this.fixtureTeamOddsReads.set(key, pending);
    return pending;
  }

  private async rememberFixtureTeamOdds(
    fixture: NonNullable<PlayerFixtureStats>,
    incoming: FixtureTeamOdds,
    knownExisting?: FixtureTeamOdds | null,
  ): Promise<void> {
    const key = fixtureTeamOddsKey(fixture);
    if (!key || !hasFixtureTeamOdds(incoming)) return;
    const existing =
      knownExisting === undefined
        ? await this.readFixtureTeamOdds(fixture)
        : knownExisting;
    const merged = mergeFixtureTeamOdds(incoming, existing);
    if (sameFixtureTeamOdds(existing, merged)) return;
    const parsed = FixtureTeamOddsSchema.parse(merged);
    this.fixtureTeamOddsReads.set(key, Promise.resolve(parsed));
    this.persistUntil(
      key,
      parsed,
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

  async getMany(keys: readonly string[]): Promise<Map<string, PlayerStats>> {
    const cacheKeyByPlayer = new Map(
      [...new Set(keys)].map((key) => [key, `player-stats:v1:${key}`]),
    );
    const raw = await this.readMany<unknown>([...cacheKeyByPlayer.values()]);
    const values = new Map<string, PlayerStats>();
    for (const [key, cacheKey] of cacheKeyByPlayer) {
      if (!raw.has(cacheKey)) continue;
      const parsed = PlayerStatsSchema.safeParse(raw.get(cacheKey));
      if (!parsed.success) {
        this.removeInvalid(cacheKey);
        continue;
      }
      values.set(key, parsed.data);
    }
    return values;
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

  getPartsMany(
    keys: readonly string[],
  ): Promise<Map<string, PlayerStatsCacheParts>> {
    return this.splitCache.getPartsMany(keys);
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
  private static readonly key = 'mls-aa-benchmark:v2';
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
    if (raw !== null) return this.parse(cacheKey, raw);

    const legacyKey = this.legacyTeamKey(name, position, teamSlug);
    if (!legacyKey) return undefined;
    const legacyRaw = await this.namespace.get<unknown>(legacyKey, 'json');
    if (legacyRaw === null) return undefined;
    const legacy = this.parse(legacyKey, legacyRaw);
    // Preserve old positive mappings without reviving v7 negatives created by
    // the stale-activeClub bug. The positive is lazily migrated to v8.
    if (legacy && typeof legacy === 'object') {
      this.persist(cacheKey, { found: true, value: legacy }, this.positiveTtlSeconds);
      return legacy;
    }
    return undefined;
  }

  async getMany(
    requests: readonly PlayerNameResolutionCacheRead[],
  ): Promise<Array<SourcePlayerRequest | null | undefined>> {
    const keys = requests.map(({ name, position, teamSlug }) =>
      this.key(name, position, teamSlug),
    );
    const raw = await this.readMany<unknown>(keys);
    const legacyKeyByIndex = requests.map(
      ({ name, position, teamSlug }, index) =>
        raw.has(keys[index]!)
          ? undefined
          : this.legacyTeamKey(name, position, teamSlug),
    );
    const legacyRaw = await this.readMany<unknown>(
      legacyKeyByIndex.filter((key): key is string => Boolean(key)),
    );
    return keys.map((cacheKey, index) => {
      if (raw.has(cacheKey)) return this.parse(cacheKey, raw.get(cacheKey));
      const legacyKey = legacyKeyByIndex[index];
      if (!legacyKey || !legacyRaw.has(legacyKey)) return undefined;
      const legacy = this.parse(legacyKey, legacyRaw.get(legacyKey));
      if (legacy && typeof legacy === 'object') {
        this.persist(
          cacheKey,
          { found: true, value: legacy },
          this.positiveTtlSeconds,
        );
        return legacy;
      }
      return undefined;
    });
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
    return `player-name:v8:${encodeURIComponent(normalizeName(name))}:${position ?? 'any'}:${encodeURIComponent(teamSlug.toLowerCase())}`;
  }

  private legacyTeamKey(
    name: string,
    position: FootballPosition | undefined,
    teamSlug?: string,
  ): string | undefined {
    if (!teamSlug) return undefined;
    return `player-name:v7:${encodeURIComponent(normalizeName(name))}:${position ?? 'any'}:${encodeURIComponent(teamSlug.toLowerCase())}`;
  }

  private parse(
    cacheKey: string,
    raw: unknown,
  ): SourcePlayerRequest | null | undefined {
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
}
