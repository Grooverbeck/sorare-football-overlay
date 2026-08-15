import {
  MarketProbabilitySchema,
  PlayerMarketOddsSchema,
  type BookmakerMarketQuote,
  type MatchProbabilities,
  type PlayerMarketOdds,
  type PlayerStats,
} from '@sorare-overlay/shared';
import { z } from 'zod';
import type { AppLogger } from '../logger.js';
import {
  cacheOnlySnapshotReadBudgetMs,
  FrozenMarketSnapshotSchema,
  groupFixtures,
  marketFixtureKey,
  missingMarketSnapshot,
  needsFrozenSnapshotSupplement,
  normalizePlayerName,
  playerMarketOddsKey,
  playerProbability,
  providerTeamNamesMatch,
  recordFrozenSnapshotCheck,
  readMarketSnapshotsWithin,
  settleCacheReadWithin,
  shouldRetryMarketFailure,
  supplementFrozenSnapshot,
  supportsFixtureCompetition,
  supportsPlayerCompetition,
  type FixtureGroup,
  type FrozenMarketSnapshot,
  type MarketSnapshot,
  type MarketSnapshotStore,
  type OddsMarketKey,
  type PlayerMarketOddsLoadOptions,
  type PlayerMarketOddsProvider,
  type PlayerMarketField,
} from './market-odds-provider.js';
import {
  MatchOddsSnapshotSchema,
  matchProbabilitiesForPlayer,
  type FixtureMatchOddsProvider,
  type MatchOddsSnapshot,
  type MatchOddsSnapshotStore,
} from './match-odds-provider.js';
import {
  protectionForUsage,
  quotaUsage,
  type OddsUsageProtection,
  type ProviderQuotaUsage,
  type ProviderQuotaUsageStore,
} from './odds-usage.js';
import type { OddsApiIoRoute } from './competition-odds-routes.js';

const OddsApiIoEventSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  date: z.string().datetime(),
  home: z.string().min(1),
  away: z.string().min(1),
});

const OddsApiIoEventsSchema = z.array(OddsApiIoEventSchema);
type OddsApiIoEvent = z.infer<typeof OddsApiIoEventSchema>;

const OddsApiIoDecimalOddSchema = z.union([z.string(), z.number()]);

const OddsApiIoMarketOddSchema = z.object({
  // Team and totals markets in the same response legitimately use
  // `label: null`. They are irrelevant for player props and must not make the
  // complete event response fail validation.
  label: z.string().min(1).nullable().optional(),
  home: OddsApiIoDecimalOddSchema.optional(),
  draw: OddsApiIoDecimalOddSchema.optional(),
  away: OddsApiIoDecimalOddSchema.optional(),
  over: OddsApiIoDecimalOddSchema.optional(),
  // Normalized labelled markets use `odds`; older Bet365 player props still
  // expose the same one-sided price as `over`. Accept both payload shapes.
  odds: OddsApiIoDecimalOddSchema.optional(),
  yes: OddsApiIoDecimalOddSchema.optional(),
});

const OddsApiIoMarketSchema = z.object({
  name: z.string().min(1),
  updatedAt: z.string().optional(),
  odds: z.array(OddsApiIoMarketOddSchema),
});

const OddsApiIoEventOddsSchema = OddsApiIoEventSchema.extend({
  bookmakers: z.record(z.string(), z.array(OddsApiIoMarketSchema)),
});

const OddsApiIoMultiOddsSchema = z.array(OddsApiIoEventOddsSchema);
type OddsApiIoEventOdds = z.infer<typeof OddsApiIoEventOddsSchema>;

interface OddsApiIoOptions {
  apiKey: string;
  baseUrl: string;
  bookmakers: readonly string[];
  routes: readonly OddsApiIoRoute[];
  fetchWindowMs: number;
  dailyRequestLimit: number;
  hourlyRequestLimit: number;
  requestTimeoutMs: number;
  maxRetries: number;
  store: MarketSnapshotStore;
  matchOddsStore?: MatchOddsSnapshotStore;
  matchOddsMissTtlMs?: number;
  matchOddsFallbackWindowMs?: number;
  logger: AppLogger;
  usageStore?: ProviderQuotaUsageStore;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export function oddsApiIoFixtureStoreKey(
  nextGame: NonNullable<PlayerStats['nextGame']>,
): string | null {
  const key = marketFixtureKey(nextGame);
  return key ? fixtureStoreKey(key) : null;
}

class OddsApiIoHttpError extends Error {
  constructor(readonly status: number) {
    super(`Odds-API.io returned HTTP ${status}`);
    this.name = 'OddsApiIoHttpError';
  }
}

const ODDS_API_IO_REFRESH_LEASE_MS = 90 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;
const ODDS_API_IO_MATCH_SNAPSHOT_AFTER_KICKOFF_MS = 36 * HOUR_MS;
const DEFAULT_MATCH_ODDS_MISS_TTL_MS = 6 * HOUR_MS;

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function retryDelayMs(value: string | null, attempt: number): number {
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const at = Date.parse(value);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }
  return Math.min(8_000, 500 * 2 ** attempt);
}

