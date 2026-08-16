import {
  MarketProbabilitySchema,
  PlayerMarketOddsSchema,
  type BookmakerMarketQuote,
  type MarketProbability,
  type MatchProbabilities,
  type PlayerMarketOdds,
  type PlayerStats,
} from '@sorare-overlay/shared';
import { z } from 'zod';
import type { AppLogger } from '../logger.js';
import {
  cacheOnlySnapshotReadBudgetMs,
  groupFixtures,
  marketFixtureKey,
  missingMarketSnapshot,
  needsFrozenSnapshotSupplement,
  normalizePlayerName,
  playerMarketFieldDrivesRequest,
  playerMarketFieldSupported,
  playerMarketOddsKey,
  playerProbability,
  providerTeamNamesMatch,
  recordFrozenSnapshotCheck,
  readMarketSnapshotsWithin,
  settleCacheReadWithin,
  shouldRetryMarketFailure,
  supportsFixtureCompetition,
  supportsPlayerCompetition,
  supplementFrozenSnapshot,
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
  quotaUsage,
  type ProviderQuotaInterval,
  type ProviderQuotaUsage,
  type ProviderQuotaUsageStore,
} from './odds-usage.js';
import {
  MatchOddsSnapshotSchema,
  matchProbabilitiesForPlayer,
  type FixtureMatchOddsProvider,
  type MatchOddsSnapshot,
  type MatchOddsSnapshotStore,
} from './match-odds-provider.js';

const sportsGameOddsMarketKeys = [
  'player_goal_scorer_anytime',
  'player_assists',
  'player_goal_or_assist',
] as const satisfies readonly OddsMarketKey[];

const SportsGameOddsBookQuoteSchema = z
  .object({
    odds: z.union([z.string(), z.number()]),
    overUnder: z.union([z.string(), z.number()]).optional(),
    available: z.boolean().optional(),
  })
  .passthrough();

const SportsGameOddsMarketSchema = z
  .object({
    oddID: z.string().min(1),
    opposingOddID: z.string().min(1).optional(),
    statID: z.string().min(1),
    statEntityID: z.string().min(1),
    periodID: z.string().min(1),
    betTypeID: z.string().min(1),
    sideID: z.string().min(1),
    playerID: z.string().min(1).optional(),
    bookOverUnder: z.union([z.string(), z.number()]).optional(),
    byBookmaker: z
      .record(z.string().min(1), SportsGameOddsBookQuoteSchema)
      .optional(),
  })
  .passthrough();

const SportsGameOddsTeamSchema = z
  .object({
    teamID: z.string().min(1),
    names: z.object({
      long: z.string().min(1).optional(),
      medium: z.string().min(1).optional(),
      short: z.string().min(1).optional(),
    }),
  })
  .passthrough();

const SportsGameOddsPlayerSchema = z
  .object({
    playerID: z.string().min(1).optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    name: z.string().min(1).optional(),
  })
  .passthrough();

const SportsGameOddsEventSchema = z
  .object({
    eventID: z.string().min(1),
    leagueID: z.string().min(1),
    teams: z.object({
      home: SportsGameOddsTeamSchema,
      away: SportsGameOddsTeamSchema,
    }),
    status: z
      .object({
        startsAt: z.string().datetime(),
      })
      .passthrough(),
    players: z
      .record(z.string().min(1), SportsGameOddsPlayerSchema)
      .optional(),
    odds: z
      .record(z.string().min(1), SportsGameOddsMarketSchema)
      .optional(),
  })
  .passthrough();

const SportsGameOddsEventsEnvelopeSchema = z.object({
  success: z.boolean(),
  data: z.array(SportsGameOddsEventSchema),
  nextCursor: z.string().min(1).nullable().optional(),
});

const SportsGameOddsUsageEnvelopeSchema = z.object({
  success: z.literal(true),
  data: z.object({
    rateLimits: z.record(
      z.string().min(1),
      z.record(z.string().min(1), z.unknown()),
    ),
  }),
});

type SportsGameOddsEvent = z.infer<typeof SportsGameOddsEventSchema>;
type SportsGameOddsMarket = z.infer<typeof SportsGameOddsMarketSchema>;
type SportsGameOddsBookQuote = z.infer<typeof SportsGameOddsBookQuoteSchema>;

interface SportsGameOddsOptions {
  apiKey: string;
  baseUrl: string;
  leagueId: string;
  fetchWindowMs: number;
  requestTimeoutMs: number;
  maxRetries: number;
  store: MarketSnapshotStore;
  matchOddsStore?: MatchOddsSnapshotStore;
  matchOddsFetchWindowMs?: number;
  matchOddsMissTtlMs?: number;
  logger: AppLogger;
  usageStore?: ProviderQuotaUsageStore;
  refreshUsage?: boolean;
  refreshLeaseTtlMs?: number;
  supportedCompetitionSlugs?: readonly string[];
  supportedMarkets?: readonly PlayerMarketField[];
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

function finiteUsageNumber(
  values: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const raw = values[key];
    const numeric =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && raw.trim() !== ''
          ? Number(raw)
          : Number.NaN;
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function usageIntervalDate(
  values: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const raw = values[key];
    if (typeof raw !== 'string') continue;
    const timestamp = Date.parse(raw);
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  return null;
}

export function sportsGameOddsQuotaUsage(
  body: unknown,
  checkedAt: string,
): ProviderQuotaUsage | null {
  const parsed = SportsGameOddsUsageEnvelopeSchema.safeParse(body);
  if (!parsed.success) return null;
  const monthly = parsed.data.data.rateLimits['per-month'];
  if (!monthly) return null;
  const limit = finiteUsageNumber(monthly, [
    'max-entities',
    'maxEntitiesPerInterval',
  ]);
  const used = finiteUsageNumber(monthly, [
    'current-entities',
    'currentIntervalEntities',
  ]);
  if (limit === null || used === null) return null;
  const interval: ProviderQuotaInterval = {
    unit: 'month',
    startsAt: usageIntervalDate(monthly, [
      'current-interval-start-time',
      'currentIntervalStartTime',
    ]),
    endsAt: usageIntervalDate(monthly, [
      'current-interval-end-time',
      'currentIntervalEndTime',
    ]),
  };
  return quotaUsage(
    'sports-game-odds',
    'objects',
    used,
    limit,
    checkedAt,
    interval,
  );
}

class SportsGameOddsHttpError extends Error {
  constructor(readonly status: number) {
    super(`SportsGameOdds returned HTTP ${status}`);
    this.name = 'SportsGameOddsHttpError';
  }
}

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const defaultRefreshLeaseTtlMs = 90 * 1_000;
const defaultCacheOnlyProviderBudgetMs = 150;
const defaultMatchOddsMissTtlMs = 60 * 60 * 1_000;
const matchSnapshotAfterKickoffMs = 36 * 60 * 60 * 1_000;
const directEventBatchSize = 25;

function settleMarketOddsWithin(
  pending: Promise<Map<string, PlayerMarketOdds | null>>,
  timeoutMs: number,
): Promise<Map<string, PlayerMarketOdds | null>> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: Map<string, PlayerMarketOdds | null>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(
      () => finish(new Map<string, PlayerMarketOdds | null>()),
      Math.max(1, timeoutMs),
    );
    void pending.then(
      (value) => finish(value),
      () => finish(new Map<string, PlayerMarketOdds | null>()),
    );
  });
}

