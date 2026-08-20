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
  FIXTURE_IDENTITY_VERSION,
  cacheOnlySnapshotReadBudgetMs,
  fixtureIdentityCooldownActive,
  FrozenMarketSnapshotSchema,
  groupFixtures,
  marketFixtureKey,
  markRefreshDueStateComplete,
  missingMarketSnapshot,
  needsFrozenSnapshotSupplement,
  normalizePlayerName,
  playerMarketOddsKey,
  playerProbability,
  recordFrozenSnapshotCheck,
  readMarketSnapshotsWithin,
  rememberFixtureIdentityCooldown,
  resolveProviderFixture,
  resolvePlayerProbability,
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

const ODDS_API_IO_PLAYER_MARKET_PARSER_VERSION = 3;
const ODDS_API_IO_EVIDENCE_AFTER_KICKOFF_MS = 48 * 60 * 60 * 1_000;

const OddsApiIoMarketEvidenceSchema = z.object({
  provider: z.literal('odds-api-io'),
  parserVersion: z.number().int().positive(),
  eventId: z.string().min(1),
  capturedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  bookmakers: z.record(z.string(), z.array(OddsApiIoMarketSchema)),
});
type OddsApiIoMarketEvidence = z.infer<typeof OddsApiIoMarketEvidenceSchema>;

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

interface RankedPlayerQuote {
  rank: number;
  quote: BookmakerMarketQuote;
}

interface ClassifiedPlayerSelection {
  market: OddsMarketKey;
  playerName: string;
  rank: number;
}

interface ExtractedPlayerMarkets {
  snapshots: ReadonlyMap<OddsMarketKey, FrozenMarketSnapshot>;
  observedPlayerMarkets: readonly string[];
  unhandledPlayerMarkets: readonly string[];
}

function normalizedProviderMarketName(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function looksLikePlayerMarket(name: string): boolean {
  return /(?:player|goalscorer|assist)/i.test(name);
}

function classifyPlayerSelection(
  providerMarketName: string,
  label: string,
): ClassifiedPlayerSelection | null {
  const marketName = normalizedProviderMarketName(providerMarketName);
  if (marketName === 'anytime goalscorer') {
    return { market: 'player_goal_scorer_anytime', playerName: label, rank: 3 };
  }
  if (marketName === 'player to assist') {
    return { market: 'player_assists', playerName: label, rank: 3 };
  }
  if (marketName !== 'player to score or assist') return null;

  const combined = /^(.*?)\s+\((score or assist|assist|score)\)\s*(?:\((\d+)\))?\s*$/i.exec(
    label,
  );
  const playerName = combined?.[1]?.trim();
  const selection = combined?.[2]?.toLocaleLowerCase();
  const teamSide = combined?.[3];
  // Odds-API.io appends `(1)` / `(2)` to combined-market selections to
  // identify the home or away side. It is not a goal/assist threshold, so
  // rejecting `(2)` would silently discard every away-team selection.
  if (
    !playerName ||
    !selection ||
    (teamSide !== undefined && !['1', '2'].includes(teamSide))
  ) {
    return null;
  }
  if (selection === 'score') {
    return { market: 'player_goal_scorer_anytime', playerName, rank: 2 };
  }
  if (selection === 'assist') {
    return { market: 'player_assists', playerName, rank: 2 };
  }
  return { market: 'player_goal_or_assist', playerName, rank: 3 };
}

function extractPlayerMarketSnapshots(
  response: Pick<OddsApiIoEventOdds, 'id' | 'bookmakers'>,
  capturedAt: string,
): ExtractedPlayerMarkets {
  const quotes = new Map<
    OddsMarketKey,
    Map<string, Map<string, RankedPlayerQuote>>
  >();
  const observedPlayerMarkets = new Set<string>();
  const unhandledPlayerMarkets = new Set<string>();

  for (const [bookmaker, markets] of Object.entries(response.bookmakers)) {
    const bookmakerKey = bookmaker
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, '-');
    for (const providerMarket of markets) {
      const labelledOdds = providerMarket.odds.filter(({ label }) =>
        Boolean(label),
      );
      if (
        labelledOdds.length === 0 ||
        !looksLikePlayerMarket(providerMarket.name)
      ) {
        continue;
      }
      observedPlayerMarkets.add(providerMarket.name);
      let consumed = false;
      for (const odd of labelledOdds) {
        if (!odd.label) continue;
        const classified = classifyPlayerSelection(
          providerMarket.name,
          odd.label,
        );
        if (!classified) continue;
        const price =
          decimalOdd(odd.over) ??
          decimalOdd(odd.odds) ??
          decimalOdd(odd.yes);
        if (price === null) continue;
        const playerName = normalizePlayerName(classified.playerName);
        if (!playerName) continue;
        consumed = true;
        const byPlayer = quotes.get(classified.market) ?? new Map();
        const byBookmaker = byPlayer.get(playerName) ?? new Map();
        const ranked: RankedPlayerQuote = {
          rank: classified.rank,
          quote: {
            key: bookmakerKey,
            title: bookmaker,
            decimalOdds: price,
            probability: Math.min(1, 1 / price),
            providerMarketName: providerMarket.name.slice(0, 200),
            providerSelectionLabel: odd.label.slice(0, 300),
          },
        };
        const previous = byBookmaker.get(bookmakerKey);
        if (!previous || ranked.rank > previous.rank) {
          byBookmaker.set(bookmakerKey, ranked);
        }
        byPlayer.set(playerName, byBookmaker);
        quotes.set(classified.market, byPlayer);
      }
      if (!consumed) unhandledPlayerMarkets.add(providerMarket.name);
    }
  }

  const snapshots = new Map<OddsMarketKey, FrozenMarketSnapshot>();
  for (const [market, byPlayer] of quotes) {
    if (byPlayer.size === 0) continue;
    snapshots.set(
      market,
      FrozenMarketSnapshotSchema.parse({
        status: 'available',
        market,
        eventId: response.id,
        capturedAt,
        parserVersion: ODDS_API_IO_PLAYER_MARKET_PARSER_VERSION,
        players: Object.fromEntries(
          [...byPlayer].map(([playerName, byBookmaker]) => {
            const bookmakerQuotes = [...byBookmaker.values()]
              .map(({ quote }) => quote)
              .sort((left, right) => left.title.localeCompare(right.title));
            return [
              playerName,
              MarketProbabilitySchema.parse({
                probability: median(
                  bookmakerQuotes.map(({ probability }) => probability),
                ),
                bookmakerCount: bookmakerQuotes.length,
                bookmakerQuotes,
              }),
            ];
          }),
        ),
      }),
    );
  }
  return {
    snapshots,
    observedPlayerMarkets: [...observedPlayerMarkets].sort(),
    unhandledPlayerMarkets: [...unhandledPlayerMarkets].sort(),
  };
}