function nonnegativeIntegerHeader(
  headers: Headers,
  name: string,
): number | null {
  const value = headers.get(name);
  if (value === null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed)
    : null;
}

function resetTimeFromHeaders(headers: Headers, now: number): number | null {
  const rateLimitReset = headers.get('x-ratelimit-reset');
  if (rateLimitReset) {
    const parsedDate = Date.parse(rateLimitReset);
    if (Number.isFinite(parsedDate) && parsedDate > now) return parsedDate;
    const numeric = Number(rateLimitReset);
    if (Number.isFinite(numeric)) {
      const milliseconds = numeric > 10_000_000_000
        ? numeric
        : numeric * 1_000;
      if (milliseconds > now) return milliseconds;
    }
  }
  const retryAfter = headers.get('retry-after');
  if (!retryAfter) return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return now + seconds * 1_000;
  }
  const parsedDate = Date.parse(retryAfter);
  return Number.isFinite(parsedDate) && parsedDate > now
    ? parsedDate
    : null;
}

function fixtureStoreKey(fixtureKey: string): string {
  return `odds-api-io|${fixtureKey}`;
}

function rfc3339Seconds(value: number): string {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[middle] ?? 0;
  return ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2;
}

function findEvent(
  fixture: FixtureGroup,
  events: readonly OddsApiIoEvent[],
): OddsApiIoEvent | null {
  const kickoff = Date.parse(fixture.date);
  const candidates = events
    .filter(
      (event) =>
        providerTeamNamesMatch(event.home, fixture.homeTeamName) &&
        providerTeamNamesMatch(event.away, fixture.awayTeamName),
    )
    .map((event) => ({
      event,
      difference: Math.abs(Date.parse(event.date) - kickoff),
    }))
    .filter(({ difference }) => difference <= 36 * 60 * 60 * 1_000)
    .sort((left, right) => left.difference - right.difference);
  return candidates[0]?.event ?? null;
}

function labelledPlayerSnapshot(
  response: OddsApiIoEventOdds,
  capturedAt: string,
  market: OddsMarketKey,
  providerMarketNames: readonly string[],
): FrozenMarketSnapshot | null {
  const normalizedMarketNames = new Set(
    providerMarketNames.map((name) => name.trim().toLocaleLowerCase()),
  );
  const quotesByPlayer = new Map<string, BookmakerMarketQuote[]>();
  for (const [bookmaker, markets] of Object.entries(response.bookmakers)) {
    const providerMarket = markets.find(({ name }) =>
      normalizedMarketNames.has(name.trim().toLocaleLowerCase()),
    );
    if (!providerMarket) continue;
    for (const odd of providerMarket.odds) {
      if (!odd.label) continue;
      const price =
        decimalOdd(odd.over) ??
        decimalOdd(odd.odds) ??
        decimalOdd(odd.yes);
      if (price === null) continue;
      const playerName = normalizePlayerName(odd.label);
      if (!playerName) continue;
      const playerQuotes = quotesByPlayer.get(playerName) ?? [];
      playerQuotes.push({
        key: bookmaker.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-'),
        title: bookmaker,
        decimalOdds: price,
        probability: Math.min(1, 1 / price),
      });
      quotesByPlayer.set(playerName, playerQuotes);
    }
  }
  if (quotesByPlayer.size === 0) return null;
  return FrozenMarketSnapshotSchema.parse({
    status: 'available',
    market,
    eventId: response.id,
    capturedAt,
    players: Object.fromEntries(
      [...quotesByPlayer].map(([playerName, quotes]) => [
        playerName,
        MarketProbabilitySchema.parse({
          probability: median(quotes.map(({ probability }) => probability)),
          bookmakerCount: quotes.length,
          bookmakerQuotes: [...quotes].sort((left, right) =>
            left.title.localeCompare(right.title),
          ),
        }),
      ]),
    ),
  });
}

function anytimeGoalscorerSnapshot(
  response: OddsApiIoEventOdds,
  capturedAt: string,
): FrozenMarketSnapshot | null {
  return labelledPlayerSnapshot(
    response,
    capturedAt,
    'player_goal_scorer_anytime',
    ['Anytime Goalscorer'],
  );
}

