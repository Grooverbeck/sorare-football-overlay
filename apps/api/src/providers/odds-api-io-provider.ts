import {
  MarketProbabilitySchema,
  PlayerMarketOddsSchema,
  type BookmakerMarketQuote,
  type PlayerMarketOdds,
  type PlayerStats,
} from '@sorare-overlay/shared';
import { z } from 'zod';
import type { AppLogger } from '../logger.js';
import {
  FrozenMarketSnapshotSchema,
  groupFixtures,
  missingMarketSnapshot,
  needsFrozenSnapshotSupplement,
  normalizePlayerName,
  normalizeTeamName,
  playerMarketOddsKey,
  playerProbability,
  recordFrozenSnapshotCheck,
  shouldRetryMarketFailure,
  supplementFrozenSnapshot,
  supportsPlayerCompetition,
  type FixtureGroup,
  type FrozenMarketSnapshot,
  type MarketSnapshot,
  type MarketSnapshotStore,
  type PlayerMarketOddsLoadOptions,
  type PlayerMarketOddsProvider,
  type PlayerMarketField,
} from './market-odds-provider.js';
import {
  protectionForUsage,
  quotaUsage,
  type OddsUsageProtection,
  type ProviderQuotaUsage,
  type ProviderQuotaUsageStore,
} from './odds-usage.js';
import type { OddsApiIoPlayerRoute } from './competition-odds-routes.js';

const OddsApiIoEventSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  date: z.string().datetime(),
  home: z.string().min(1),
  away: z.string().min(1),
});

const OddsApiIoEventsSchema = z.array(OddsApiIoEventSchema);
type OddsApiIoEvent = z.infer<typeof OddsApiIoEventSchema>;