function supplementPlayerMarketOdds(
  primary: PlayerMarketOdds | null,
  fallback: PlayerMarketOdds | null,
  markets: readonly PlayerMarketField[],
): PlayerMarketOdds | null {
  if (!primary) return fallback;
  if (!fallback) return primary;
  const usedFallback = markets.some(
    (market) => !primary[market] && Boolean(fallback[market]),
  );
  if (!usedFallback) return primary;
  const supplemented = (market: PlayerMarketField) =>
    markets.includes(market)
      ? primary[market] ?? fallback[market]
      : primary[market];
  return PlayerMarketOddsSchema.parse({
    source:
      primary.source === fallback.source ? primary.source : 'mixed',
    capturedAt: [primary.capturedAt, fallback.capturedAt].sort().at(-1),
    goal: supplemented('goal'),
    assist: supplemented('assist'),
    decisive: supplemented('decisive') ?? null,
  });
}

function retryDelayMs(value: string | null, attempt: number): number {
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const at = Date.parse(value);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }
  return Math.min(8_000, 500 * 2 ** attempt);
}

function fixtureStoreKey(fixtureKey: string): string {
  return `sports-game-odds|${fixtureKey}`;
}

function teamName(
  team: SportsGameOddsEvent['teams']['home'],
): string {
  return team.names.long ?? team.names.medium ?? team.names.short ?? team.teamID;
}

function findEvent(
  fixture: FixtureGroup,
  events: readonly SportsGameOddsEvent[],
): SportsGameOddsEvent | null {
  const kickoff = Date.parse(fixture.date);
  return (
    events
      .filter(
        (event) =>
          providerTeamNamesMatch(
            teamName(event.teams.home),
            fixture.homeTeamName,
          ) &&
          providerTeamNamesMatch(
            teamName(event.teams.away),
            fixture.awayTeamName,
          ),
      )
      .map((event) => ({
        event,
        difference: Math.abs(Date.parse(event.status.startsAt) - kickoff),
      }))
      .filter(({ difference }) => difference <= 36 * 60 * 60 * 1_000)
      .sort((left, right) => left.difference - right.difference)[0]?.event ??
    null
  );
}

function marketStatId(market: OddsMarketKey): string {
  switch (market) {
    case 'player_goal_scorer_anytime':
      return 'points';
    case 'player_assists':
      return 'assists';
    case 'player_goal_or_assist':
      return 'goals+assists';
  }
}

function playerName(
  event: SportsGameOddsEvent,
  market: SportsGameOddsMarket,
): string | null {
  const playerId = market.playerID ?? market.statEntityID;
  const player = event.players?.[playerId];
  const name =
    player?.name ??
    [player?.firstName, player?.lastName].filter(Boolean).join(' ');
  if (name) return name;
  const normalizedId = playerId
    .replace(/_\d+_[A-Z0-9_]+$/, '')
    .replace(/_/g, ' ')
    .trim();
  return normalizedId || null;
}

function numericLine(
  quote: SportsGameOddsBookQuote | undefined,
  market: SportsGameOddsMarket,
): number | null {
  const raw = quote?.overUnder ?? market.bookOverUnder;
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function decimalOdds(raw: string | number): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  if (value >= 100) return 1 + value / 100;
  if (value <= -100) return 1 + 100 / Math.abs(value);
  if (value > 1) return value;
  return null;
}

const bookmakerTitles: Readonly<Record<string, string>> = {
  betmgm: 'BetMGM',
  bovada: 'Bovada',
  caesars: 'Caesars',
  draftkings: 'DraftKings',
  espnbet: 'ESPN BET',
  fanduel: 'FanDuel',
  pointsbet: 'PointsBet',
  unibet: 'Unibet',
  williamhill: 'William Hill',
};

function bookmakerTitle(key: string): string {
  return (
    bookmakerTitles[key] ??
    key
      .split(/[_-]+/)
      .filter(Boolean)
      .map((part) => `${part[0]?.toLocaleUpperCase() ?? ''}${part.slice(1)}`)
      .join(' ')
  );
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[middle] ?? 0;
  return ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2;
}

interface RankedQuote {
  rank: number;
  quote: BookmakerMarketQuote;
}