function playerAssistSnapshot(
  response: OddsApiIoEventOdds,
  capturedAt: string,
): FrozenMarketSnapshot | null {
  return labelledPlayerSnapshot(
    response,
    capturedAt,
    'player_assists',
    ['Player To Assist'],
  );
}

function decimalOdd(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 1 ? parsed : null;
}

function matchOddsSnapshot(
  response: OddsApiIoEventOdds,
  capturedAt: string,
): MatchOddsSnapshot | null {
  const bookmakerProbabilities: Array<{
    home: number;
    draw: number;
    away: number;
  }> = [];
  for (const markets of Object.values(response.bookmakers)) {
    const market = markets.find(({ name }) =>
      ['ml', 'full time result', 'match result'].includes(
        name.trim().toLocaleLowerCase(),
      ),
    );
    const line = market?.odds.find(
      (odd) =>
        decimalOdd(odd.home) !== null &&
        decimalOdd(odd.draw) !== null &&
        decimalOdd(odd.away) !== null,
    );
    if (!line) continue;
    const home = decimalOdd(line.home);
    const draw = decimalOdd(line.draw);
    const away = decimalOdd(line.away);
    if (home === null || draw === null || away === null) continue;
    const raw = { home: 1 / home, draw: 1 / draw, away: 1 / away };
    const total = raw.home + raw.draw + raw.away;
    bookmakerProbabilities.push({
      home: raw.home / total,
      draw: raw.draw / total,
      away: raw.away / total,
    });
  }
  if (bookmakerProbabilities.length === 0) return null;
  const probabilities = {
    home: median(bookmakerProbabilities.map(({ home }) => home)),
    draw: median(bookmakerProbabilities.map(({ draw }) => draw)),
    away: median(bookmakerProbabilities.map(({ away }) => away)),
  };
  const total = probabilities.home + probabilities.draw + probabilities.away;
  return MatchOddsSnapshotSchema.parse({
    status: 'available',
    eventId: response.id,
    capturedAt,
    expiresAt: new Date(
      Date.parse(response.date) + ODDS_API_IO_MATCH_SNAPSHOT_AFTER_KICKOFF_MS,
    ).toISOString(),
    home: probabilities.home / total,
    draw: probabilities.draw / total,
    away: probabilities.away / total,
    bookmakerCount: bookmakerProbabilities.length,
  });
}

function currentUsage(
  usage: ProviderQuotaUsage | undefined,
  provider: 'odds-api-io' | 'odds-api-io-hourly',
  now: number,
): ProviderQuotaUsage | undefined {
  if (!usage || usage.provider !== provider) return undefined;
  const endsAt = usage.interval.endsAt
    ? Date.parse(usage.interval.endsAt)
    : Number.NaN;
  return Number.isFinite(endsAt) && endsAt <= now ? undefined : usage;
}

const protectionOrder = [
  'normal',
  'warning',
  'fallback-disabled',
  'essential-only',
  'cache-only',
  'stopped',
] as const;

function stricterProtection(
  left: OddsUsageProtection,
  right: OddsUsageProtection,
): OddsUsageProtection {
  const level =
    protectionOrder.indexOf(left.level) >= protectionOrder.indexOf(right.level)
      ? left.level
      : right.level;
  const ratios = [left.ratio, right.ratio].filter(
    (value): value is number => value !== null,
  );
  return {
    level,
    ratio: ratios.length > 0 ? Math.max(...ratios) : null,
    allowExternalRequests:
      left.allowExternalRequests && right.allowExternalRequests,
    allowRegionalFallback:
      left.allowRegionalFallback && right.allowRegionalFallback,
    allowSnapshotSupplements:
      left.allowSnapshotSupplements && right.allowSnapshotSupplements,
  };
}