const OddsApiIoMarketOddSchema = z.object({
  // Team and totals markets in the same response legitimately use
  // `label: null`. They are irrelevant for player props and must not make the
  // complete event response fail validation.
  label: z.string().min(1).nullable().optional(),
  over: z.union([z.string(), z.number()]).optional(),
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
  routes: readonly OddsApiIoPlayerRoute[];
  fetchWindowMs: number;
  dailyRequestLimit: number;
  hourlyRequestLimit: number;
  requestTimeoutMs: number;
  maxRetries: number;
  store: MarketSnapshotStore;
  logger: AppLogger;
  usageStore?: ProviderQuotaUsageStore;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

class OddsApiIoHttpError extends Error {
  constructor(readonly status: number) {
    super(`Odds-API.io returned HTTP ${status}`);
    this.name = 'OddsApiIoHttpError';
  }
}

const ODDS_API_IO_REFRESH_LEASE_MS = 90 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;

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

const providerClubTokens = new Set([
  'afc',
  'bsc',
  'cf',
  'fc',
  'fk',
  'gnk',
  'hnk',
  'nk',
  'rb',
  'sc',
  'sk',
  'sl',
  'sv',
  'vfl',
]);
const ambiguousTeamTokens = new Set([
  'athletic',
  'city',
  'club',
  'real',
  'sporting',
  'united',
]);

function providerTeamTokens(value: string): string[] {
  return normalizeTeamName(value)
    .split(' ')
    .filter(
      (token) =>
        !providerClubTokens.has(token) &&
        !/^(?:18|19|20)\d{2}$/.test(token),
    );
}

function providerTeamMatches(left: string, right: string): boolean {
  const normalizedLeft = normalizeTeamName(left);
  const normalizedRight = normalizeTeamName(right);
  if (normalizedLeft === normalizedRight) return true;
  const leftTokens = providerTeamTokens(left);
  const rightTokens = providerTeamTokens(right);
  if (leftTokens.join(' ') === rightTokens.join(' ')) return true;
  const [shorter, longer] =
    leftTokens.length <= rightTokens.length
      ? [leftTokens, rightTokens]
      : [rightTokens, leftTokens];
  return (
    shorter.length > 0 &&
    shorter.every((token) => longer.includes(token)) &&
    shorter.some(
      (token) => token.length >= 4 && !ambiguousTeamTokens.has(token),
    )
  );
}

function findEvent(
  fixture: FixtureGroup,
  events: readonly OddsApiIoEvent[],
): OddsApiIoEvent | null {
  const kickoff = Date.parse(fixture.date);
  const candidates = events
    .filter(
      (event) =>
        providerTeamMatches(event.home, fixture.homeTeamName) &&
        providerTeamMatches(event.away, fixture.awayTeamName),
    )
    .map((event) => ({
      event,
      difference: Math.abs(Date.parse(event.date) - kickoff),
    }))
    .filter(({ difference }) => difference <= 36 * 60 * 60 * 1_000)
    .sort((left, right) => left.difference - right.difference);
  return candidates[0]?.event ?? null;
}

function anytimeGoalscorerSnapshot(
  response: OddsApiIoEventOdds,
  capturedAt: string,
): FrozenMarketSnapshot | null {
  const quotesByPlayer = new Map<string, BookmakerMarketQuote[]>();
  for (const [bookmaker, markets] of Object.entries(response.bookmakers)) {
    const market = markets.find(
      ({ name }) => name.trim().toLocaleLowerCase() === 'anytime goalscorer',
    );
    if (!market) continue;
    for (const odd of market.odds) {
      if (!odd.label) continue;
      const decimalOdds = Number(odd.over);
      if (!Number.isFinite(decimalOdds) || decimalOdds <= 1) continue;
      const playerName = normalizePlayerName(odd.label);
      if (!playerName) continue;
      const playerQuotes = quotesByPlayer.get(playerName) ?? [];
      playerQuotes.push({
        key: bookmaker.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-'),
        title: bookmaker,
        decimalOdds,
        probability: Math.min(1, 1 / decimalOdds),
      });
      quotesByPlayer.set(playerName, playerQuotes);
    }
  }
  if (quotesByPlayer.size === 0) return null;
  return FrozenMarketSnapshotSchema.parse({
    status: 'available',
    market: 'player_goal_scorer_anytime',
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
    return this.routeForPlayer(player) !== null;
  }

  supportsMarket(player: PlayerStats, market: PlayerMarketField): boolean {
    return market === 'goal' && this.supports(player);
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
    const snapshots = new Map<string, MarketSnapshot | undefined>();
    const pending: FixtureGroup[] = [];

    for (const fixture of fixtures) {
      const snapshot = await this.options.store.get(
        fixtureStoreKey(fixture.key),
        'player_goal_scorer_anytime',
      );
      snapshots.set(fixture.key, snapshot);
      const kickoff = Date.parse(fixture.date);
      const untilKickoff = kickoff - this.now();
      if (untilKickoff < 0 || untilKickoff > this.options.fetchWindowMs) {
        continue;
      }
      const needsApi =
        !snapshot ||
        (snapshot.status === 'unavailable'
          ? shouldRetryMarketFailure(snapshot, kickoff, this.now())
          : protection.allowSnapshotSupplements &&
            needsFrozenSnapshotSupplement(
              snapshot,
              fixture.players,
              fixture.date,
              this.now(),
            ));
      if (
        needsApi &&
        !loadOptions?.cacheOnly &&
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
      await this.refreshFixtures(pending, snapshots);
    }

    for (const fixture of fixtures) {
      const snapshot = snapshots.get(fixture.key);
      const available =
        snapshot?.status === 'available' ? snapshot : undefined;
      if (!available) continue;
      for (const player of fixture.players) {
        const goal = playerProbability(available, player, fixture.players);
        if (!goal) continue;
        output.set(
          playerMarketOddsKey(player),
          PlayerMarketOddsSchema.parse({
            source: 'odds-api-io',
            capturedAt: available.capturedAt,
            goal,
            assist: null,
          }),
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
    snapshots: Map<string, MarketSnapshot | undefined>,
  ): Promise<void> {
    const fixturesByRoute = new Map<
      OddsApiIoPlayerRoute,
      FixtureGroup[]
    >();
    for (const fixture of fixtures) {
      const route = fixture.players
        .map((player) => this.routeForPlayer(player))
        .find((candidate): candidate is OddsApiIoPlayerRoute =>
          Boolean(candidate),
        );
      if (!route) continue;
      const routedFixtures = fixturesByRoute.get(route) ?? [];
      routedFixtures.push(fixture);
      fixturesByRoute.set(route, routedFixtures);
    }
    for (const [route, routedFixtures] of fixturesByRoute) {
      try {
        await this.refreshRoute(route, routedFixtures, snapshots);
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
          'Odds-API.io lookup failed; retaining existing market snapshots',
        );
        if (error instanceof OddsApiIoHttpError && error.status === 429) {
          return;
        }
      }
    }
  }

  private routeForPlayer(player: PlayerStats): OddsApiIoPlayerRoute | null {
    return (
      this.options.routes.find((route) =>
        supportsPlayerCompetition(player, route.competitionSlugs),
      ) ?? null
    );
  }

  private refreshRequestGroup(fixture: FixtureGroup): string {
    const route = fixture.players
      .map((player) => this.routeForPlayer(player))
      .find((candidate): candidate is OddsApiIoPlayerRoute =>
        Boolean(candidate),
      );
    return [
      'odds-api-io',
      ...(route?.leagueSlugs ?? ['unrouted']),
      'player-props',
    ].join(':');
  }

  private async refreshRoute(
    route: OddsApiIoPlayerRoute,
    fixtures: readonly FixtureGroup[],
    snapshots: Map<string, MarketSnapshot | undefined>,
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
      const existing = snapshots.get(fixture.key);
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
      snapshots.set(fixture.key, snapshot);
    }
    this.options.logger.info(
      {
        competitions: route.competitionSlugs,
        leagues: queriedLeagues,
        fixtures: fixtures.length,
        matched: matched.size,
        events: eventCount,
        bookmakers: this.options.bookmakers,
      },
      'Odds-API.io player-prop snapshot received',
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