function extractMarketSnapshot(
  event: SportsGameOddsEvent,
  market: OddsMarketKey,
  capturedAt: string,
): FrozenMarketSnapshot | null {
  const byPlayer = new Map<string, Map<string, RankedQuote>>();
  const expectedStatId = marketStatId(market);
  for (const candidate of Object.values(event.odds ?? {})) {
    if (
      candidate.statID !== expectedStatId ||
      candidate.periodID !== 'game' ||
      ['all', 'home', 'away'].includes(candidate.statEntityID.toLowerCase())
    ) {
      continue;
    }
    const yesNo =
      candidate.betTypeID === 'yn' && candidate.sideID === 'yes';
    const over =
      candidate.betTypeID === 'ou' && candidate.sideID === 'over';
    if (!yesNo && !over) continue;
    const name = playerName(event, candidate);
    if (!name) continue;
    const normalizedName = normalizePlayerName(name);
    if (!normalizedName) continue;
    const opposing = candidate.opposingOddID
      ? event.odds?.[candidate.opposingOddID]
      : undefined;
    const playerQuotes = byPlayer.get(normalizedName) ?? new Map();
    for (const [bookmakerKey, positive] of Object.entries(
      candidate.byBookmaker ?? {},
    )) {
      if (positive.available === false) continue;
      if (over && Math.abs((numericLine(positive, candidate) ?? -1) - 0.5) > 0.001) {
        continue;
      }
      const positiveDecimal = decimalOdds(positive.odds);
      if (positiveDecimal === null) continue;
      const positiveImplied = 1 / positiveDecimal;
      const negative = opposing?.byBookmaker?.[bookmakerKey];
      const negativeDecimal =
        negative?.available === false || negative === undefined
          ? null
          : decimalOdds(negative.odds);
      const probability =
        negativeDecimal === null
          ? positiveImplied
          : positiveImplied / (positiveImplied + 1 / negativeDecimal);
      const ranked: RankedQuote = {
        rank: yesNo ? 2 : 1,
        quote: {
          key: bookmakerKey,
          title: bookmakerTitle(bookmakerKey),
          decimalOdds: positiveDecimal,
          probability: Math.max(0, Math.min(1, probability)),
        },
      };
      const previous = playerQuotes.get(bookmakerKey);
      if (!previous || ranked.rank > previous.rank) {
        playerQuotes.set(bookmakerKey, ranked);
      }
    }
    if (playerQuotes.size > 0) byPlayer.set(normalizedName, playerQuotes);
  }

  if (byPlayer.size === 0) return null;
  return {
    status: 'available',
    market,
    eventId: event.eventID,
    capturedAt,
    players: Object.fromEntries(
      [...byPlayer].map(([name, rankedQuotes]) => {
        const quotes = [...rankedQuotes.values()]
          .map(({ quote }) => quote)
          .sort((left, right) => left.title.localeCompare(right.title));
        return [
          name,
          MarketProbabilitySchema.parse({
            probability: median(
              quotes.map(({ probability }) => probability),
            ),
            bookmakerCount: quotes.length,
            bookmakerQuotes: quotes,
          }),
        ];
      }),
    ),
  };
}

type MatchOutcome = 'home' | 'draw' | 'away';

function matchOutcome(
  market: SportsGameOddsMarket,
): MatchOutcome | null {
  if (
    market.statID !== 'points' ||
    market.betTypeID !== 'ml3way' ||
    !['game', 'reg'].includes(market.periodID)
  ) {
    return null;
  }
  const side = market.sideID.trim().toLocaleLowerCase();
  if (side === 'home' || side === 'draw' || side === 'away') return side;
  const fromId = market.oddID
    .trim()
    .toLocaleLowerCase()
    .match(/-ml3way-(home|draw|away)$/)?.[1];
  return fromId === 'home' || fromId === 'draw' || fromId === 'away'
    ? fromId
    : null;
}

function extractMatchOddsSnapshot(
  event: SportsGameOddsEvent,
  capturedAt: string,
): MatchOddsSnapshot | null {
  const byBookmaker = new Map<
    string,
    {
      game: Partial<Record<MatchOutcome, number>>;
      reg: Partial<Record<MatchOutcome, number>>;
    }
  >();
  for (const market of Object.values(event.odds ?? {})) {
    const outcome = matchOutcome(market);
    if (!outcome) continue;
    const period = market.periodID === 'reg' ? 'reg' : 'game';
    for (const [bookmaker, quote] of Object.entries(
      market.byBookmaker ?? {},
    )) {
      if (quote.available === false) continue;
      const price = decimalOdds(quote.odds);
      if (price === null) continue;
      const periods = byBookmaker.get(bookmaker) ?? {
        game: {},
        reg: {},
      };
      periods[period][outcome] = price;
      byBookmaker.set(bookmaker, periods);
    }
  }

  const probabilities: Array<Record<MatchOutcome, number>> = [];
  for (const periods of byBookmaker.values()) {
    const regulationComplete =
      periods.reg.home && periods.reg.draw && periods.reg.away;
    const prices = regulationComplete ? periods.reg : periods.game;
    const home = prices.home;
    const draw = prices.draw;
    const away = prices.away;
    if (!home || !draw || !away) continue;
    const raw = { home: 1 / home, draw: 1 / draw, away: 1 / away };
    const total = raw.home + raw.draw + raw.away;
    probabilities.push({
      home: raw.home / total,
      draw: raw.draw / total,
      away: raw.away / total,
    });
  }
  if (probabilities.length === 0) return null;
  const combined = {
    home: median(probabilities.map(({ home }) => home)),
    draw: median(probabilities.map(({ draw }) => draw)),
    away: median(probabilities.map(({ away }) => away)),
  };
  const total = combined.home + combined.draw + combined.away;
  return MatchOddsSnapshotSchema.parse({
    status: 'available',
    eventId: event.eventID,
    capturedAt,
    expiresAt: new Date(
      Date.parse(event.status.startsAt) + matchSnapshotAfterKickoffMs,
    ).toISOString(),
    home: combined.home / total,
    draw: combined.draw / total,
    away: combined.away / total,
    bookmakerCount: probabilities.length,
  });
}

interface PendingSportsGameOddsFixture {
  fixture: FixtureGroup;
  markets: OddsMarketKey[];
}

