import {
  MarketProbabilitySchema,
  PlayerMarketOddsSchema,
  type BookmakerMarketQuote,
  type MarketProbability,
  type PlayerMarketOdds,
  type PlayerStats,
} from '@sorare-overlay/shared';
import { z } from 'zod';
import type { AppLogger } from '../logger.js';
import {
  groupFixtures,
  marketFixtureKey,
  missingMarketSnapshot,
  needsFrozenSnapshotSupplement,
  normalizePlayerName,
  normalizeTeamName,
  playerMarketOddsKey,
  playerProbability,
  recordFrozenSnapshotCheck,
  shouldRetryMarketFailure,
  supportsPlayerCompetition,
  supplementFrozenSnapshot,
  type FixtureGroup,
  type FrozenMarketSnapshot,
  type MarketSnapshot,
  type MarketSnapshotStore,
  type OddsMarketKey,
  type PlayerMarketOddsLoadOptions,
  type PlayerMarketOddsProvider,
} from './market-odds-provider.js';
import {
  providerProtection,
  protectionForUsage,
  quotaUsage,
  type ProviderQuotaUsage,
  type ProviderQuotaUsageStore,
} from './odds-usage.js';

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
  logger: AppLogger;
  usageStore?: ProviderQuotaUsageStore;
  refreshUsage?: boolean;
  supportedCompetitionSlugs?: readonly string[];
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
  return quotaUsage(
    'sports-game-odds',
    'objects',
    used,
    limit,
    checkedAt,
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
  const home = normalizeTeamName(fixture.homeTeamName);
  const away = normalizeTeamName(fixture.awayTeamName);
  const kickoff = Date.parse(fixture.date);
  return (
    events
      .filter(
        (event) =>
          normalizeTeamName(teamName(event.teams.home)) === home &&
          normalizeTeamName(teamName(event.teams.away)) === away,
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

export class SportsGameOddsPlayerMarketOddsProvider
  implements PlayerMarketOddsProvider
{
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;

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
      : await providerProtection(
          this.options.usageStore,
          'sports-game-odds',
          this.options.logger,
          this.now(),
        );

    const snapshots = new Map<string, Map<OddsMarketKey, MarketSnapshot>>();
    const pending: Array<{
      fixture: FixtureGroup;
      markets: OddsMarketKey[];
    }> = [];
    for (const fixture of fixtures) {
      const storeKey = fixtureStoreKey(fixture.key);
      const byMarket = new Map<OddsMarketKey, MarketSnapshot>();
      const loaded = await Promise.all(
        sportsGameOddsMarketKeys.map(async (market) => ({
          market,
          snapshot: await this.options.store.get(storeKey, market),
        })),
      );
      for (const { market, snapshot } of loaded) {
        if (snapshot) byMarket.set(market, snapshot);
      }
      snapshots.set(fixture.key, byMarket);
      const kickoff = Date.parse(fixture.date);
      const untilKickoff = kickoff - this.now();
      if (untilKickoff < 0 || untilKickoff > this.options.fetchWindowMs) {
        continue;
      }
      const markets = sportsGameOddsMarketKeys.filter((market) => {
        const snapshot = byMarket.get(market);
        return (
          !snapshot ||
          (snapshot.status === 'unavailable'
            ? shouldRetryMarketFailure(snapshot, kickoff, this.now())
            : protection.allowSnapshotSupplements &&
              needsFrozenSnapshotSupplement(
                snapshot,
                fixture.players,
                fixture.date,
                this.now(),
              ))
        );
      });
      if (
        !loadOptions?.cacheOnly &&
        protection.allowExternalRequests &&
        markets.length > 0
      ) {
        pending.push({ fixture, markets });
      }
    }

    if (pending.length > 0) {
      try {
        const events = await this.loadEvents(pending.map(({ fixture }) => fixture));
        const capturedAt = new Date(this.now()).toISOString();
        for (const { fixture, markets } of pending) {
          const storeKey = fixtureStoreKey(fixture.key);
          const byMarket =
            snapshots.get(fixture.key) ??
            new Map<OddsMarketKey, MarketSnapshot>();
          const event = findEvent(fixture, events);
          for (const market of markets) {
            const existing = byMarket.get(market);
            const extracted = event
              ? extractMarketSnapshot(event, market, capturedAt)
              : null;
            const snapshot =
              extracted
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
                      market,
                      existing,
                      this.now(),
                    );
            await this.options.store.set(storeKey, snapshot);
            byMarket.set(market, snapshot);
          }
          snapshots.set(fixture.key, byMarket);
        }
      } catch (error) {
        this.options.logger.warn(
          {
            error: error instanceof Error ? error.message : String(error),
            fixtures: pending.length,
          },
          'SportsGameOdds lookup failed; retaining existing market snapshots',
        );
      }
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

  private async loadEvents(
    fixtures: readonly FixtureGroup[],
  ): Promise<SportsGameOddsEvent[]> {
    const kickoffs = fixtures
      .map(({ date }) => Date.parse(date))
      .filter(Number.isFinite);
    const startsAfter = new Date(Math.min(...kickoffs) - 6 * 60 * 60 * 1_000);
    const startsBefore = new Date(Math.max(...kickoffs) + 6 * 60 * 60 * 1_000);
    const response = await this.requestJson('/events', {
      leagueID: this.options.leagueId,
      oddsAvailable: 'true',
      ended: 'false',
      startsAfter: startsAfter.toISOString(),
      startsBefore: startsBefore.toISOString(),
      includeOpposingOdds: 'true',
      limit: '100',
    });
    const parsed = SportsGameOddsEventsEnvelopeSchema.parse(response);
    if (!parsed.success) {
      throw new Error('SportsGameOdds reported an unsuccessful response');
    }
    this.options.logger.info(
      {
        leagueId: this.options.leagueId,
        events: parsed.data.length,
        fixtures: fixtures.length,
        truncated: Boolean(parsed.nextCursor),
      },
      'SportsGameOdds player-prop snapshot received',
    );
    return parsed.data;
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

export class SupplementingPlayerMarketOddsProvider
  implements PlayerMarketOddsProvider
{
  constructor(
    private readonly primary: PlayerMarketOddsProvider,
    private readonly fallback: PlayerMarketOddsProvider,
  ) {}

  supports(player: PlayerStats): boolean {
    return (
      (this.primary.supports?.(player) ?? true) ||
      (this.fallback.supports?.(player) ?? true)
    );
  }

  async refreshUsage(): Promise<ProviderQuotaUsage[]> {
    const results = await Promise.all([
      this.primary.refreshUsage?.() ?? Promise.resolve([]),
      this.fallback.refreshUsage?.() ?? Promise.resolve([]),
    ]);
    return results.flat();
  }

  async load(
    players: readonly PlayerStats[],
    loadOptions?: PlayerMarketOddsLoadOptions,
  ): Promise<Map<string, PlayerMarketOdds | null>> {
    const eligiblePlayers = players.filter((player) => this.supports(player));
    const primaryValues = await this.primary.load(eligiblePlayers, loadOptions);
    const fallbackPlayers = eligiblePlayers.filter((player) => {
      const odds = primaryValues.get(playerMarketOddsKey(player));
      return !odds?.goal || !odds?.assist;
    });
    const fallbackValues =
      fallbackPlayers.length > 0
        ? await this.fallback.load(fallbackPlayers, loadOptions)
        : new Map<string, PlayerMarketOdds | null>();
    return new Map(
      players.map((player) => {
        const key = playerMarketOddsKey(player);
        const primary = primaryValues.get(key) ?? null;
        const fallback = fallbackValues.get(key) ?? null;
        if (!primary && !fallback) return [key, null];
        if (!primary) return [key, fallback];
        if (!fallback) return [key, primary];
        const usedFallback =
          (!primary.goal && Boolean(fallback.goal)) ||
          (!primary.assist && Boolean(fallback.assist));
        if (!usedFallback) return [key, primary];
        return [
          key,
          PlayerMarketOddsSchema.parse({
            source: 'mixed',
            capturedAt: [primary.capturedAt, fallback.capturedAt].sort().at(-1),
            goal: primary.goal ?? fallback.goal,
            assist: primary.assist ?? fallback.assist,
            decisive: primary.decisive ?? fallback.decisive ?? null,
          }),
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