export class OddsApiIoPlayerMarketOddsProvider
  implements PlayerMarketOddsProvider
{
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly options: OddsApiIoOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  supports(player: PlayerStats): boolean {
    return this.supportsMarket(player, 'goal');
  }

  supportsMarket(player: PlayerStats, market: PlayerMarketField): boolean {
    const route = this.routeForPlayer(player);
    return (
      market === 'goal' &&
      route !== null &&
      (route.playerMarkets ?? ['goal']).includes(market)
    );
  }

  supportsMatchOdds(player: PlayerStats): boolean {
    const route = this.routeForFixture(player);
    return (
      Boolean(this.options.matchOddsStore) &&
      route?.matchOdds === true &&
      this.insideWindow(
        player.nextGame?.date,
        this.options.matchOddsFallbackWindowMs ?? this.options.fetchWindowMs,
      )
    );
  }

  async refreshUsage(): Promise<ProviderQuotaUsage[]> {
    const now = this.now();
    const [daily, hourly] = await Promise.all([
      this.options.usageStore?.get('odds-api-io'),
      this.options.usageStore?.get('odds-api-io-hourly'),
    ]);
    return [
      currentUsage(daily, 'odds-api-io', now),
      currentUsage(hourly, 'odds-api-io-hourly', now),
    ].filter((usage): usage is ProviderQuotaUsage => Boolean(usage));
  }

  async load(
    players: readonly PlayerStats[],
    loadOptions?: PlayerMarketOddsLoadOptions,
  ): Promise<Map<string, PlayerMarketOdds | null>> {
    const output = new Map<string, PlayerMarketOdds | null>(
      players.map((player) => [playerMarketOddsKey(player), null]),
    );
    const fixtures = groupFixtures(
      players.filter((player) => this.supports(player)),
    );
    if (fixtures.length === 0) return output;

    const protection = loadOptions?.cacheOnly
      ? protectionForUsage(undefined)
      : await this.protection();
    const goalSnapshots = new Map<string, MarketSnapshot | undefined>();
    const assistSnapshots = new Map<string, MarketSnapshot | undefined>();
    const pending: FixtureGroup[] = [];

    const cacheOnly = loadOptions?.cacheOnly === true;
    if (cacheOnly) {
      const loaded = await readMarketSnapshotsWithin(
        this.options.store,
        fixtures.flatMap((fixture) => [
          {
            fixtureKey: fixtureStoreKey(fixture.key),
            market: 'player_goal_scorer_anytime' as const,
          },
          {
            fixtureKey: fixtureStoreKey(fixture.key),
            market: 'player_assists' as const,
          },
        ]),
        true,
        cacheOnlySnapshotReadBudgetMs(loadOptions),
      );
      for (const [index, fixture] of fixtures.entries()) {
        goalSnapshots.set(fixture.key, loaded[index * 2]);
        assistSnapshots.set(fixture.key, loaded[index * 2 + 1]);
      }
    }

    for (const fixture of fixtures) {
      const [goalSnapshot, assistSnapshot] = cacheOnly
        ? [goalSnapshots.get(fixture.key), assistSnapshots.get(fixture.key)]
        : await Promise.all([
            this.options.store.get(
              fixtureStoreKey(fixture.key),
              'player_goal_scorer_anytime',
            ),
            this.options.store.get(
              fixtureStoreKey(fixture.key),
              'player_assists',
            ),
          ]);
      goalSnapshots.set(fixture.key, goalSnapshot);
      assistSnapshots.set(fixture.key, assistSnapshot);
      const kickoff = Date.parse(fixture.date);
      const untilKickoff = kickoff - this.now();
      const route = this.routeForFixtureGroup(fixture);
      const fetchWindowMs =
        route?.playerFetchWindowMs ?? this.options.fetchWindowMs;
      if (untilKickoff < 0 || untilKickoff > fetchWindowMs) {
        continue;
      }
      const needsApi =
        !goalSnapshot ||
        (goalSnapshot.status === 'unavailable'
          ? shouldRetryMarketFailure(goalSnapshot, kickoff, this.now())
          : protection.allowSnapshotSupplements &&
            needsFrozenSnapshotSupplement(
              goalSnapshot,
              fixture.players,
              fixture.date,
              this.now(),
            ));
      if (
        needsApi &&
        !cacheOnly &&
        protection.allowExternalRequests
      ) {
        const requestGroup = this.refreshRequestGroup(fixture);
        const claimed = this.options.store.claimRefreshLease
          ? await this.options.store.claimRefreshLease(
              fixture.key,
              requestGroup,
              ODDS_API_IO_REFRESH_LEASE_MS,
            )
          : true;
        if (claimed) {
          pending.push(fixture);
        } else {
          this.options.logger.debug(
            {
              provider: 'odds-api-io',
              fixture: fixture.key,
              requestGroup,
            },
            'Odds-API.io fixture refresh skipped because another Worker owns the lease',
          );
        }
      }
    }

    if (pending.length > 0) {
      await this.refreshFixtures(
        pending,
        goalSnapshots,
        assistSnapshots,
      );
    }

    for (const fixture of fixtures) {
      const goalSnapshot = goalSnapshots.get(fixture.key);
      const assistSnapshot = assistSnapshots.get(fixture.key);
      const availableGoal =
        goalSnapshot?.status === 'available' ? goalSnapshot : undefined;
      const availableAssist =
        assistSnapshot?.status === 'available' ? assistSnapshot : undefined;
      for (const player of fixture.players) {
        const goal = playerProbability(
          availableGoal,
          player,
          fixture.players,
        );
        const assist = playerProbability(
          availableAssist,
          player,
          fixture.players,
        );
        if (!goal && !assist) continue;
        const capturedAt = [
          availableGoal?.capturedAt,
          availableAssist?.capturedAt,
        ]
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1);
        if (!capturedAt) continue;
        output.set(
          playerMarketOddsKey(player),
          PlayerMarketOddsSchema.parse({
            source: 'odds-api-io',
            capturedAt,
            goal,
            assist,
          }),
        );
      }
    }
    return output;
  }

  async loadMatchOdds(
    players: readonly PlayerStats[],
    loadOptions?: { cacheOnly?: boolean },
  ): Promise<Map<string, MatchProbabilities | null>> {
    const output = new Map<string, MatchProbabilities | null>(
      players.map((player) => [playerMarketOddsKey(player), null]),
    );
    const store = this.options.matchOddsStore;
    if (!store) return output;
    const fixtures = groupFixtures(
      players.filter((player) => this.routeForMatch(player) !== null),
      { includeGoalkeepers: true },
    );
    if (fixtures.length === 0) return output;

    const cacheOnly = loadOptions?.cacheOnly === true;
    const matchSnapshots = new Map<string, MatchOddsSnapshot | undefined>();
    const reads = fixtures.map(async (fixture) => ({
      fixture,
      snapshot: await settleCacheReadWithin(
        store.get(fixtureStoreKey(fixture.key)),
        cacheOnly,
      ),
    }));
    const loaded = cacheOnly
      ? (await Promise.allSettled(reads)).flatMap((result) =>
          result.status === 'fulfilled' ? [result.value] : [],
        )
      : await Promise.all(reads);
    const pending: FixtureGroup[] = [];
    for (const { fixture, snapshot } of loaded) {
      matchSnapshots.set(fixture.key, snapshot);
      if (
        !snapshot &&
        this.insideWindow(
          fixture.date,
          this.options.matchOddsFallbackWindowMs ??
            this.options.fetchWindowMs,
        )
      ) {
        pending.push(fixture);
      }
    }

    const protection = cacheOnly
      ? protectionForUsage(undefined)
      : await this.protection();
    if (
      !cacheOnly &&
      protection.allowExternalRequests &&
      pending.length > 0
    ) {
      const claimed = (
        await Promise.all(
          pending.map(async (fixture) => {
            const requestGroup = this.refreshRequestGroup(fixture);
            const ownsLease = this.options.store.claimRefreshLease
              ? await this.options.store.claimRefreshLease(
                  fixture.key,
                  requestGroup,
                  ODDS_API_IO_REFRESH_LEASE_MS,
                )
              : true;
            if (!ownsLease) {
              this.options.logger.debug(
                {
                  provider: 'odds-api-io',
                  fixture: fixture.key,
                  requestGroup,
                },
                'Odds-API.io fixture refresh skipped because another Worker owns the lease',
              );
            }
            return ownsLease ? fixture : null;
          }),
        )
      ).filter((fixture): fixture is FixtureGroup => fixture !== null);
      if (claimed.length > 0) {
        const goalSnapshots = new Map<
          string,
          MarketSnapshot | undefined
        >();
        const assistSnapshots = new Map<
          string,
          MarketSnapshot | undefined
        >();
        await Promise.all(
          claimed.map(async (fixture) => {
            const [goalSnapshot, assistSnapshot] = await Promise.all([
              this.options.store.get(
                fixtureStoreKey(fixture.key),
                'player_goal_scorer_anytime',
              ),
              this.options.store.get(
                fixtureStoreKey(fixture.key),
                'player_assists',
              ),
            ]);
            goalSnapshots.set(fixture.key, goalSnapshot);
            assistSnapshots.set(fixture.key, assistSnapshot);
          }),
        );
        await this.refreshFixtures(
          claimed,
          goalSnapshots,
          assistSnapshots,
          matchSnapshots,
        );
      }
    }

    for (const fixture of fixtures) {
      const snapshot = matchSnapshots.get(fixture.key);
      if (snapshot?.status !== 'available') continue;
      for (const player of fixture.players) {
        output.set(
          playerMarketOddsKey(player),
          matchProbabilitiesForPlayer(player, snapshot),
        );
      }
    }
    return output;
  }

  private async protection(): Promise<OddsUsageProtection> {
    try {
      const now = this.now();
      const [daily, hourly] = await Promise.all([
        this.options.usageStore?.get('odds-api-io'),
        this.options.usageStore?.get('odds-api-io-hourly'),
      ]);
      return stricterProtection(
        protectionForUsage(
          currentUsage(daily, 'odds-api-io', now),
          now,
        ),
        protectionForUsage(
          currentUsage(hourly, 'odds-api-io-hourly', now),
          now,
        ),
      );
    } catch (error) {
      this.options.logger.warn(
        {
          provider: 'odds-api-io',
          error: error instanceof Error ? error.message : String(error),
        },
        'Odds-API.io quota state unavailable; retaining cache safeguards',
      );
      return protectionForUsage(undefined);
    }
  }

  private async refreshFixtures(
    fixtures: readonly FixtureGroup[],
    goalSnapshots: Map<string, MarketSnapshot | undefined>,
    assistSnapshots: Map<string, MarketSnapshot | undefined>,
    matchSnapshots: Map<string, MatchOddsSnapshot | undefined> = new Map(),
  ): Promise<void> {
    const fixturesByRoute = new Map<
      OddsApiIoRoute,
      FixtureGroup[]
    >();
    for (const fixture of fixtures) {
      const route = this.routeForFixtureGroup(fixture);
      if (!route) continue;
      const routedFixtures = fixturesByRoute.get(route) ?? [];
      routedFixtures.push(fixture);
      fixturesByRoute.set(route, routedFixtures);
    }
    for (const [route, routedFixtures] of fixturesByRoute) {
      try {
        await this.refreshRoute(
          route,
          routedFixtures,
          goalSnapshots,
          assistSnapshots,
          matchSnapshots,
        );
      } catch (error) {
        await Promise.all(
          routedFixtures.map((fixture) =>
            this.options.store.releaseRefreshLease?.(
              fixture.key,
              this.refreshRequestGroup(fixture),
            ),
          ),
        );
        this.options.logger.warn(
          {
            competitions: route.competitionSlugs,
            leagues: route.leagueSlugs,
            fixtures: routedFixtures.length,
            error: error instanceof Error ? error.message : String(error),
          },
          'Odds-API.io lookup failed; retaining existing fixture snapshots',
        );
        if (error instanceof OddsApiIoHttpError && error.status === 429) {
          return;
        }
      }
    }
  }

  private routeForPlayer(player: PlayerStats): OddsApiIoRoute | null {
    return (
      this.options.routes.find((route) =>
        supportsPlayerCompetition(player, route.competitionSlugs),
      ) ?? null
    );
  }

  private routeForFixture(player: PlayerStats): OddsApiIoRoute | null {
    return (
      this.options.routes.find((route) =>
        supportsFixtureCompetition(player, route.competitionSlugs),
      ) ?? null
    );
  }

  private routeForMatch(player: PlayerStats): OddsApiIoRoute | null {
    const route = this.routeForFixture(player);
    return route?.matchOdds === true ? route : null;
  }

  private routeForFixtureGroup(
    fixture: FixtureGroup,
  ): OddsApiIoRoute | null {
    return (
      fixture.players
        .map((player) => this.routeForFixture(player))
        .find((candidate): candidate is OddsApiIoRoute =>
          candidate !== null,
        ) ?? null
    );
  }

  private insideWindow(
    fixtureDate: string | undefined,
    windowMs: number,
  ): boolean {
    const kickoff = Date.parse(fixtureDate ?? '');
    const untilKickoff = kickoff - this.now();
    return (
      Number.isFinite(kickoff) &&
      untilKickoff >= 0 &&
      untilKickoff <= windowMs
    );
  }

  private refreshRequestGroup(fixture: FixtureGroup): string {
    const route = this.routeForFixtureGroup(fixture);
    return [
      'odds-api-io',
      ...(route?.leagueSlugs ?? ['unrouted']),
      'fixture-odds',
    ].join(':');
  }

  private async refreshRoute(
    route: OddsApiIoRoute,
    fixtures: readonly FixtureGroup[],
    goalSnapshots: Map<string, MarketSnapshot | undefined>,
    assistSnapshots: Map<string, MarketSnapshot | undefined>,
    matchSnapshots: Map<string, MatchOddsSnapshot | undefined>,
  ): Promise<void> {
    const kickoffs = fixtures
      .map(({ date }) => Date.parse(date))
      .filter(Number.isFinite);
    const matched = new Map<
      string,
      { fixture: FixtureGroup; event: OddsApiIoEvent }
    >();
    let eventCount = 0;
    const queriedLeagues: string[] = [];
    for (const league of route.leagueSlugs) {
      if (matched.size === fixtures.length) break;
      queriedLeagues.push(league);
      const eventsResponse = await this.requestJson('/events', {
        sport: 'football',
        league,
        status: 'pending',
        from: rfc3339Seconds(
          Math.min(...kickoffs) - 36 * 60 * 60 * 1_000,
        ),
        to: rfc3339Seconds(
          Math.max(...kickoffs) + 36 * 60 * 60 * 1_000,
        ),
      });
      const events = OddsApiIoEventsSchema.parse(eventsResponse);
      eventCount += events.length;
      for (const fixture of fixtures) {
        if (matched.has(fixture.key)) continue;
        const event = findEvent(fixture, events);
        if (event) matched.set(fixture.key, { fixture, event });
      }
    }

    const oddsByEvent = new Map<string, OddsApiIoEventOdds>();
    for (const batch of chunks([...matched.values()], 10)) {
      const body = await this.requestJson('/odds/multi', {
        eventIds: batch.map(({ event }) => event.id).join(','),
        bookmakers: this.options.bookmakers.join(','),
      });
      for (const eventOdds of OddsApiIoMultiOddsSchema.parse(body)) {
        oddsByEvent.set(eventOdds.id, eventOdds);
      }
    }

    const capturedAt = new Date(this.now()).toISOString();
    for (const fixture of fixtures) {
      const match = matched.get(fixture.key);
      const response = match ? oddsByEvent.get(match.event.id) : undefined;
      const existing = goalSnapshots.get(fixture.key);
      const extracted = response
        ? anytimeGoalscorerSnapshot(response, capturedAt)
        : null;
      const snapshot = extracted
        ? supplementFrozenSnapshot(
            existing?.status === 'available' ? existing : undefined,
            extracted,
            fixture.players,
            fixture.date,
          )
        : existing?.status === 'available'
          ? recordFrozenSnapshotCheck(
              existing,
              fixture.players,
              fixture.date,
              this.now(),
            )
          : missingMarketSnapshot(
              fixture,
              'player_goal_scorer_anytime',
              existing,
              this.now(),
            );
      await this.options.store.set(fixtureStoreKey(fixture.key), snapshot);
      goalSnapshots.set(fixture.key, snapshot);

      // Assists piggyback on a goalscorer or H-D-A refresh. Their absence is
      // deliberately not persisted as a miss and can never trigger a request.
      const extractedAssist = response
        ? playerAssistSnapshot(response, capturedAt)
        : null;
      if (extractedAssist) {
        const existingAssist = assistSnapshots.get(fixture.key);
        const assistSnapshot = supplementFrozenSnapshot(
          existingAssist?.status === 'available'
            ? existingAssist
            : undefined,
          extractedAssist,
          fixture.players,
          fixture.date,
        );
        await this.options.store.set(
          fixtureStoreKey(fixture.key),
          assistSnapshot,
        );
        assistSnapshots.set(fixture.key, assistSnapshot);
      }

      const matchStore = this.options.matchOddsStore;
      if (route.matchOdds === true && matchStore) {
        const storedMatchSnapshot =
          matchSnapshots.get(fixture.key) ??
          (await matchStore.get(fixtureStoreKey(fixture.key)));
        if (storedMatchSnapshot?.status === 'available') {
          matchSnapshots.set(fixture.key, storedMatchSnapshot);
          continue;
        }
        const extractedMatch = response
          ? matchOddsSnapshot(response, capturedAt)
          : null;
        const nextMatchSnapshot =
          extractedMatch ??
          MatchOddsSnapshotSchema.parse({
            status: 'unavailable',
            checkedAt: capturedAt,
            expiresAt: new Date(
              Math.min(
                Date.parse(fixture.date),
                this.now() +
                  (this.options.matchOddsMissTtlMs ??
                    DEFAULT_MATCH_ODDS_MISS_TTL_MS),
              ),
            ).toISOString(),
          });
        await matchStore.set(
          fixtureStoreKey(fixture.key),
          nextMatchSnapshot,
        );
        matchSnapshots.set(fixture.key, nextMatchSnapshot);
      }
    }
    this.options.logger.info(
      {
        competitions: route.competitionSlugs,
        leagues: queriedLeagues,
        fixtures: fixtures.length,
        matched: matched.size,
        events: eventCount,
        bookmakers: this.options.bookmakers,
        matchOdds: route.matchOdds === true,
      },
      'Odds-API.io fixture snapshot received',
    );
  }

  private async requestJson(
    path: string,
    query: Readonly<Record<string, string>>,
  ): Promise<unknown> {
    if (!(await this.protection()).allowExternalRequests) {
      throw new Error('Odds-API.io local quota protection is active');
    }
    const url = new URL(
      `${this.options.baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`,
    );
    url.searchParams.set('apiKey', this.options.apiKey);
    for (const [name, value] of Object.entries(query)) {
      url.searchParams.set(name, value);
    }

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.options.requestTimeoutMs,
      );
      try {
        const response = await this.fetchImpl(url, {
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });
        await this.recordRequest(response.headers, response.status === 429);
        if (response.status === 429) {
          await response.body?.cancel();
          throw new OddsApiIoHttpError(response.status);
        }
        const retryable =
          [502, 503, 504].includes(response.status);
        if (retryable && attempt < this.options.maxRetries) {
          const waitMs = retryDelayMs(
            response.headers.get('retry-after'),
            attempt,
          );
          await response.body?.cancel();
          await this.sleep(waitMs);
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new OddsApiIoHttpError(response.status);
        }
        return await response.json();
      } catch (error) {
        if (
          attempt < this.options.maxRetries &&
          error instanceof Error &&
          error.name === 'AbortError'
        ) {
          await this.sleep(retryDelayMs(null, attempt));
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error('Odds-API.io retry budget exhausted');
  }

  private async recordRequest(
    headers: Headers,
    rateLimited: boolean,
  ): Promise<void> {
    if (!this.options.usageStore) return;
    try {
      const now = this.now();
      const checkedAt = new Date(now).toISOString();
      const dayStart = new Date(now);
      dayStart.setUTCHours(0, 0, 0, 0);
      const currentDaily = currentUsage(
        await this.options.usageStore.get('odds-api-io'),
        'odds-api-io',
        now,
      );
      const dailyUsage = quotaUsage(
        'odds-api-io',
        'requests',
        (currentDaily?.used ?? 0) + 1,
        this.options.dailyRequestLimit,
        checkedAt,
        {
          unit: 'day',
          startsAt: dayStart.toISOString(),
          endsAt: new Date(
            dayStart.getTime() + 24 * HOUR_MS,
          ).toISOString(),
        },
      );
      if (dailyUsage) await this.options.usageStore.set(dailyUsage);

      const currentHourly = currentUsage(
        await this.options.usageStore.get('odds-api-io-hourly'),
        'odds-api-io-hourly',
        now,
      );
      const reportedLimit = nonnegativeIntegerHeader(
        headers,
        'x-ratelimit-limit',
      );
      const reportedRemaining = nonnegativeIntegerHeader(
        headers,
        'x-ratelimit-remaining',
      );
      const limit =
        reportedLimit && reportedLimit > 0
          ? reportedLimit
          : currentHourly?.limit ?? this.options.hourlyRequestLimit;
      const resetAt =
        resetTimeFromHeaders(headers, now) ??
        (currentHourly?.interval.endsAt
          ? Date.parse(currentHourly.interval.endsAt)
          : Number.NaN);
      const endsAt =
        Number.isFinite(resetAt) && resetAt > now
          ? resetAt
          : now + HOUR_MS;
      const reportedUsed =
        reportedRemaining === null
          ? null
          : Math.max(0, limit - Math.min(limit, reportedRemaining));
      const sameWindow =
        currentHourly?.interval.endsAt ===
        new Date(endsAt).toISOString();
      const used = rateLimited
        ? limit
        : Math.max(
            sameWindow ? currentHourly?.used ?? 0 : 0,
            reportedUsed ?? (currentHourly?.used ?? 0) + 1,
          );
      const hourlyUsage = quotaUsage(
        'odds-api-io-hourly',
        'requests',
        used,
        limit,
        checkedAt,
        {
          unit: 'hour',
          startsAt: new Date(endsAt - HOUR_MS).toISOString(),
          endsAt: new Date(endsAt).toISOString(),
        },
      );
      if (hourlyUsage) await this.options.usageStore.set(hourlyUsage);
    } catch (error) {
      this.options.logger.warn(
        {
          provider: 'odds-api-io',
          error: error instanceof Error ? error.message : String(error),
        },
        'Odds-API.io local request usage could not be persisted',
      );
    }
  }
}

export class OddsApiIoFixtureMatchOddsProvider
  implements FixtureMatchOddsProvider
{
  constructor(private readonly source: OddsApiIoPlayerMarketOddsProvider) {}

  supports(player: PlayerStats): boolean {
    return this.source.supportsMatchOdds(player);
  }

  load(
    players: readonly PlayerStats[],
    loadOptions?: { cacheOnly?: boolean },
  ): Promise<Map<string, MatchProbabilities | null>> {
    return this.source.loadMatchOdds(players, loadOptions);
  }
}