export class SportsGameOddsPlayerMarketOddsProvider
  implements PlayerMarketOddsProvider
{
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly inFlightRefreshes = new Map<string, Promise<void>>();

  constructor(private readonly options: SportsGameOddsOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  supports(player: PlayerStats): boolean {
    return supportsPlayerCompetition(
      player,
      this.options.supportedCompetitionSlugs ?? ['mlspa'],
    );
  }

  supportsMarket(
    player: PlayerStats,
    _market: PlayerMarketField,
  ): boolean {
    return this.supports(player);
  }

  drivesMarketRequest(
    player: PlayerStats,
    market: PlayerMarketField,
  ): boolean {
    return (
      this.supports(player) &&
      (this.options.supportedMarkets ?? ['goal', 'assist']).includes(market)
    );
  }

  supportsMatchOdds(player: PlayerStats): boolean {
    return (
      Boolean(this.options.matchOddsStore) &&
      supportsFixtureCompetition(
        player,
        this.options.supportedCompetitionSlugs ?? ['mlspa'],
      )
    );
  }

  private requestDrivingMarketKeys(): OddsMarketKey[] {
    const supported = this.options.supportedMarkets ?? ['goal', 'assist'];
    return [
      ...(supported.includes('goal')
        ? (['player_goal_scorer_anytime'] as const)
        : []),
      ...(supported.includes('assist')
        ? (['player_assists'] as const)
        : []),
    ];
  }

  async refreshUsage(): Promise<ProviderQuotaUsage[]> {
    if (this.options.refreshUsage === false) return [];
    const body = await this.requestJson('/account/usage', {});
    const usage = sportsGameOddsQuotaUsage(
      body,
      new Date(this.now()).toISOString(),
    );
    if (!usage) {
      this.options.logger.warn(
        {},
        'SportsGameOdds usage response did not contain a finite monthly object limit',
      );
      return [];
    }
    await this.options.usageStore?.set(usage);
    return [usage];
  }

  private async loadFixtureSnapshots(
    fixtureKey: string,
    cacheOnly: boolean,
    cacheOnlyReadBudgetMs?: number,
  ): Promise<Map<OddsMarketKey, MarketSnapshot>> {
    const storeKey = fixtureStoreKey(fixtureKey);
    const byMarket = new Map<OddsMarketKey, MarketSnapshot>();
    const reads = sportsGameOddsMarketKeys.map(async (market) => ({
      market,
      snapshot: await settleCacheReadWithin(
        this.options.store.get(storeKey, market),
        cacheOnly,
        cacheOnlyReadBudgetMs,
      ),
    }));
    if (!cacheOnly) {
      const loaded = await Promise.all(reads);
      for (const { market, snapshot } of loaded) {
        if (snapshot) byMarket.set(market, snapshot);
      }
      return byMarket;
    }
    const loaded = await Promise.allSettled(reads);
    for (const result of loaded) {
      if (result.status !== 'fulfilled') continue;
      const { market, snapshot } = result.value;
      if (snapshot) byMarket.set(market, snapshot);
    }
    return byMarket;
  }

  private async loadCachedFixtureSnapshots(
    fixtures: readonly FixtureGroup[],
    loadOptions?: PlayerMarketOddsLoadOptions,
  ): Promise<Map<string, Map<OddsMarketKey, MarketSnapshot>>> {
    const entries = fixtures.flatMap((fixture) =>
      sportsGameOddsMarketKeys.map((market) => ({
        resultFixtureKey: fixture.key,
        market,
        request: {
          fixtureKey: fixtureStoreKey(fixture.key),
          market,
        },
      })),
    );
    const loaded = await readMarketSnapshotsWithin(
      this.options.store,
      entries.map(({ request }) => request),
      true,
      cacheOnlySnapshotReadBudgetMs(loadOptions),
    );
    const snapshots = new Map<string, Map<OddsMarketKey, MarketSnapshot>>(
      fixtures.map((fixture) => [fixture.key, new Map()]),
    );
    for (const [index, entry] of entries.entries()) {
      const snapshot = loaded[index];
      if (snapshot) snapshots.get(entry.resultFixtureKey)?.set(entry.market, snapshot);
    }
    return snapshots;
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
    const snapshots = new Map<string, Map<OddsMarketKey, MarketSnapshot>>();
    const pending: PendingSportsGameOddsFixture[] = [];
    const cacheOnly = loadOptions?.cacheOnly === true;
    const cachedFixtureSnapshots = new Map<
      string,
      Map<OddsMarketKey, MarketSnapshot>
    >();
    if (cacheOnly) {
      const loadedFixtures = await this.loadCachedFixtureSnapshots(
        fixtures,
        loadOptions,
      );
      for (const [fixtureKey, snapshots] of loadedFixtures) {
        cachedFixtureSnapshots.set(fixtureKey, snapshots);
      }
    }
    for (const fixture of fixtures) {
      const byMarket = cacheOnly
        ? (cachedFixtureSnapshots.get(fixture.key) ??
          new Map<OddsMarketKey, MarketSnapshot>())
        : await this.loadFixtureSnapshots(fixture.key, false);
      snapshots.set(fixture.key, byMarket);
      if (
        !cacheOnly &&
        this.insideWindow(fixture.date, this.options.fetchWindowMs)
      ) {
        const markets = this.playerMarketsNeedingRefresh(fixture, byMarket);
        if (markets.length > 0) pending.push({ fixture, markets });
      }
    }

    if (pending.length > 0) {
      await this.refreshWithCoordination(pending, snapshots, new Map());
    }

    for (const fixture of fixtures) {
      const byMarket = snapshots.get(fixture.key);
      const available = (
        market: OddsMarketKey,
      ): FrozenMarketSnapshot | undefined => {
        const snapshot = byMarket?.get(market);
        return snapshot?.status === 'available' ? snapshot : undefined;
      };
      const goalSnapshot = available('player_goal_scorer_anytime');
      const assistSnapshot = available('player_assists');
      const decisiveSnapshot = available('player_goal_or_assist');
      for (const player of fixture.players) {
        const goal = playerProbability(
          goalSnapshot,
          player,
          fixture.players,
        );
        const assist = playerProbability(
          assistSnapshot,
          player,
          fixture.players,
        );
        const decisive = playerProbability(
          decisiveSnapshot,
          player,
          fixture.players,
        );
        if (!goal && !assist && !decisive) continue;
        const capturedAt = [
          goalSnapshot?.capturedAt,
          assistSnapshot?.capturedAt,
          decisiveSnapshot?.capturedAt,
        ]
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1);
        if (!capturedAt) continue;
        output.set(
          playerMarketOddsKey(player),
          PlayerMarketOddsSchema.parse({
            source: 'sports-game-odds',
            capturedAt,
            goal,
            assist,
            decisive,
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
    const matchStore = this.options.matchOddsStore;
    if (!matchStore) return output;
    const fixtures = groupFixtures(
      players.filter((player) => this.supportsMatchOdds(player)),
      { includeGoalkeepers: true },
    );
    if (fixtures.length === 0) return output;

    const cacheOnly = loadOptions?.cacheOnly === true;
    const matchSnapshots = new Map<string, MatchOddsSnapshot>();
    const reads = fixtures.map(async (fixture) => ({
      fixture,
      snapshot: await settleCacheReadWithin(
        matchStore.get(fixtureStoreKey(fixture.key)),
        cacheOnly,
      ),
    }));
    const loaded = cacheOnly
      ? (await Promise.allSettled(reads)).flatMap((result) =>
          result.status === 'fulfilled' ? [result.value] : [],
        )
      : await Promise.all(reads);
    const pending: PendingSportsGameOddsFixture[] = [];
    for (const { fixture, snapshot } of loaded) {
      if (snapshot && this.matchSnapshotIsReusable(snapshot)) {
        matchSnapshots.set(fixture.key, snapshot);
        continue;
      }
      if (
        !cacheOnly &&
        this.insideWindow(
          fixture.date,
          this.options.matchOddsFetchWindowMs ?? this.options.fetchWindowMs,
        )
      ) {
        pending.push({ fixture, markets: [] });
      }
    }

    if (pending.length > 0) {
      const snapshots = new Map<
        string,
        Map<OddsMarketKey, MarketSnapshot>
      >();
      const snapshotReads = await Promise.allSettled(
        pending.map(async ({ fixture }) => ({
          fixture,
          snapshots: await this.loadFixtureSnapshots(fixture.key, false),
        })),
      );
      for (const result of snapshotReads) {
        if (result.status !== 'fulfilled') continue;
        const { fixture, snapshots: byMarket } = result.value;
        snapshots.set(fixture.key, byMarket);
        if (this.insideWindow(fixture.date, this.options.fetchWindowMs)) {
          const pendingFixture = pending.find(
            ({ fixture: candidate }) => candidate.key === fixture.key,
          );
          if (pendingFixture) {
            pendingFixture.markets = this.playerMarketsNeedingRefresh(
              fixture,
              byMarket,
            );
          }
        }
      }
      await this.refreshWithCoordination(
        pending,
        snapshots,
        matchSnapshots,
      );
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

  private insideWindow(fixtureDate: string, windowMs: number): boolean {
    const kickoff = Date.parse(fixtureDate);
    const untilKickoff = kickoff - this.now();
    return (
      Number.isFinite(kickoff) &&
      untilKickoff >= 0 &&
      untilKickoff <= windowMs
    );
  }

  private matchSnapshotIsReusable(snapshot: MatchOddsSnapshot): boolean {
    const expiresAt = Date.parse(snapshot.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt > this.now();
  }

  private playerMarketsNeedingRefresh(
    fixture: FixtureGroup,
    snapshots: ReadonlyMap<OddsMarketKey, MarketSnapshot>,
  ): OddsMarketKey[] {
    const kickoff = Date.parse(fixture.date);
    return this.requestDrivingMarketKeys().filter((market) => {
      const snapshot = snapshots.get(market);
      return (
        !snapshot ||
        (snapshot.status === 'unavailable'
          ? shouldRetryMarketFailure(snapshot, kickoff, this.now())
          : needsFrozenSnapshotSupplement(
              snapshot,
              fixture.players,
              fixture.date,
              this.now(),
            ))
      );
    });
  }

  private refreshRequestGroup(): string {
    return [
      'sports-game-odds',
      this.options.leagueId,
      'fixture-odds',
    ].join(':');
  }

  private async refreshWithCoordination(
    pending: readonly PendingSportsGameOddsFixture[],
    snapshots: Map<string, Map<OddsMarketKey, MarketSnapshot>>,
    matchSnapshots: Map<string, MatchOddsSnapshot>,
  ): Promise<void> {
    const unique = new Map<string, PendingSportsGameOddsFixture>();
    for (const candidate of pending) {
      const existing = unique.get(candidate.fixture.key);
      if (existing) {
        existing.markets = [
          ...new Set([...existing.markets, ...candidate.markets]),
        ];
      } else {
        unique.set(candidate.fixture.key, {
          fixture: candidate.fixture,
          markets: [...candidate.markets],
        });
      }
    }

    const joined = new Set<Promise<void>>();
    const ownedCandidates: PendingSportsGameOddsFixture[] = [];
    for (const candidate of unique.values()) {
      const inFlight = this.inFlightRefreshes.get(candidate.fixture.key);
      if (inFlight) joined.add(inFlight);
      else ownedCandidates.push(candidate);
    }

    let ownRefresh: Promise<void> | null = null;
    if (ownedCandidates.length > 0) {
      ownRefresh = this.refreshClaimedFixtures(
        ownedCandidates,
        snapshots,
        matchSnapshots,
      );
      for (const { fixture } of ownedCandidates) {
        this.inFlightRefreshes.set(fixture.key, ownRefresh);
      }
      joined.add(ownRefresh);
    }

    await Promise.allSettled(joined);
    if (ownRefresh) {
      for (const { fixture } of ownedCandidates) {
        if (this.inFlightRefreshes.get(fixture.key) === ownRefresh) {
          this.inFlightRefreshes.delete(fixture.key);
        }
      }
    }

    const reloaded = await Promise.all(
      [...unique.values()].map(async ({ fixture }) => {
        const [markets, match] = await Promise.allSettled([
          this.loadFixtureSnapshots(fixture.key, false),
          this.options.matchOddsStore
            ? this.options.matchOddsStore.get(fixtureStoreKey(fixture.key))
            : Promise.resolve(undefined),
        ]);
        return { fixture, markets, match };
      }),
    );
    for (const { fixture, markets, match: matchResult } of reloaded) {
      if (markets.status === 'fulfilled') {
        snapshots.set(fixture.key, markets.value);
      }
      const match =
        matchResult.status === 'fulfilled' ? matchResult.value : undefined;
      if (match && this.matchSnapshotIsReusable(match)) {
        matchSnapshots.set(fixture.key, match);
      }
    }
  }

  private async refreshClaimedFixtures(
    pending: readonly PendingSportsGameOddsFixture[],
    snapshots: Map<string, Map<OddsMarketKey, MarketSnapshot>>,
    matchSnapshots: Map<string, MatchOddsSnapshot>,
  ): Promise<void> {
    const requestGroup = this.refreshRequestGroup();
    const owned: PendingSportsGameOddsFixture[] = [];
    try {
      const claims = await Promise.allSettled(
        pending.map(async (candidate) => ({
          candidate,
          ownsLease: this.options.store.claimRefreshLease
            ? await this.options.store.claimRefreshLease(
                candidate.fixture.key,
                requestGroup,
                this.options.refreshLeaseTtlMs ?? defaultRefreshLeaseTtlMs,
              )
            : true,
        })),
      );
      for (const claim of claims) {
        if (claim.status !== 'fulfilled') {
          this.options.logger.warn(
            {
              provider: 'sports-game-odds',
              leagueId: this.options.leagueId,
              error:
                claim.reason instanceof Error
                  ? claim.reason.message
                  : String(claim.reason),
            },
            'SportsGameOdds refresh lease could not be claimed',
          );
          continue;
        }
        if (claim.value.ownsLease) {
          owned.push(claim.value.candidate);
        } else {
          this.options.logger.debug(
            {
              provider: 'sports-game-odds',
              leagueId: this.options.leagueId,
              fixture: claim.value.candidate.fixture.key,
            },
            'SportsGameOdds fixture refresh skipped because another Worker owns the lease',
          );
        }
      }
      if (owned.length > 0) {
        await this.refreshFixtures(owned, snapshots, matchSnapshots);
      }
    } catch (error) {
      await Promise.allSettled(
        owned.map(({ fixture }) =>
          this.options.store.releaseRefreshLease?.(
            fixture.key,
            requestGroup,
          ),
        ),
      );
      this.options.logger.warn(
        {
          provider: 'sports-game-odds',
          leagueId: this.options.leagueId,
          error: error instanceof Error ? error.message : String(error),
          fixtures: owned.length,
        },
        'SportsGameOdds lookup failed; retaining existing fixture snapshots',
      );
    }
  }

  private async refreshFixtures(
    pending: readonly PendingSportsGameOddsFixture[],
    snapshots: Map<string, Map<OddsMarketKey, MarketSnapshot>>,
    matchSnapshots: Map<string, MatchOddsSnapshot>,
  ): Promise<void> {
    const events = await this.loadEvents(pending, snapshots, matchSnapshots);
    const capturedAt = new Date(this.now()).toISOString();
    for (const { fixture, markets } of pending) {
      const storeKey = fixtureStoreKey(fixture.key);
      const byMarket =
        snapshots.get(fixture.key) ??
        new Map<OddsMarketKey, MarketSnapshot>();
      const requestedMarkets = new Set(markets);
      const event = findEvent(fixture, events);
      for (const market of sportsGameOddsMarketKeys) {
        const existing = byMarket.get(market);
        const extracted = event
          ? extractMarketSnapshot(event, market, capturedAt)
          : null;
        const snapshot = extracted
          ? supplementFrozenSnapshot(
              existing?.status === 'available' ? existing : undefined,
              extracted,
              fixture.players,
              fixture.date,
            )
          : requestedMarkets.has(market)
            ? existing?.status === 'available'
              ? recordFrozenSnapshotCheck(
                  existing,
                  fixture.players,
                  fixture.date,
                  this.now(),
                )
              : missingMarketSnapshot(
                  fixture,
                  market,
                  existing,
                  this.now(),
                  event?.eventID,
                )
            : null;
        if (!snapshot) continue;
        await this.options.store.set(storeKey, snapshot);
        byMarket.set(market, snapshot);
      }
      snapshots.set(fixture.key, byMarket);

      const matchStore = this.options.matchOddsStore;
      if (
        !matchStore ||
        !this.insideWindow(
          fixture.date,
          this.options.matchOddsFetchWindowMs ?? this.options.fetchWindowMs,
        )
      ) {
        continue;
      }
      try {
        const storedMatch =
          matchSnapshots.get(fixture.key) ??
          (await matchStore.get(storeKey));
        if (
          storedMatch?.status === 'available' &&
          this.matchSnapshotIsReusable(storedMatch)
        ) {
          matchSnapshots.set(fixture.key, storedMatch);
          continue;
        }
        const extractedMatch = event
          ? extractMatchOddsSnapshot(event, capturedAt)
          : null;
        const nextMatch =
          extractedMatch ??
          MatchOddsSnapshotSchema.parse({
            status: 'unavailable',
            ...(event ? { eventId: event.eventID } : {}),
            checkedAt: capturedAt,
            expiresAt: new Date(
              Math.min(
                Date.parse(fixture.date),
                this.now() +
                  (this.options.matchOddsMissTtlMs ??
                    defaultMatchOddsMissTtlMs),
              ),
            ).toISOString(),
          });
        await matchStore.set(storeKey, nextMatch);
        matchSnapshots.set(fixture.key, nextMatch);
      } catch (error) {
        this.options.logger.warn(
          {
            provider: 'sports-game-odds',
            leagueId: this.options.leagueId,
            fixture: fixture.key,
            error: error instanceof Error ? error.message : String(error),
          },
          'SportsGameOdds H-D-A snapshot could not be persisted',
        );
      }
    }
  }

  private async loadEvents(
    pending: readonly PendingSportsGameOddsFixture[],
    snapshots: ReadonlyMap<string, ReadonlyMap<OddsMarketKey, MarketSnapshot>>,
    matchSnapshots: ReadonlyMap<string, MatchOddsSnapshot>,
  ): Promise<SportsGameOddsEvent[]> {
    const eventIdByFixture = new Map<string, string>();
    for (const { fixture } of pending) {
      const marketEventId = [
        ...(snapshots.get(fixture.key)?.values() ?? []),
      ]
        .map((snapshot) => snapshot.eventId)
        .find((eventId): eventId is string => Boolean(eventId));
      const eventId =
        marketEventId ?? matchSnapshots.get(fixture.key)?.eventId;
      if (eventId) eventIdByFixture.set(fixture.key, eventId);
    }

    const events = new Map<string, SportsGameOddsEvent>();
    let truncated = false;
    const requestEvents = async (
      query: Readonly<Record<string, string>>,
    ): Promise<void> => {
      const response = await this.requestJson('/events', query);
      const parsed = SportsGameOddsEventsEnvelopeSchema.parse(response);
      if (!parsed.success) {
        throw new Error('SportsGameOdds reported an unsuccessful response');
      }
      await this.recordConsumedObjects(parsed.data.length);
      for (const event of parsed.data) events.set(event.eventID, event);
      truncated ||= Boolean(parsed.nextCursor);
    };

    const directEventIds = [...new Set(eventIdByFixture.values())];
    for (
      let offset = 0;
      offset < directEventIds.length;
      offset += directEventBatchSize
    ) {
      await requestEvents({
        eventIDs: directEventIds
          .slice(offset, offset + directEventBatchSize)
          .join(','),
        includeOpposingOdds: 'true',
        limit: String(directEventBatchSize),
      });
    }

    const unknownFixtures = pending
      .map(({ fixture }) => fixture)
      .filter((fixture) => !eventIdByFixture.has(fixture.key));
    if (unknownFixtures.length > 0) {
      const kickoffs = unknownFixtures
        .map(({ date }) => Date.parse(date))
        .filter(Number.isFinite);
      const startsAfter = new Date(
        Math.min(...kickoffs) - 6 * 60 * 60 * 1_000,
      );
      const startsBefore = new Date(
        Math.max(...kickoffs) + 6 * 60 * 60 * 1_000,
      );
      await requestEvents({
        leagueID: this.options.leagueId,
        oddsAvailable: 'true',
        ended: 'false',
        startsAfter: startsAfter.toISOString(),
        startsBefore: startsBefore.toISOString(),
        includeOpposingOdds: 'true',
        // SportsGameOdds bills each returned event object. Keep discovery
        // narrow and target known fixtures by ID on later checks.
        limit: String(directEventBatchSize),
      });
    }

    this.options.logger.info(
      {
        leagueId: this.options.leagueId,
        events: events.size,
        fixtures: pending.length,
        directEventIds: directEventIds.length,
        discoveredFixtures: unknownFixtures.length,
        truncated,
      },
      'SportsGameOdds fixture snapshot received',
    );
    return [...events.values()];
  }

  private async recordConsumedObjects(objects: number): Promise<void> {
    if (objects <= 0 || !this.options.usageStore) return;
    try {
      const current = await this.options.usageStore.get('sports-game-odds');
      if (!current) return;
      const updated = quotaUsage(
        'sports-game-odds',
        'objects',
        current.used + objects,
        current.limit,
        new Date(this.now()).toISOString(),
        current.interval,
      );
      if (updated) await this.options.usageStore.set(updated);
    } catch (error) {
      this.options.logger.warn(
        {
          objects,
          error: error instanceof Error ? error.message : String(error),
        },
        'SportsGameOdds local usage increment could not be persisted',
      );
    }
  }

  private async requestJson(
    path: string,
    query: Readonly<Record<string, string>>,
  ): Promise<unknown> {
    const url = new URL(
      `${this.options.baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`,
    );
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
          headers: {
            accept: 'application/json',
            'x-api-key': this.options.apiKey,
          },
          signal: controller.signal,
        });
        const retryable =
          response.status === 429 || [502, 503, 504].includes(response.status);
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
          throw new SportsGameOddsHttpError(response.status);
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
    throw new Error('SportsGameOdds retry budget exhausted');
  }
}

export class SportsGameOddsFixtureMatchOddsProvider
  implements FixtureMatchOddsProvider
{
  constructor(private readonly source: SportsGameOddsPlayerMarketOddsProvider) {}

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

export class SupplementingPlayerMarketOddsProvider
  implements PlayerMarketOddsProvider
{
  constructor(
    private readonly primary: PlayerMarketOddsProvider,
    private readonly fallback: PlayerMarketOddsProvider,
    private readonly supplementMarkets: readonly PlayerMarketField[] = [
      'goal',
      'assist',
    ],
    private readonly cacheOnlyProviderBudgetMs =
      defaultCacheOnlyProviderBudgetMs,
    private readonly requestMarkets: readonly PlayerMarketField[] =
      supplementMarkets,
  ) {}

  supports(player: PlayerStats): boolean {
    return (
      (this.primary.supports?.(player) ?? true) ||
      (this.fallback.supports?.(player) ?? true)
    );
  }

  supportsMarket(player: PlayerStats, market: PlayerMarketField): boolean {
    return (
      playerMarketFieldSupported(this.primary, player, market) ||
      (this.supplementMarkets.includes(market) &&
        playerMarketFieldSupported(this.fallback, player, market))
    );
  }

  drivesMarketRequest(
    player: PlayerStats,
    market: PlayerMarketField,
  ): boolean {
    return (
      playerMarketFieldDrivesRequest(this.primary, player, market) ||
      (this.requestMarkets.includes(market) &&
        playerMarketFieldDrivesRequest(this.fallback, player, market))
    );
  }

  async refreshUsage(): Promise<ProviderQuotaUsage[]> {
    const results = await Promise.allSettled([
      this.primary.refreshUsage?.() ?? Promise.resolve([]),
      this.fallback.refreshUsage?.() ?? Promise.resolve([]),
    ]);
    return results.flatMap((result) =>
      result.status === 'fulfilled' ? result.value : [],
    );
  }

  async load(
    players: readonly PlayerStats[],
    loadOptions?: PlayerMarketOddsLoadOptions,
  ): Promise<Map<string, PlayerMarketOdds | null>> {
    const eligiblePlayers = players.filter((player) => this.supports(player));
    const primaryPlayers = eligiblePlayers.filter(
      (player) => this.primary.supports?.(player) ?? true,
    );
    const fallbackCanSupply = (player: PlayerStats) =>
      this.supplementMarkets.some((market) =>
        playerMarketFieldSupported(this.fallback, player, market),
      );

    let primaryValues: Map<string, PlayerMarketOdds | null>;
    let fallbackValues: Map<string, PlayerMarketOdds | null>;
    if (loadOptions?.cacheOnly) {
      // Cache reads are independent. Running them concurrently keeps a deep
      // provider chain inside the response budget and avoids briefly hiding
      // a quote that is already present in a lower-priority snapshot.
      const startedAt = Date.now();
      const deadline =
        loadOptions.cacheOnlyDeadlineMs ??
        startedAt + this.cacheOnlyProviderBudgetMs;
      const returnSlackMs = Math.min(
        10,
        Math.max(1, Math.floor(this.cacheOnlyProviderBudgetMs / 4)),
      );
      const childDeadline = Math.max(startedAt + 1, deadline - returnSlackMs);
      const childOptions: PlayerMarketOddsLoadOptions = {
        ...loadOptions,
        cacheOnlyDeadlineMs: childDeadline,
      };
      const remainingBudgetMs = Math.max(1, deadline - Date.now());
      const fallbackPlayers = eligiblePlayers.filter(fallbackCanSupply);
      const [primaryValuesWithinBudget, fallbackValuesWithinBudget] =
        await Promise.all([
          settleMarketOddsWithin(
            primaryPlayers.length > 0
              ? this.primary.load(primaryPlayers, childOptions)
              : Promise.resolve(
                  new Map<string, PlayerMarketOdds | null>(),
                ),
            remainingBudgetMs,
          ),
          settleMarketOddsWithin(
            fallbackPlayers.length > 0
              ? this.fallback.load(fallbackPlayers, childOptions)
              : Promise.resolve(
                  new Map<string, PlayerMarketOdds | null>(),
                ),
            remainingBudgetMs,
          ),
        ]);
      primaryValues = primaryValuesWithinBudget;
      fallbackValues = fallbackValuesWithinBudget;
    } else {
      // Paid network fallbacks remain sequential: only contact the next
      // provider for markets the higher-priority provider could not fill.
      // Non-request-driving markets still get one bounded cache read so an
      // already captured assist cannot disappear behind a primary goal quote.
      const opportunisticMarkets = this.supplementMarkets.filter(
        (market) => !this.requestMarkets.includes(market),
      );
      const opportunisticPlayers = eligiblePlayers.filter((player) =>
        opportunisticMarkets.some((market) =>
          playerMarketFieldSupported(this.fallback, player, market),
        ),
      );
      const cacheOnlyDeadlineMs =
        Date.now() + this.cacheOnlyProviderBudgetMs;
      const cachedFallbackPending =
        opportunisticPlayers.length > 0
          ? settleMarketOddsWithin(
              this.fallback.load(opportunisticPlayers, {
                ...loadOptions,
                cacheOnly: true,
                cacheOnlyDeadlineMs,
              }),
              this.cacheOnlyProviderBudgetMs,
            )
          : Promise.resolve(new Map<string, PlayerMarketOdds | null>());
      try {
        primaryValues =
          primaryPlayers.length > 0
            ? await this.primary.load(primaryPlayers, loadOptions)
            : new Map<string, PlayerMarketOdds | null>();
      } catch {
        primaryValues = new Map<string, PlayerMarketOdds | null>();
      }
      const cachedFallbackValues = await cachedFallbackPending;
      const fallbackPlayers = eligiblePlayers.filter((player) => {
        if (!fallbackCanSupply(player)) return false;
        const key = playerMarketOddsKey(player);
        const odds = supplementPlayerMarketOdds(
          primaryValues.get(key) ?? null,
          cachedFallbackValues.get(key) ?? null,
          this.supplementMarkets,
        );
        return this.requestMarkets.some(
          (market) =>
            playerMarketFieldDrivesRequest(this.fallback, player, market) &&
            !odds?.[market],
        );
      });
      try {
        const refreshedFallbackValues =
          fallbackPlayers.length > 0
            ? await this.fallback.load(fallbackPlayers, loadOptions)
            : new Map<string, PlayerMarketOdds | null>();
        fallbackValues = new Map(cachedFallbackValues);
        for (const player of fallbackPlayers) {
          const key = playerMarketOddsKey(player);
          fallbackValues.set(
            key,
            supplementPlayerMarketOdds(
              refreshedFallbackValues.get(key) ?? null,
              cachedFallbackValues.get(key) ?? null,
              this.supplementMarkets,
            ),
          );
        }
      } catch {
        fallbackValues = cachedFallbackValues;
      }
    }
    return new Map(
      players.map((player) => {
        const key = playerMarketOddsKey(player);
        const primary = primaryValues.get(key) ?? null;
        const fallback = fallbackValues.get(key) ?? null;
        return [
          key,
          supplementPlayerMarketOdds(
            primary,
            fallback,
            this.supplementMarkets,
          ),
        ];
      }),
    );
  }
}

export function sportsGameOddsFixtureStoreKey(
  nextGame: NonNullable<PlayerStats['nextGame']>,
): string | null {
  const key = marketFixtureKey(nextGame);
  return key ? fixtureStoreKey(key) : null;
}
