import {
  MatchProbabilitiesSchema,
  type MatchProbabilities,
  type PlayerStats,
} from '@sorare-overlay/shared';
import { z } from 'zod';
import type { AppLogger } from '../logger.js';
import {
  groupFixtures,
  marketFixtureKey,
  normalizeTeamName,
  playerMarketOddsKey,
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
  bookmakerCount: z.number().int().positive(),
});

const unavailableSnapshotSchema = z.object({
  status: z.literal('unavailable'),
  checkedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export const MatchOddsSnapshotSchema = z.discriminatedUnion('status', [
  availableSnapshotSchema,
  unavailableSnapshotSchema,
]);
export type MatchOddsSnapshot = z.infer<typeof MatchOddsSnapshotSchema>;

export interface MatchOddsSnapshotStore {
  get(fixtureKey: string): Promise<MatchOddsSnapshot | undefined>;
  set(fixtureKey: string, snapshot: MatchOddsSnapshot): void | Promise<void>;
}

export class InMemoryMatchOddsSnapshotStore
  implements MatchOddsSnapshotStore
{
  private readonly entries = new Map<string, MatchOddsSnapshot>();

  constructor(private readonly now: () => number = Date.now) {}

  async get(fixtureKey: string): Promise<MatchOddsSnapshot | undefined> {
    const snapshot = this.entries.get(fixtureKey);
    if (!snapshot) return undefined;
    if (Date.parse(snapshot.expiresAt) <= this.now()) {
      this.entries.delete(fixtureKey);
      return undefined;
    }
    return snapshot;
  }

  set(fixtureKey: string, snapshot: MatchOddsSnapshot): void {
    this.entries.set(fixtureKey, MatchOddsSnapshotSchema.parse(snapshot));
  }
}

export interface FixtureMatchOddsProvider {
  load(
    players: readonly PlayerStats[],
    options?: { cacheOnly?: boolean },
  ): Promise<Map<string, MatchProbabilities | null>>;
  supports(player: PlayerStats): boolean;
}

export class UnavailableFixtureMatchOddsProvider
  implements FixtureMatchOddsProvider
{
  supports(): boolean {
    return false;
  }

  async load(
    players: readonly PlayerStats[],
  ): Promise<Map<string, MatchProbabilities | null>> {
    return new Map(
      players.map((player) => [playerMarketOddsKey(player), null]),
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

interface JsonResponse {
  body: unknown;
  headers: Headers;
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
const retryStatuses = new Set([429, 502, 503, 504]);

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

function findEvent(
  fixture: FixtureGroup,
  events: readonly OddsEvent[],
): OddsEvent | null {
  const home = normalizeTeamName(fixture.homeTeamName);
  const away = normalizeTeamName(fixture.awayTeamName);
  const kickoff = Date.parse(fixture.date);
  return (
    events
      .filter(
        (event) =>
          normalizeTeamName(event.home_team) === home &&
          normalizeTeamName(event.away_team) === away,
      )
      .map((event) => ({
        event,
        difference: Math.abs(Date.parse(event.commence_time) - kickoff),
      }))
      .filter(({ difference }) => difference <= MATCH_TOLERANCE_MS)
      .sort((left, right) => left.difference - right.difference)[0]?.event ??
    null
  );
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

function playerProbabilities(
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

export class TheOddsApiFixtureMatchOddsProvider
  implements FixtureMatchOddsProvider
{
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly options: TheOddsApiFixtureMatchOddsOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? Date.now;
  }

  supports(player: PlayerStats): boolean {
    return this.routeFor(player) !== null && this.insideWindow(player);
  }

  async load(
    players: readonly PlayerStats[],
    loadOptions?: { cacheOnly?: boolean },
  ): Promise<Map<string, MatchProbabilities | null>> {
    const output = new Map<string, MatchProbabilities | null>(
      players.map((player) => [playerMarketOddsKey(player), null]),
    );
    const eligible = players.filter((player) => this.routeFor(player) !== null);
    const fixtures = this.groupAllFixtures(eligible);
    if (fixtures.length === 0) return output;

    const snapshots = new Map<string, MatchOddsSnapshot>();
    const missing: FixtureGroup[] = [];
    for (const fixture of fixtures) {
      const snapshot = await this.options.store.get(fixture.key);
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
        const routeFixtures = missing.filter((fixture) =>
          fixture.players.some((player) => this.routeFor(player) === route),
        );
        if (routeFixtures.length === 0) continue;
        const unresolved = await this.fetchRoute(
          route,
          routeFixtures,
          route.region,
          snapshots,
        );
        if (
          unresolved.length > 0 &&
          route.fallbackRegion &&
          route.fallbackRegion !== route.region &&
          protection.allowRegionalFallback
        ) {
          await this.fetchRoute(
            route,
            unresolved,
            route.fallbackRegion,
            snapshots,
          );
        }
        for (const fixture of unresolved) {
          if (snapshots.has(fixture.key)) continue;
          const snapshot = MatchOddsSnapshotSchema.parse({
            status: 'unavailable',
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

    for (const fixture of fixtures) {
      const snapshot = snapshots.get(fixture.key);
      if (snapshot?.status !== 'available') continue;
      for (const player of fixture.players) {
        output.set(
          playerMarketOddsKey(player),
          playerProbabilities(player, snapshot),
        );
      }
    }
    return output;
  }

  private routeFor(player: PlayerStats): MatchOddsRoute | null {
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
  ): Promise<FixtureGroup[]> {
    let unresolved = [...fixtures];
    for (const sportKey of route.sportKeys) {
      if (unresolved.length === 0) break;
      try {
        const from = new Date(
          Math.min(...unresolved.map(({ date }) => Date.parse(date))) -
            MATCH_TOLERANCE_MS,
        ).toISOString();
        const to = new Date(
          Math.max(...unresolved.map(({ date }) => Date.parse(date))) +
            MATCH_TOLERANCE_MS,
        ).toISOString();
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
        for (const fixture of unresolved) {
          const event = findEvent(fixture, events);
          const probabilities = event ? eventProbabilities(event) : null;
          if (!event || !probabilities) continue;
          const snapshot = MatchOddsSnapshotSchema.parse({
            status: 'available',
            eventId: event.id,
            capturedAt,
            expiresAt: new Date(
              Date.parse(fixture.date) + SNAPSHOT_AFTER_KICKOFF_MS,
            ).toISOString(),
            ...probabilities,
          });
          await this.options.store.set(fixture.key, snapshot);
          snapshots.set(fixture.key, snapshot);
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
          },
          'External H-D-A fallback batch received',
        );
      } catch (error) {
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
    return unresolved;
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
