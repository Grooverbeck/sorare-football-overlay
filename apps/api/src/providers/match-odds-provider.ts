import {
  MatchProbabilitiesSchema,
  type MatchProbabilities,
  type PlayerStats,
} from '@sorare-overlay/shared';
import * as z from 'zod';
import type { AppLogger } from '../logger.js';
import {
  FIXTURE_IDENTITY_VERSION,
  groupFixtures,
  marketFixtureKey,
  normalizeTeamName,
  playerMarketOddsKey,
  resolveProviderFixtureCandidates,
  settleCacheReadWithin,
  supportsFixtureCompetition,
  theOddsApiQuotaUsage,
  type FixtureGroup,
} from './market-odds-provider.js';
import {
  providerProtection,
  protectionForUsage,
  type ProviderQuotaUsageStore,
} from './odds-usage.js';

const availableSnapshotSchema = z.object({
  status: z.literal('available'),
  eventId: z.string().min(1),
  capturedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  home: z.number().min(0).max(1),
  draw: z.number().min(0).max(1),
  away: z.number().min(0).max(1),
  homeCleanSheetProbability: z.number().min(0).max(1).optional(),
  awayCleanSheetProbability: z.number().min(0).max(1).optional(),
  bookmakerCount: z.number().int().positive(),
});

const unavailableSnapshotSchema = z.object({
  status: z.literal('unavailable'),
  fixtureIdentityVersion: z.number().int().positive().optional(),
  reason: z.literal('market_not_offered').optional(),
  // Retain a discovered provider event identity so a later market supplement
  // can fetch that single event instead of another league-wide time window.
  eventId: z.string().min(1).optional(),
  checkedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export const MatchOddsSnapshotSchema = z.discriminatedUnion('status', [
  availableSnapshotSchema,
  unavailableSnapshotSchema,
]);
export type MatchOddsSnapshot = z.infer<typeof MatchOddsSnapshotSchema>;

export type FixtureOdds = MatchProbabilities & {
  cleanSheetProbability?: number;
};

export interface MatchOddsSnapshotStore {
  get(fixtureKey: string): Promise<MatchOddsSnapshot | undefined>;
  getMany?(
    fixtureKeys: readonly string[],
  ): Promise<Map<string, MatchOddsSnapshot>>;
  set(fixtureKey: string, snapshot: MatchOddsSnapshot): void | Promise<void>;
  claimRefreshLease?(
    fixtureKey: string,
    requestGroup: string,
    ttlMs: number,
  ): Promise<boolean>;
  releaseRefreshLease?(
    fixtureKey: string,
    requestGroup: string,
  ): Promise<void>;
}

export class InMemoryMatchOddsSnapshotStore
  implements MatchOddsSnapshotStore
{
  private readonly entries = new Map<string, MatchOddsSnapshot>();
  private readonly refreshLeases = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  async get(fixtureKey: string): Promise<MatchOddsSnapshot | undefined> {
    const snapshot = this.entries.get(fixtureKey);
    if (!snapshot) return undefined;
    if (Date.parse(snapshot.expiresAt) <= this.now()) {
      this.entries.delete(fixtureKey);
      return undefined;
    }
    if (
      snapshot.status === 'unavailable' &&
      snapshot.fixtureIdentityVersion !== FIXTURE_IDENTITY_VERSION
    ) {
      this.entries.delete(fixtureKey);
      return undefined;
    }
    return snapshot;
  }

  async getMany(
    fixtureKeys: readonly string[],
  ): Promise<Map<string, MatchOddsSnapshot>> {
    const uniqueKeys = [...new Set(fixtureKeys)];
    const values = await Promise.all(
      uniqueKeys.map(async (fixtureKey) => [
        fixtureKey,
        await this.get(fixtureKey),
      ] as const),
    );
    return new Map(
      values.flatMap(([fixtureKey, snapshot]) =>
        snapshot ? [[fixtureKey, snapshot] as const] : [],
      ),
    );
  }

  set(fixtureKey: string, snapshot: MatchOddsSnapshot): void {
    this.entries.set(fixtureKey, MatchOddsSnapshotSchema.parse(snapshot));
  }

  async claimRefreshLease(
    fixtureKey: string,
    requestGroup: string,
    ttlMs: number,
  ): Promise<boolean> {
    const key = `${requestGroup}:${fixtureKey}`;
    const expiresAt = this.refreshLeases.get(key);
    if (expiresAt !== undefined && expiresAt > this.now()) return false;
    this.refreshLeases.set(key, this.now() + Math.max(1, ttlMs));
    return true;
  }

  async releaseRefreshLease(
    fixtureKey: string,
    requestGroup: string,
  ): Promise<void> {
    this.refreshLeases.delete(`${requestGroup}:${fixtureKey}`);
  }
}

export interface FixtureMatchOddsProvider {
  load(
    players: readonly PlayerStats[],
    options?: { cacheOnly?: boolean },
  ): Promise<Map<string, FixtureOdds | null>>;
  supports(player: PlayerStats): boolean;
}

export async function readMatchOddsSnapshotsWithin(
  store: MatchOddsSnapshotStore,
  fixtureKeys: readonly string[],
  cacheOnly: boolean,
): Promise<Map<string, MatchOddsSnapshot>> {
  const uniqueKeys = [...new Set(fixtureKeys)];
  if (uniqueKeys.length === 0) return new Map();
  if (store.getMany) {
    return (
      (await settleCacheReadWithin(
        store.getMany(uniqueKeys),
        cacheOnly,
      )) ?? new Map()
    );
  }
  const reads = uniqueKeys.map(async (fixtureKey) => [
    fixtureKey,
    await settleCacheReadWithin(store.get(fixtureKey), cacheOnly),
  ] as const);
  const loaded = cacheOnly
    ? (await Promise.allSettled(reads)).flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      )
    : await Promise.all(reads);
  return new Map(
    loaded.flatMap(([fixtureKey, snapshot]) =>
      snapshot ? [[fixtureKey, snapshot] as const] : [],
    ),
  );
}

export class UnavailableFixtureMatchOddsProvider
  implements FixtureMatchOddsProvider
{
  supports(): boolean {
    return false;
  }

  async load(
    players: readonly PlayerStats[],
  ): Promise<Map<string, FixtureOdds | null>> {
    return new Map(
      players.map((player) => [playerMarketOddsKey(player), null]),
    );
  }
}

function needsMatchOddsSupplement(
  probabilities: MatchProbabilities | null | undefined,
): boolean {
  return (
    !probabilities ||
    probabilities.win === null ||
    probabilities.draw === null ||
    probabilities.loss === null
  );
}

function supplementMatchProbabilities(
  primary: MatchProbabilities | null | undefined,
  fallback: MatchProbabilities | null | undefined,
): MatchProbabilities | null {
  if (!primary) return fallback ?? null;
  if (!fallback || !needsMatchOddsSupplement(primary)) return primary;
  const merged = MatchProbabilitiesSchema.parse({
    win: primary.win ?? fallback.win,
    draw: primary.draw ?? fallback.draw,
    loss: primary.loss ?? fallback.loss,
  });
  return merged.win === null && merged.draw === null && merged.loss === null
    ? null
    : merged;
}

function supplementFixtureOdds(
  primary: FixtureOdds | null | undefined,
  fallback: FixtureOdds | null | undefined,
): FixtureOdds | null {
  const matchProbabilities = supplementMatchProbabilities(primary, fallback);
  const cleanSheetProbability =
    primary?.cleanSheetProbability ??
    fallback?.cleanSheetProbability ??
    null;
  if (!matchProbabilities && cleanSheetProbability === null) return null;
  return {
    ...(matchProbabilities ?? { win: null, draw: null, loss: null }),
    ...(cleanSheetProbability !== null ? { cleanSheetProbability } : {}),
  };
}

/**
 * Keeps paid match-odds fallbacks sequential on refreshes, while reading both
 * provider caches concurrently on the response path. The fallback only sees
 * fixtures (or individual H-D-A fields) the primary provider could not fill.
 */
export class SupplementingFixtureMatchOddsProvider
  implements FixtureMatchOddsProvider
{
  constructor(
    private readonly primary: FixtureMatchOddsProvider,
    private readonly fallback: FixtureMatchOddsProvider,
  ) {}

  supports(player: PlayerStats): boolean {
    return this.primary.supports(player) || this.fallback.supports(player);
  }

  async load(
    players: readonly PlayerStats[],
    loadOptions?: { cacheOnly?: boolean },
  ): Promise<Map<string, FixtureOdds | null>> {
    const primaryPlayers = players.filter((player) =>
      this.primary.supports(player),
    );
    let primaryValues: Map<string, FixtureOdds | null>;
    let fallbackValues: Map<string, FixtureOdds | null>;

    if (loadOptions?.cacheOnly) {
      const fallbackPlayers = players.filter((player) =>
        this.fallback.supports(player),
      );
      const [primaryResult, fallbackResult] = await Promise.allSettled([
        primaryPlayers.length > 0
          ? this.primary.load(primaryPlayers, loadOptions)
          : Promise.resolve(new Map<string, FixtureOdds | null>()),
        fallbackPlayers.length > 0
          ? this.fallback.load(fallbackPlayers, loadOptions)
          : Promise.resolve(new Map<string, FixtureOdds | null>()),
      ]);
      primaryValues =
        primaryResult.status === 'fulfilled'
          ? primaryResult.value
          : new Map<string, FixtureOdds | null>();
      fallbackValues =
        fallbackResult.status === 'fulfilled'
          ? fallbackResult.value
          : new Map<string, FixtureOdds | null>();
    } else {
      try {
        primaryValues =
          primaryPlayers.length > 0
            ? await this.primary.load(primaryPlayers, loadOptions)
            : new Map<string, FixtureOdds | null>();
      } catch {
        primaryValues = new Map<string, FixtureOdds | null>();
      }
      const fallbackPlayers = players.filter(
        (player) =>
          this.fallback.supports(player) &&
          needsMatchOddsSupplement(
            primaryValues.get(playerMarketOddsKey(player)),
          ),
      );
      try {
        fallbackValues =
          fallbackPlayers.length > 0
            ? await this.fallback.load(fallbackPlayers, loadOptions)
            : new Map<string, FixtureOdds | null>();
      } catch {
        fallbackValues = new Map<string, FixtureOdds | null>();
      }
    }

    return new Map(
      players.map((player) => {
        const key = playerMarketOddsKey(player);
        return [
          key,
          supplementFixtureOdds(
            primaryValues.get(key),
            fallbackValues.get(key),
          ),
        ];
      }),
    );
  }
}

export interface MatchOddsRoute {
  sportKeys: readonly string[];
  competitionSlugs: readonly string[];
  region: string;
  fallbackRegion?: string;
}

interface TheOddsApiFixtureMatchOddsOptions {
  apiKey: string;
  baseUrl: string;
  routes: readonly MatchOddsRoute[];
  fallbackWindowMs: number;
  missTtlMs: number;
  requestTimeoutMs: number;
  maxRetries: number;
  store: MatchOddsSnapshotStore;
  logger: AppLogger;
  usageStore?: ProviderQuotaUsageStore;
  refreshLeaseTtlMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

const outcomeSchema = z.object({
  name: z.string().min(1),
  price: z.number().finite().gt(1),
});

const eventSchema = z.object({
  id: z.string().min(1),
  commence_time: z.string().datetime(),
  home_team: z.string().min(1),
  away_team: z.string().min(1),
  bookmakers: z.array(
    z.object({
      key: z.string().min(1),
      title: z.string().min(1),
      markets: z.array(
        z.object({
          key: z.string().min(1),
          outcomes: z.array(outcomeSchema),
        }),
      ),
    }),
  ),
});
const eventsSchema = z.array(eventSchema);
type OddsEvent = z.infer<typeof eventSchema>;
type AvailableMatchOddsSnapshot = z.infer<typeof availableSnapshotSchema>;

interface JsonResponse {
  body: unknown;
  headers: Headers;
}

interface RouteFetchResult {
  unresolved: FixtureGroup[];
  complete: boolean;
  identityMatchedKeys: ReadonlySet<string>;
}

class OddsApiHttpError extends Error {
  constructor(readonly status: number) {
    super(`The Odds API returned HTTP ${status}`);
    this.name = 'OddsApiHttpError';
  }
}

const HOUR_MS = 60 * 60 * 1_000;
const MATCH_TOLERANCE_MS = 36 * HOUR_MS;
const SNAPSHOT_AFTER_KICKOFF_MS = 36 * HOUR_MS;
const defaultRefreshLeaseTtlMs = 90 * 1_000;
const retryStatuses = new Set([429, 502, 503, 504]);

function oddsApiDate(timestamp: number): string {
  return new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[middle] ?? 0;
  return ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2;
}

function retryDelayMs(value: string | null, attempt: number): number {
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const at = Date.parse(value);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  return Math.min(8_000, 500 * 2 ** attempt);
}

function eventProbabilities(
  event: OddsEvent,
): Omit<
  z.infer<typeof availableSnapshotSchema>,
  'status' | 'eventId' | 'capturedAt' | 'expiresAt'
> | null {
  const bookmakerProbabilities: Array<{
    home: number;
    draw: number;
    away: number;
  }> = [];
  const homeName = normalizeTeamName(event.home_team);
  const awayName = normalizeTeamName(event.away_team);

  for (const bookmaker of event.bookmakers) {
    const market = bookmaker.markets.find(
      (candidate) =>
        candidate.key === 'h2h' || candidate.key === 'h2h_3_way',
    );
    if (!market) continue;
    const home = market.outcomes.find(
      (outcome) => normalizeTeamName(outcome.name) === homeName,
    );
    const away = market.outcomes.find(
      (outcome) => normalizeTeamName(outcome.name) === awayName,
    );
    const draw = market.outcomes.find((outcome) =>
      ['draw', 'tie'].includes(outcome.name.trim().toLocaleLowerCase()),
    );
    if (!home || !draw || !away) continue;
    const raw = {
      home: 1 / home.price,
      draw: 1 / draw.price,
      away: 1 / away.price,
    };
    const total = raw.home + raw.draw + raw.away;
    bookmakerProbabilities.push({
      home: raw.home / total,
      draw: raw.draw / total,
      away: raw.away / total,
    });
  }

  if (bookmakerProbabilities.length === 0) return null;
  const medians = {
    home: median(bookmakerProbabilities.map(({ home }) => home)),
    draw: median(bookmakerProbabilities.map(({ draw }) => draw)),
    away: median(bookmakerProbabilities.map(({ away }) => away)),
  };
  const total = medians.home + medians.draw + medians.away;
  return {
    home: medians.home / total,
    draw: medians.draw / total,
    away: medians.away / total,
    bookmakerCount: bookmakerProbabilities.length,
  };
}

function eventFixtureKey(event: OddsEvent): string | null {
  const kickoff = Date.parse(event.commence_time);
  if (!Number.isFinite(kickoff)) return null;
  return [
    new Date(kickoff).toISOString(),
    normalizeTeamName(event.home_team),
    normalizeTeamName(event.away_team),
  ].join('|');
}

function availableSnapshotForEvent(
  event: OddsEvent,
  capturedAt: string,
): AvailableMatchOddsSnapshot | null {
  const probabilities = eventProbabilities(event);
  if (!probabilities) return null;
  return availableSnapshotSchema.parse({
    status: 'available',
    eventId: event.id,
    capturedAt,
    expiresAt: new Date(
      Date.parse(event.commence_time) + SNAPSHOT_AFTER_KICKOFF_MS,
    ).toISOString(),
    ...probabilities,
  });
}

export function matchProbabilitiesForPlayer(
  player: PlayerStats,
  snapshot: z.infer<typeof availableSnapshotSchema>,
): MatchProbabilities | null {
  const fixture = player.nextGame;
  if (
    !fixture?.playerTeamName ||
    !fixture.homeTeamName ||
    !fixture.awayTeamName
  ) {
    return null;
  }
  const playerTeam = normalizeTeamName(fixture.playerTeamName);
  if (playerTeam === normalizeTeamName(fixture.homeTeamName)) {
    return MatchProbabilitiesSchema.parse({
      win: snapshot.home,
      draw: snapshot.draw,
      loss: snapshot.away,
    });
  }
  if (playerTeam === normalizeTeamName(fixture.awayTeamName)) {
    return MatchProbabilitiesSchema.parse({
      win: snapshot.away,
      draw: snapshot.draw,
      loss: snapshot.home,
    });
  }
  return null;
}

export function cleanSheetProbabilityForPlayer(
  player: PlayerStats,
  snapshot: z.infer<typeof availableSnapshotSchema>,
): number | null {
  const fixture = player.nextGame;
  if (
    !fixture?.playerTeamName ||
    !fixture.homeTeamName ||
    !fixture.awayTeamName
  ) {
    return null;
  }
  const playerTeam = normalizeTeamName(fixture.playerTeamName);
  if (playerTeam === normalizeTeamName(fixture.homeTeamName)) {
    return snapshot.homeCleanSheetProbability ?? null;
  }
  if (playerTeam === normalizeTeamName(fixture.awayTeamName)) {
    return snapshot.awayCleanSheetProbability ?? null;
  }
  return null;
}

export function fixtureOddsForPlayer(
  player: PlayerStats,
  snapshot: z.infer<typeof availableSnapshotSchema>,
): FixtureOdds | null {
  const matchProbabilities = matchProbabilitiesForPlayer(player, snapshot);
  const cleanSheetProbability = cleanSheetProbabilityForPlayer(
    player,
    snapshot,
  );
  if (!matchProbabilities && cleanSheetProbability === null) return null;
  return {
    ...(matchProbabilities ?? { win: null, draw: null, loss: null }),
    ...(cleanSheetProbability !== null ? { cleanSheetProbability } : {}),
  };
}

export class TheOddsApiFixtureMatchOddsProvider
  implements FixtureMatchOddsProvider
{
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly routesByCompetition = new Map<string, MatchOddsRoute>();

  constructor(private readonly options: TheOddsApiFixtureMatchOddsOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? Date.now;
    for (const route of options.routes) {
      for (const competitionSlug of route.competitionSlugs) {
        const normalized = competitionSlug.trim().toLocaleLowerCase();
        if (!this.routesByCompetition.has(normalized)) {
          this.routesByCompetition.set(normalized, route);
        }
      }
    }
  }

  supports(player: PlayerStats): boolean {
    return this.routeFor(player) !== null && this.insideWindow(player);
  }

  async load(
    players: readonly PlayerStats[],
    loadOptions?: { cacheOnly?: boolean },
  ): Promise<Map<string, FixtureOdds | null>> {
    const output = new Map<string, FixtureOdds | null>(
      players.map((player) => [playerMarketOddsKey(player), null]),
    );
    const eligible = players.filter((player) => this.routeFor(player) !== null);
    const fixtures = this.groupAllFixtures(eligible);
    if (fixtures.length === 0) return output;

    const snapshots = new Map<string, MatchOddsSnapshot>();
    const missing: FixtureGroup[] = [];
    const storedSnapshots = await readMatchOddsSnapshotsWithin(
      this.options.store,
      fixtures.map(({ key }) => key),
      loadOptions?.cacheOnly === true,
    );
    for (const fixture of fixtures) {
      const storedSnapshot = storedSnapshots.get(fixture.key);
      const snapshot =
        storedSnapshot && this.snapshotIsReusable(storedSnapshot)
          ? storedSnapshot
          : undefined;
      if (snapshot) snapshots.set(fixture.key, snapshot);
      if (
        !snapshot &&
        fixture.players.some((player) => this.insideWindow(player))
      ) {
        missing.push(fixture);
      }
    }

    const protection = loadOptions?.cacheOnly
      ? protectionForUsage(undefined)
      : await providerProtection(
          this.options.usageStore,
          'the-odds-api',
          this.options.logger,
          this.now(),
        );
    if (
      !loadOptions?.cacheOnly &&
      protection.allowExternalRequests &&
      missing.length > 0
    ) {
      for (const route of this.options.routes) {
        const candidates = missing.filter((fixture) =>
          fixture.players.some((player) => this.routeFor(player) === route),
        );
        const requestGroup = [
          'the-odds-api',
          'match-odds',
          ...route.sportKeys,
          route.region,
        ].join(':');
        const routeFixtures = (
          await Promise.all(
            candidates.map(async (fixture) => {
              const ownsLease = this.options.store.claimRefreshLease
                ? await this.options.store.claimRefreshLease(
                    fixture.key,
                    requestGroup,
                    this.options.refreshLeaseTtlMs ??
                      defaultRefreshLeaseTtlMs,
                  )
                : true;
              if (!ownsLease) {
                this.options.logger.debug(
                  {
                    fixture: fixture.key,
                    requestGroup,
                  },
                  'External H-D-A refresh skipped because another Worker owns the lease',
                );
              }
              return ownsLease ? fixture : null;
            }),
          )
        ).filter((fixture): fixture is FixtureGroup => fixture !== null);
        if (routeFixtures.length === 0) continue;
        const primary = await this.fetchRoute(
          route,
          routeFixtures,
          route.region,
          snapshots,
        );
        let unresolved = primary.unresolved;
        let missCheckComplete = primary.complete;
        const identityMatchedKeys = new Set(primary.identityMatchedKeys);
        if (
          unresolved.length > 0 &&
          route.fallbackRegion &&
          route.fallbackRegion !== route.region &&
          protection.allowRegionalFallback
        ) {
          const fallback = await this.fetchRoute(
            route,
            unresolved,
            route.fallbackRegion,
            snapshots,
          );
          unresolved = fallback.unresolved;
          missCheckComplete = missCheckComplete && fallback.complete;
          for (const key of fallback.identityMatchedKeys) {
            identityMatchedKeys.add(key);
          }
        }
        if (!missCheckComplete) {
          await Promise.all(
            unresolved.map((fixture) =>
              this.options.store.releaseRefreshLease?.(
                fixture.key,
                requestGroup,
              ),
            ),
          );
        }
        if (missCheckComplete) {
          for (const fixture of unresolved) {
            if (snapshots.has(fixture.key)) continue;
            if (!identityMatchedKeys.has(fixture.key)) {
              await this.options.store.releaseRefreshLease?.(
                fixture.key,
                requestGroup,
              );
              this.options.logger.warn(
                {
                  event: 'fixture_identity_unresolved',
                  provider: 'the-odds-api',
                  fixture: fixture.key,
                },
                'External H-D-A fixture identity could not be resolved; no match-odds miss stored',
              );
              continue;
            }
            const snapshot = MatchOddsSnapshotSchema.parse({
              status: 'unavailable',
              fixtureIdentityVersion: FIXTURE_IDENTITY_VERSION,
              reason: 'market_not_offered',
              checkedAt: new Date(this.now()).toISOString(),
              expiresAt: new Date(
                Math.min(
                  Date.parse(fixture.date),
                  this.now() + this.options.missTtlMs,
                ),
              ).toISOString(),
            });
            await this.options.store.set(fixture.key, snapshot);
            snapshots.set(fixture.key, snapshot);
          }
        }
      }
    }

    for (const fixture of fixtures) {
      const snapshot = snapshots.get(fixture.key);
      if (snapshot?.status !== 'available') continue;
      for (const player of fixture.players) {
        output.set(
          playerMarketOddsKey(player),
          fixtureOddsForPlayer(player, snapshot),
        );
      }
    }
    return output;
  }

  private snapshotIsReusable(snapshot: MatchOddsSnapshot): boolean {
    if (snapshot.status === 'available') return true;
    if (snapshot.fixtureIdentityVersion !== FIXTURE_IDENTITY_VERSION) {
      return false;
    }
    const checkedAt = Date.parse(snapshot.checkedAt);
    return (
      Number.isFinite(checkedAt) &&
      checkedAt + this.options.missTtlMs > this.now()
    );
  }

  private routeFor(player: PlayerStats): MatchOddsRoute | null {
    const competitionSlug = player.nextGame?.competitionSlug;
    if (competitionSlug !== undefined) {
      if (competitionSlug === null) return null;
      return (
        this.routesByCompetition.get(
          competitionSlug.trim().toLocaleLowerCase(),
        ) ?? null
      );
    }
    // Legacy fixture snapshots have no competition slug. Preserve the
    // provider's deliberately narrow team-based compatibility check only for
    // those rows while current fixtures stay on the constant-time route.
    return (
      this.options.routes.find((route) =>
        supportsFixtureCompetition(player, route.competitionSlugs),
      ) ?? null
    );
  }

  private insideWindow(player: PlayerStats): boolean {
    const kickoff = Date.parse(player.nextGame?.date ?? '');
    const untilKickoff = kickoff - this.now();
    return (
      Number.isFinite(kickoff) &&
      untilKickoff >= 0 &&
      untilKickoff <= this.options.fallbackWindowMs
    );
  }

  private groupAllFixtures(players: readonly PlayerStats[]): FixtureGroup[] {
    return groupFixtures(players, { includeGoalkeepers: true });
  }

  private async fetchRoute(
    route: MatchOddsRoute,
    fixtures: readonly FixtureGroup[],
    region: string,
    snapshots: Map<string, MatchOddsSnapshot>,
  ): Promise<RouteFetchResult> {
    let unresolved = [...fixtures];
    let complete = true;
    const identityMatchedKeys = new Set<string>();
    for (const sportKey of route.sportKeys) {
      if (unresolved.length === 0) break;
      try {
        const from = oddsApiDate(
          Math.min(...unresolved.map(({ date }) => Date.parse(date))) -
            MATCH_TOLERANCE_MS,
        );
        const to = oddsApiDate(
          Math.max(...unresolved.map(({ date }) => Date.parse(date))) +
            MATCH_TOLERANCE_MS,
        );
        const response = await this.requestJson(
          `/sports/${encodeURIComponent(sportKey)}/odds`,
          {
            regions: region,
            markets: 'h2h',
            oddsFormat: 'decimal',
            commenceTimeFrom: from,
            commenceTimeTo: to,
          },
        );
        const events = eventsSchema.parse(response.body);
        const capturedAt = new Date(this.now()).toISOString();
        const usage = theOddsApiQuotaUsage(response.headers, capturedAt);
        if (usage && this.options.usageStore) {
          await this.options.usageStore.set(usage);
        }

        // One league request already contains every event in the requested
        // time range. Persist all usable H-D-A snapshots so opening another
        // card from the same match window does not spend another API credit.
        const eventSnapshots = new Map<string, AvailableMatchOddsSnapshot>();
        const snapshotWrites = new Map<
          string,
          AvailableMatchOddsSnapshot
        >();
        for (const event of events) {
          const eventKey = eventFixtureKey(event);
          const snapshot = availableSnapshotForEvent(event, capturedAt);
          if (!eventKey || !snapshot) continue;
          eventSnapshots.set(event.id, snapshot);
          snapshotWrites.set(eventKey, snapshot);
        }
        for (const fixture of unresolved) {
          const resolution = resolveProviderFixtureCandidates(
            fixture,
            events.map((event) => ({
              event,
              eventId: event.id,
              date: event.commence_time,
              homeTeamName: event.home_team,
              awayTeamName: event.away_team,
            })),
          );
          const event =
            resolution.status === 'matched' ? resolution.event : null;
          if (event) identityMatchedKeys.add(fixture.key);
          const snapshot = event ? eventSnapshots.get(event.id) : undefined;
          if (!snapshot) continue;
          snapshotWrites.set(fixture.key, snapshot);
        }
        for (const [fixtureKey, snapshot] of snapshotWrites) {
          await this.options.store.set(fixtureKey, snapshot);
          snapshots.set(fixtureKey, snapshot);
        }
        unresolved = unresolved.filter(
          (fixture) => !snapshots.has(fixture.key),
        );
        this.options.logger.info(
          {
            sportKey,
            region,
            requestedFixtures: fixtures.length,
            matchedFixtures: fixtures.length - unresolved.length,
            cachedEvents: snapshotWrites.size,
          },
          'External H-D-A fallback batch received',
        );
      } catch (error) {
        complete = false;
        this.options.logger.warn(
          {
            sportKey,
            region,
            error: error instanceof Error ? error.message : String(error),
          },
          'External H-D-A fallback batch failed',
        );
      }
    }
    return { unresolved, complete, identityMatchedKeys };
  }

  private async requestJson(
    path: string,
    query: Readonly<Record<string, string>>,
  ): Promise<JsonResponse> {
    const url = new URL(`${this.options.baseUrl}${path}`);
    url.search = new URLSearchParams({
      apiKey: this.options.apiKey,
      ...query,
    }).toString();
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.options.requestTimeoutMs,
      );
      try {
        const response = await this.fetchImpl(url, {
          signal: controller.signal,
        });
        if (!response.ok) throw new OddsApiHttpError(response.status);
        return { body: await response.json(), headers: response.headers };
      } catch (error) {
        if (
          attempt >= this.options.maxRetries ||
          (error instanceof OddsApiHttpError &&
            !retryStatuses.has(error.status))
        ) {
          throw error;
        }
        await this.sleep(retryDelayMs(null, attempt));
      } finally {
        clearTimeout(timeout);
      }
    }
  }
}