function playerMarketEvidence(
  response: OddsApiIoEventOdds,
  capturedAt: string,
): OddsApiIoMarketEvidence | null {
  const bookmakers = Object.fromEntries(
    Object.entries(response.bookmakers).flatMap(([bookmaker, markets]) => {
      const playerMarkets = markets.filter(
        (market) =>
          looksLikePlayerMarket(market.name) &&
          market.odds.some(({ label }) => Boolean(label)),
      );
      return playerMarkets.length > 0 ? [[bookmaker, playerMarkets]] : [];
    }),
  );
  if (Object.keys(bookmakers).length === 0) return null;
  return OddsApiIoMarketEvidenceSchema.parse({
    provider: 'odds-api-io',
    parserVersion: ODDS_API_IO_PLAYER_MARKET_PARSER_VERSION,
    eventId: response.id,
    capturedAt,
    expiresAt: new Date(
      Date.parse(response.date) + ODDS_API_IO_EVIDENCE_AFTER_KICKOFF_MS,
    ).toISOString(),
    bookmakers,
  });
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
  readonly reportsRefreshDue = true;
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
    return route !== null && ['goal', 'assist', 'decisive'].includes(market);
  }

  drivesMarketRequest(
    player: PlayerStats,
    market: PlayerMarketField,
  ): boolean {
    const route = this.routeForPlayer(player);
    return (
      route !== null &&
      market !== 'decisive' &&
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
    if (fixtures.length === 0) {
      markRefreshDueStateComplete(loadOptions);
      return output;
    }

    const protection = loadOptions?.cacheOnly
      ? loadOptions.refreshDuePlayerKeys
        ? await this.protection()
        : protectionForUsage(undefined)
      : await this.protection();
    const goalSnapshots = new Map<string, MarketSnapshot | undefined>();
    const assistSnapshots = new Map<string, MarketSnapshot | undefined>();
    const decisiveSnapshots = new Map<string, MarketSnapshot | undefined>();
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
          {
            fixtureKey: fixtureStoreKey(fixture.key),
            market: 'player_goal_or_assist' as const,
          },
        ]),
        true,
        cacheOnlySnapshotReadBudgetMs(loadOptions),
      );
      for (const [index, fixture] of fixtures.entries()) {
        goalSnapshots.set(fixture.key, loaded[index * 3]);
        assistSnapshots.set(fixture.key, loaded[index * 3 + 1]);
        decisiveSnapshots.set(fixture.key, loaded[index * 3 + 2]);
      }
    }

    for (const fixture of fixtures) {
      const [loadedGoal, loadedAssist, loadedDecisive] = cacheOnly
        ? [
            goalSnapshots.get(fixture.key),
            assistSnapshots.get(fixture.key),
            decisiveSnapshots.get(fixture.key),
          ]
        : await Promise.all([
            this.options.store.get(
              fixtureStoreKey(fixture.key),
              'player_goal_scorer_anytime',
            ),
            this.options.store.get(
              fixtureStoreKey(fixture.key),
              'player_assists',
            ),
            this.options.store.get(
              fixtureStoreKey(fixture.key),
              'player_goal_or_assist',
            ),
          ]);
      goalSnapshots.set(fixture.key, loadedGoal);
      assistSnapshots.set(fixture.key, loadedAssist);
      decisiveSnapshots.set(fixture.key, loadedDecisive);
      await this.replayMarketEvidence(
        fixture,
        goalSnapshots,
        assistSnapshots,
        decisiveSnapshots,
        loadOptions,
      );
      const goalSnapshot = goalSnapshots.get(fixture.key);
      const kickoff = this.effectiveFixtureKickoff(fixture.date);
      const route = this.routeForFixtureGroup(fixture);
      const fetchWindowMs =
        route?.playerFetchWindowMs ?? this.options.fetchWindowMs;
      if (
        !Number.isFinite(kickoff) ||
        kickoff < this.now() ||
        kickoff - this.now() > fetchWindowMs
      ) {
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
        cacheOnly &&
        loadOptions?.refreshDuePlayerKeys &&
        needsApi &&
        protection.allowExternalRequests &&
        !(await fixtureIdentityCooldownActive(
          this.options.store,
          'odds-api-io',
          fixture.key,
        ))
      ) {
        for (const player of fixture.players) {
          loadOptions.refreshDuePlayerKeys.add(playerMarketOddsKey(player));
        }
      }
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
        decisiveSnapshots,
      );
    }

    for (const fixture of fixtures) {
      const goalSnapshot = goalSnapshots.get(fixture.key);
      const assistSnapshot = assistSnapshots.get(fixture.key);
      const decisiveSnapshot = decisiveSnapshots.get(fixture.key);
      const availableGoal =
        goalSnapshot?.status === 'available' ? goalSnapshot : undefined;
      const availableAssist =
        assistSnapshot?.status === 'available' ? assistSnapshot : undefined;
      const availableDecisive =
        decisiveSnapshot?.status === 'available'
          ? decisiveSnapshot
          : undefined;
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
        const decisive = playerProbability(
          availableDecisive,
          player,
          fixture.players,
        );
        if (!goal && !assist && !decisive) continue;
        const capturedAt = [
          availableGoal?.capturedAt,
          availableAssist?.capturedAt,
          availableDecisive?.capturedAt,
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
            decisive,
          }),
        );
      }
    }
    markRefreshDueStateComplete(loadOptions);
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
        const decisiveSnapshots = new Map<
          string,
          MarketSnapshot | undefined
        >();
        await Promise.all(
          claimed.map(async (fixture) => {
            const [goalSnapshot, assistSnapshot, decisiveSnapshot] =
              await Promise.all([
                this.options.store.get(
                  fixtureStoreKey(fixture.key),
                  'player_goal_scorer_anytime',
                ),
                this.options.store.get(
                  fixtureStoreKey(fixture.key),
                  'player_assists',
                ),
                this.options.store.get(
                  fixtureStoreKey(fixture.key),
                  'player_goal_or_assist',
                ),
              ]);
            goalSnapshots.set(fixture.key, goalSnapshot);
            assistSnapshots.set(fixture.key, assistSnapshot);
            decisiveSnapshots.set(fixture.key, decisiveSnapshot);
          }),
        );
        await this.refreshFixtures(
          claimed,
          goalSnapshots,
          assistSnapshots,
          decisiveSnapshots,
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

  private async replayMarketEvidence(
    fixture: FixtureGroup,
    goalSnapshots: Map<string, MarketSnapshot | undefined>,
    assistSnapshots: Map<string, MarketSnapshot | undefined>,
    decisiveSnapshots: Map<string, MarketSnapshot | undefined>,
    loadOptions?: PlayerMarketOddsLoadOptions,
  ): Promise<void> {
    const getEvidence = this.options.store.getEvidence;
    if (!getEvidence) return;
    const parserCheckpoint = goalSnapshots.get(fixture.key)?.parserVersion;
    if (
      parserCheckpoint !== undefined &&
      parserCheckpoint >= ODDS_API_IO_PLAYER_MARKET_PARSER_VERSION
    ) {
      return;
    }

    const raw = await settleCacheReadWithin(
      getEvidence.call(
        this.options.store,
        fixtureStoreKey(fixture.key),
        'odds-api-io',
      ),
      loadOptions?.cacheOnly === true,
      cacheOnlySnapshotReadBudgetMs(loadOptions),
    );
    if (raw === undefined) return;
    const evidence = OddsApiIoMarketEvidenceSchema.safeParse(raw);
    if (!evidence.success) {
      this.options.logger.warn(
        {
          event: 'market_evidence_invalid',
          provider: 'odds-api-io',
          fixture: fixture.key,
        },
        'Odds-API.io market evidence could not be replayed',
      );
      return;
    }
    const extracted = extractPlayerMarketSnapshots(
      {
        id: evidence.data.eventId,
        bookmakers: evidence.data.bookmakers,
      },
      evidence.data.capturedAt,
    );
    const maps = new Map<
      OddsMarketKey,
      Map<string, MarketSnapshot | undefined>
    >([
      ['player_goal_scorer_anytime', goalSnapshots],
      ['player_assists', assistSnapshots],
      ['player_goal_or_assist', decisiveSnapshots],
    ]);
    const persist: Promise<void>[] = [];
    for (const [market, incoming] of extracted.snapshots) {
      const snapshots = maps.get(market);
      if (!snapshots) continue;
      const existing = snapshots.get(fixture.key);
      const replayed = supplementFrozenSnapshot(
        existing?.status === 'available' ? existing : undefined,
        incoming,
        fixture.players,
        fixture.date,
      );
      snapshots.set(fixture.key, replayed);
      if (loadOptions?.cacheOnly !== true) {
        persist.push(
          Promise.resolve(
            this.options.store.set(fixtureStoreKey(fixture.key), replayed),
          ),
        );
      }
    }
    await Promise.all(persist);
    if (
      loadOptions?.cacheOnly !== true &&
      extracted.snapshots.size > 0
    ) {
      this.options.logger.info(
        {
          event: 'market_evidence_replayed',
          provider: 'odds-api-io',
          fixture: fixture.key,
          fromParserVersion: evidence.data.parserVersion,
          toParserVersion: ODDS_API_IO_PLAYER_MARKET_PARSER_VERSION,
          markets: [...extracted.snapshots.keys()],
        },
        'Odds-API.io cached market evidence was reprocessed',
      );
    }
  }

  private async refreshFixtures(
    fixtures: readonly FixtureGroup[],
    goalSnapshots: Map<string, MarketSnapshot | undefined>,
    assistSnapshots: Map<string, MarketSnapshot | undefined>,
    decisiveSnapshots: Map<string, MarketSnapshot | undefined>,
    matchSnapshots: Map<string, MatchOddsSnapshot | undefined> = new Map(),
  ): Promise<void> {
    const fixturesByRoute = new Map<
      OddsApiIoRoute,
      FixtureGroup[]
    >();
    for (const fixture of fixtures) {
      if (
        await fixtureIdentityCooldownActive(
          this.options.store,
          'odds-api-io',
          fixture.key,
        )
      ) {
        this.options.logger.debug(
          { provider: 'odds-api-io', fixture: fixture.key },
          'Odds-API.io fixture lookup skipped during identity cooldown',
        );
        continue;
      }
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
          decisiveSnapshots,
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
    const kickoff = this.effectiveFixtureKickoff(fixtureDate);
    const untilKickoff = kickoff - this.now();
    return (
      Number.isFinite(kickoff) &&
      untilKickoff >= 0 &&
      untilKickoff <= windowMs
    );
  }

  private effectiveFixtureKickoff(
    fixtureDate: string | undefined,
  ): number {
    const kickoff = Date.parse(fixtureDate ?? '');
    if (!Number.isFinite(kickoff)) return Number.NaN;
    const fixture = new Date(kickoff);
    const now = new Date(this.now());
    const isMidnightPlaceholder =
      fixture.getUTCHours() === 0 &&
      fixture.getUTCMinutes() === 0 &&
      fixture.getUTCSeconds() === 0 &&
      fixture.getUTCMilliseconds() === 0;
    const isCurrentUtcDay =
      fixture.getUTCFullYear() === now.getUTCFullYear() &&
      fixture.getUTCMonth() === now.getUTCMonth() &&
      fixture.getUTCDate() === now.getUTCDate();
    if (!isMidnightPlaceholder || !isCurrentUtcDay) return kickoff;
    // Sorare represents some low-coverage UEFA fixtures as date-only midnight
    // values while its UI still shows the real evening kickoff. Keep provider
    // discovery open for the remainder of that UTC day; the event feed then
    // supplies the precise start time used by the frozen market snapshot.
    return Date.UTC(
      fixture.getUTCFullYear(),
      fixture.getUTCMonth(),
      fixture.getUTCDate(),
      23,
      59,
      59,
      999,
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

  private logIdentityDiagnostics(
    fixture: FixtureGroup,
    snapshot: FrozenMarketSnapshot,
  ): void {
    for (const player of fixture.players) {
      const resolution = resolvePlayerProbability(
        snapshot,
        player,
        fixture.players,
      );
      if (
        resolution.status === 'available' ||
        resolution.status === 'snapshot_unavailable' ||
        (resolution.status === 'player_not_listed' &&
          resolution.candidates.length === 0)
      ) {
        continue;
      }
      const { candidates } = resolution;
      this.options.logger.warn(
        {
          event: 'player_market_identity_unresolved',
          provider: 'odds-api-io',
          fixture: fixture.key,
          eventId: snapshot.eventId,
          market: snapshot.market,
          playerSlug: player.slug,
          playerDisplayName: player.displayName,
          reason: resolution.status,
          candidates,
        },
        'Odds-API.io player quote could not be assigned safely',
      );
    }
  }

  private async refreshRoute(
    route: OddsApiIoRoute,
    fixtures: readonly FixtureGroup[],
    goalSnapshots: Map<string, MarketSnapshot | undefined>,
    assistSnapshots: Map<string, MarketSnapshot | undefined>,
    decisiveSnapshots: Map<string, MarketSnapshot | undefined>,
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
    const eventCandidates: Array<{
      event: OddsApiIoEvent;
      eventId: string;
      date: string;
      homeTeamName: string;
      awayTeamName: string;
    }> = [];
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
      eventCandidates.push(
        ...events.map((event) => ({
          event,
          eventId: event.id,
          date: event.date,
          homeTeamName: event.home,
          awayTeamName: event.away,
        })),
      );
      for (const fixture of fixtures) {
        if (matched.has(fixture.key)) continue;
        const resolution = await resolveProviderFixture(
          this.options.store,
          'odds-api-io',
          fixture,
          eventCandidates,
        );
        if (resolution.status === 'matched') {
          matched.set(fixture.key, { fixture, event: resolution.event });
        }
      }
    }

    for (const fixture of fixtures) {
      if (matched.has(fixture.key)) continue;
      const resolution = await resolveProviderFixture(
        this.options.store,
        'odds-api-io',
        fixture,
        eventCandidates,
      );
      if (resolution.status === 'matched') {
        matched.set(fixture.key, { fixture, event: resolution.event });
        continue;
      }
      await rememberFixtureIdentityCooldown(
        this.options.store,
        'odds-api-io',
        fixture.key,
        resolution.status,
        this.now(),
      );
      this.options.logger.warn(
        {
          event: 'fixture_identity_unresolved',
          provider: 'odds-api-io',
          fixture: fixture.key,
          reason: resolution.status,
          candidates: resolution.candidates,
        },
        'Odds-API.io fixture identity could not be resolved; no market miss stored',
      );
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
    const observedPlayerMarkets = new Set<string>();
    const unhandledPlayerMarkets = new Set<string>();
    for (const fixture of fixtures) {
      const match = matched.get(fixture.key);
      if (!match) continue;
      const response = match ? oddsByEvent.get(match.event.id) : undefined;
      if (!response) {
        this.options.logger.warn(
          {
            event: 'fixture_odds_missing',
            provider: 'odds-api-io',
            fixture: fixture.key,
            eventId: match.event.id,
          },
          'Odds-API.io matched fixture had no odds payload; no market miss stored',
        );
        continue;
      }
      const extractedMarkets = response
        ? extractPlayerMarketSnapshots(response, capturedAt)
        : {
            snapshots: new Map<OddsMarketKey, FrozenMarketSnapshot>(),
            observedPlayerMarkets: [],
            unhandledPlayerMarkets: [],
          };
      for (const market of extractedMarkets.observedPlayerMarkets) {
        observedPlayerMarkets.add(market);
      }
      for (const market of extractedMarkets.unhandledPlayerMarkets) {
        unhandledPlayerMarkets.add(market);
      }
      if (response && this.options.store.setEvidence) {
        const evidence = playerMarketEvidence(response, capturedAt);
        if (evidence) {
          try {
            await this.options.store.setEvidence(
              fixtureStoreKey(fixture.key),
              'odds-api-io',
              evidence,
              evidence.expiresAt,
            );
          } catch (error) {
            this.options.logger.warn(
              {
                event: 'market_evidence_write_failed',
                provider: 'odds-api-io',
                fixture: fixture.key,
                error: error instanceof Error ? error.message : String(error),
              },
              'Odds-API.io market evidence could not be persisted',
            );
          }
        }
      }
      const existing = goalSnapshots.get(fixture.key);
      const extracted = extractedMarkets.snapshots.get(
        'player_goal_scorer_anytime',
      );
      const snapshot = extracted
        ? supplementFrozenSnapshot(
            existing?.status === 'available' ? existing : undefined,
            extracted,
            fixture.players,
            fixture.date,
          )
        : existing?.status === 'available'
          ? {
              ...recordFrozenSnapshotCheck(
                existing,
                fixture.players,
                fixture.date,
                this.now(),
              ),
              parserVersion: ODDS_API_IO_PLAYER_MARKET_PARSER_VERSION,
            }
          : {
              ...missingMarketSnapshot(
                fixture,
                'player_goal_scorer_anytime',
                existing,
                this.now(),
                match.event.id,
              ),
              parserVersion: ODDS_API_IO_PLAYER_MARKET_PARSER_VERSION,
            };
      // Assists and goals+assists piggyback on a goalscorer or H-D-A refresh.
      // Their absence is deliberately not persisted as a miss and can never
      // trigger a provider request.
      const opportunistic = [
        {
          market: 'player_assists' as const,
          snapshots: assistSnapshots,
        },
        {
          market: 'player_goal_or_assist' as const,
          snapshots: decisiveSnapshots,
        },
      ];
      for (const { market, snapshots } of opportunistic) {
        const incoming = extractedMarkets.snapshots.get(market);
        if (!incoming) continue;
        const previous = snapshots.get(fixture.key);
        const supplemented = supplementFrozenSnapshot(
          previous?.status === 'available' ? previous : undefined,
          incoming,
          fixture.players,
          fixture.date,
        );
        await this.options.store.set(
          fixtureStoreKey(fixture.key),
          supplemented,
        );
        snapshots.set(fixture.key, supplemented);
        this.logIdentityDiagnostics(fixture, supplemented);
      }
      // Store the request-driving goal snapshot last. Its parser version is
      // the fixture-level replay checkpoint, so a failed opportunistic write
      // must not make the evidence look fully consumed.
      await this.options.store.set(fixtureStoreKey(fixture.key), snapshot);
      goalSnapshots.set(fixture.key, snapshot);
      if (snapshot.status === 'available') {
        this.logIdentityDiagnostics(fixture, snapshot);
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
            fixtureIdentityVersion: FIXTURE_IDENTITY_VERSION,
            reason: 'market_not_offered',
            eventId: match.event.id,
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
        observedPlayerMarkets: [...observedPlayerMarkets].sort(),
      },
      'Odds-API.io fixture snapshot received',
    );
    if (unhandledPlayerMarkets.size > 0) {
      this.options.logger.warn(
        {
          event: 'player_market_unhandled',
          provider: 'odds-api-io',
          competitions: route.competitionSlugs,
          leagues: queriedLeagues,
          markets: [...unhandledPlayerMarkets].sort(),
        },
        'Odds-API.io returned labelled player markets that no parser consumed',
      );
    }
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
