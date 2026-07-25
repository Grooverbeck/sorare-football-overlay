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

export const oddsMarketKeys = [
  'player_goal_scorer_anytime',
  'player_assists',
] as const;

export const marketSnapshotKeys = [
  ...oddsMarketKeys,
  'player_goal_or_assist',
] as const;

export const OddsMarketKeySchema = z.enum(marketSnapshotKeys);
export type OddsMarketKey = z.infer<typeof OddsMarketKeySchema>;

const MarketRetryStateSchema = z.object({
  checkedAt: z.string().datetime(),
  attemptCount: z.number().int().min(1),
  nextRetryAt: z.string().datetime().nullable(),
});

const MissingPlayerCheckSchema = z.union([
  // Backward compatibility for snapshots written before adaptive retries.
  z.string().datetime(),
  MarketRetryStateSchema,
]);

const FrozenMarketSnapshotSchema = z.object({
  status: z.literal('available'),
  market: OddsMarketKeySchema,
  eventId: z.string().min(1),
  capturedAt: z.string().datetime(),
  // A successful market remains frozen. One optional supplement pass may add
  // late-listed players and bookmaker detail without changing captured values.
  supplementedAt: z.string().datetime().optional(),
  // A missing requested player is retried only after a long cooldown.
  missingPlayerChecks: z
    .record(z.string().min(1), MissingPlayerCheckSchema)
    .optional(),
  players: z.record(z.string().min(1), MarketProbabilitySchema),
});

const MissingMarketSnapshotSchema = z.object({
  status: z.literal('unavailable'),
  market: OddsMarketKeySchema,
  checkedAt: z.string().datetime(),
  attemptCount: z.number().int().min(1).optional(),
  nextRetryAt: z.string().datetime().nullable().optional(),
  expiresAt: z.string().datetime().optional(),
});

export const MarketSnapshotSchema = z.discriminatedUnion('status', [
  FrozenMarketSnapshotSchema,
  MissingMarketSnapshotSchema,
]);

export type FrozenMarketSnapshot = z.infer<typeof FrozenMarketSnapshotSchema>;
export type MarketSnapshot = z.infer<typeof MarketSnapshotSchema>;

export interface MarketSnapshotStore {
  get(fixtureKey: string, market: OddsMarketKey): Promise<MarketSnapshot | undefined>;
  set(fixtureKey: string, snapshot: MarketSnapshot): void | Promise<void>;
}

interface MemoryEntry {
  snapshot: MarketSnapshot;
  expiresAt: number | null;
}

export class InMemoryMarketSnapshotStore implements MarketSnapshotStore {
  private readonly entries = new Map<string, MemoryEntry>();

  constructor(
    private readonly missTtlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async get(
    fixtureKey: string,
    market: OddsMarketKey,
  ): Promise<MarketSnapshot | undefined> {
    const key = this.key(fixtureKey, market);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.snapshot;
  }

  set(fixtureKey: string, snapshot: MarketSnapshot): void {
    this.entries.set(this.key(fixtureKey, snapshot.market), {
      snapshot,
      expiresAt:
        snapshot.status === 'available'
          ? null
          : snapshot.expiresAt
            ? Date.parse(snapshot.expiresAt)
            : this.now() + this.missTtlMs,
    });
  }

  private key(fixtureKey: string, market: OddsMarketKey): string {
    return `${fixtureKey}:${market}`;
  }
}

export interface PlayerMarketOddsProvider {
  load(
    players: readonly PlayerStats[],
    options?: PlayerMarketOddsLoadOptions,
  ): Promise<Map<string, PlayerMarketOdds | null>>;
}

export interface PlayerMarketOddsLoadOptions {
  // Read immutable snapshots only. External bookmaker APIs must never be
  // contacted on the player-stats response path.
  cacheOnly?: boolean;
}

export function playerMarketOddsKey(
  player: Pick<PlayerStats, 'slug' | 'position'>,
): string {
  return `${player.slug}:${player.position}`;
}

export class UnavailablePlayerMarketOddsProvider
  implements PlayerMarketOddsProvider
{
  async load(
    players: readonly PlayerStats[],
    _options?: PlayerMarketOddsLoadOptions,
  ): Promise<Map<string, PlayerMarketOdds | null>> {
    return new Map(players.map((player) => [playerMarketOddsKey(player), null]));
  }
}

export class MockPlayerMarketOddsProvider implements PlayerMarketOddsProvider {
  constructor(private readonly now: () => number = Date.now) {}

  async load(
    players: readonly PlayerStats[],
    _options?: PlayerMarketOddsLoadOptions,
  ): Promise<Map<string, PlayerMarketOdds | null>> {
    const capturedAt = new Date(this.now()).toISOString();
    return new Map(
      players.map((player) => {
        if (player.position === 'Goalkeeper' || !player.nextGame) {
          return [playerMarketOddsKey(player), null];
        }
        const seed = [...player.slug].reduce(
          (total, character) =>
            (total * 31 + character.charCodeAt(0)) >>> 0,
          7,
        );
        const goalProbability = 0.12 + (seed % 24) / 100;
        const assistProbability = 0.08 + ((seed >>> 4) % 17) / 100;
        const decisiveProbability =
          0.18 + ((seed >>> 8) % 29) / 100;
        const mockQuotes = (
          probability: number,
        ): BookmakerMarketQuote[] =>
          [-0.02, 0, 0.02].map((offset, index) => {
            const adjusted = Math.max(0.02, Math.min(0.98, probability + offset));
            return {
              key: `mock-${index + 1}`,
              title: `MockBook ${index + 1}`,
              decimalOdds: 1 / adjusted,
              probability: adjusted,
            };
          });
        return [
          playerMarketOddsKey(player),
          PlayerMarketOddsSchema.parse({
            source: 'mock',
            capturedAt,
            goal: {
              probability: goalProbability,
              bookmakerCount: 3,
              bookmakerQuotes: mockQuotes(goalProbability),
            },
            assist: {
              probability: assistProbability,
              bookmakerCount: 3,
              bookmakerQuotes: mockQuotes(assistProbability),
            },
            decisive: {
              probability: decisiveProbability,
              bookmakerCount: 3,
              bookmakerQuotes: mockQuotes(decisiveProbability),
            },
          }),
        ];
      }),
    );
  }
}

const OddsEventSchema = z.object({
  id: z.string().min(1),
  commence_time: z.string().datetime(),
  home_team: z.string().min(1),
  away_team: z.string().min(1),
});

const OddsEventsSchema = z.array(OddsEventSchema);
type OddsEvent = z.infer<typeof OddsEventSchema>;

const OddsOutcomeSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  price: z.number().finite().gt(1),
  point: z.number().finite().optional(),
});

const OddsMarketSchema = z.object({
  key: z.string().min(1),
  last_update: z.string().datetime().optional(),
  outcomes: z.array(OddsOutcomeSchema),
});

const EventOddsSchema = OddsEventSchema.extend({
  bookmakers: z.array(
    z.object({
      key: z.string().min(1),
      title: z.string().min(1),
      markets: z.array(OddsMarketSchema),
    }),
  ),
});

type EventOdds = z.infer<typeof EventOddsSchema>;
type OddsOutcome = z.infer<typeof OddsOutcomeSchema>;

export interface FixtureGroup {
  key: string;
  date: string;
  homeTeamName: string;
  awayTeamName: string;
  players: PlayerStats[];
}

interface TheOddsApiOptions {
  apiKey: string;
  baseUrl: string;
  sportKey: string;
  region: string;
  fallbackRegion?: string;
  fetchWindowMs: number;
  requestTimeoutMs: number;
  maxRetries: number;
  store: MarketSnapshotStore;
  logger: AppLogger;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

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

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const teamAliases: Readonly<Record<string, string>> = {
  atlanta: 'atlanta united',
  'atlanta united': 'atlanta united',
  austin: 'austin',
  charlotte: 'charlotte',
  chicago: 'chicago fire',
  'chicago fire': 'chicago fire',
  cincinnati: 'cincinnati',
  colorado: 'colorado rapids',
  'colorado rapids': 'colorado rapids',
  columbus: 'columbus crew',
  'columbus crew': 'columbus crew',
  'd c united': 'dc united',
  'dc united': 'dc united',
  dallas: 'dallas',
  houston: 'houston dynamo',
  'houston dynamo': 'houston dynamo',
  'inter miami': 'inter miami',
  'la galaxy': 'la galaxy',
  'los angeles galaxy': 'la galaxy',
  lafc: 'lafc',
  'los angeles': 'lafc',
  minnesota: 'minnesota united',
  'minnesota united': 'minnesota united',
  montreal: 'montreal',
  'montreal impact': 'montreal',
  nashville: 'nashville',
  'new england': 'new england revolution',
  'new england revolution': 'new england revolution',
  nycfc: 'new york city',
  'new york city': 'new york city',
  'new york rb': 'new york red bulls',
  'new york red bulls': 'new york red bulls',
  'red bull new york': 'new york red bulls',
  orlando: 'orlando city',
  'orlando city': 'orlando city',
  philadelphia: 'philadelphia union',
  'philadelphia union': 'philadelphia union',
  portland: 'portland timbers',
  'portland timbers': 'portland timbers',
  'real salt lake': 'real salt lake',
  'salt lake': 'real salt lake',
  'san diego': 'san diego',
  'san jose': 'san jose earthquakes',
  'sj earthquakes': 'san jose earthquakes',
  'san jose earthquakes': 'san jose earthquakes',
  seattle: 'seattle sounders',
  'seattle sounders': 'seattle sounders',
  'sporting kansas city': 'sporting kansas city',
  'sporting kc': 'sporting kansas city',
  'st louis city': 'st louis city',
  toronto: 'toronto',
  vancouver: 'vancouver whitecaps',
  'vancouver whitecaps': 'vancouver whitecaps',
};

function normalizeWords(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalizeTeamName(value: string): string {
  const withoutClubSuffix = normalizeWords(value)
    .split(' ')
    .filter((part) => !['fc', 'cf', 'sc'].includes(part))
    .join(' ');
  return teamAliases[withoutClubSuffix] ?? withoutClubSuffix;
}

export function normalizePlayerName(value: string): string {
  const parts = normalizeWords(value).split(' ');
  while (
    parts.length > 1 &&
    ['jr', 'sr', 'ii', 'iii', 'iv'].includes(parts[parts.length - 1] ?? '')
  ) {
    parts.pop();
  }
  return parts.join(' ');
}

export function marketFixtureKey(
  nextGame: NonNullable<PlayerStats['nextGame']>,
): string | null {
  if (!nextGame.homeTeamName || !nextGame.awayTeamName) return null;
  const kickoff = Date.parse(nextGame.date);
  if (!Number.isFinite(kickoff)) return null;
  return [
    new Date(kickoff).toISOString(),
    normalizeTeamName(nextGame.homeTeamName),
    normalizeTeamName(nextGame.awayTeamName),
  ].join('|');
}

export function groupFixtures(players: readonly PlayerStats[]): FixtureGroup[] {
  const groups = new Map<string, FixtureGroup>();
  for (const player of players) {
    if (player.position === 'Goalkeeper' || !player.nextGame) continue;
    const fixtureTeams = new Set(
      [player.nextGame.homeTeamName, player.nextGame.awayTeamName]
        .filter((team): team is string => Boolean(team))
        .map(normalizeTeamName),
    );
    const playerTeam = player.nextGame.playerTeamName
      ? normalizeTeamName(player.nextGame.playerTeamName)
      : null;
    const opponentTeam = player.nextGame.opponentTeamName
      ? normalizeTeamName(player.nextGame.opponentTeamName)
      : null;
    if (
      (playerTeam && !fixtureTeams.has(playerTeam)) ||
      (opponentTeam && !fixtureTeams.has(opponentTeam)) ||
      (playerTeam && opponentTeam && playerTeam === opponentTeam)
    ) {
      continue;
    }
    const key = marketFixtureKey(player.nextGame);
    if (
      !key ||
      !player.nextGame.homeTeamName ||
      !player.nextGame.awayTeamName
    ) {
      continue;
    }
    const existing = groups.get(key);
    if (existing) {
      existing.players.push(player);
      continue;
    }
    groups.set(key, {
      key,
      date: player.nextGame.date,
      homeTeamName: player.nextGame.homeTeamName,
      awayTeamName: player.nextGame.awayTeamName,
      players: [player],
    });
  }
  return [...groups.values()];
}

function findEvent(fixture: FixtureGroup, events: readonly OddsEvent[]): OddsEvent | null {
  const home = normalizeTeamName(fixture.homeTeamName);
  const away = normalizeTeamName(fixture.awayTeamName);
  const kickoff = Date.parse(fixture.date);
  const candidates = events
    .filter(
      (event) =>
        normalizeTeamName(event.home_team) === home &&
        normalizeTeamName(event.away_team) === away,
    )
    .map((event) => ({
      event,
      difference: Math.abs(Date.parse(event.commence_time) - kickoff),
    }))
    .filter(({ difference }) => difference <= 36 * 60 * 60 * 1_000)
    .sort((left, right) => left.difference - right.difference);
  return candidates[0]?.event ?? null;
}

interface MarketOutcomeQuote {
  probability: number;
  decimalOdds: number;
}

function marketOutcomeQuote(
  market: OddsMarketKey,
  outcomes: readonly OddsOutcome[],
): MarketOutcomeQuote | null {
  const relevant = outcomes.filter((outcome) => {
    if (market !== 'player_assists') return true;
    return outcome.point === undefined || Math.abs(outcome.point - 0.5) < 0.001;
  });
  const positiveNames =
    market === 'player_assists' ? ['over', 'yes'] : ['yes', 'over'];
  const negativeNames =
    market === 'player_assists' ? ['under', 'no'] : ['no', 'under'];
  const positive = relevant.find((outcome) =>
    positiveNames.includes(normalizeWords(outcome.name)),
  );
  if (!positive) return null;
  const positiveImplied = 1 / positive.price;
  const negative = relevant.find((outcome) =>
    negativeNames.includes(normalizeWords(outcome.name)),
  );
  if (!negative) {
    return {
      probability: Math.min(1, positiveImplied),
      decimalOdds: positive.price,
    };
  }
  const negativeImplied = 1 / negative.price;
  return {
    probability: positiveImplied / (positiveImplied + negativeImplied),
    decimalOdds: positive.price,
  };
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[middle] ?? 0;
  return ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2;
}

function extractMarketSnapshot(
  response: EventOdds,
  market: OddsMarketKey,
  capturedAt: string,
): FrozenMarketSnapshot | null {
  const probabilities = new Map<string, BookmakerMarketQuote[]>();
  for (const bookmaker of response.bookmakers) {
    const bookmakerMarket = bookmaker.markets.find(
      (candidate) => candidate.key === market,
    );
    if (!bookmakerMarket) continue;
    const byPlayer = new Map<string, OddsOutcome[]>();
    for (const outcome of bookmakerMarket.outcomes) {
      if (!outcome.description) continue;
      const playerName = normalizePlayerName(outcome.description);
      if (!playerName) continue;
      const playerOutcomes = byPlayer.get(playerName) ?? [];
      playerOutcomes.push(outcome);
      byPlayer.set(playerName, playerOutcomes);
    }
    for (const [playerName, outcomes] of byPlayer) {
      const quote = marketOutcomeQuote(market, outcomes);
      if (quote === null) continue;
      const playerProbabilities = probabilities.get(playerName) ?? [];
      playerProbabilities.push({
        key: bookmaker.key,
        title: bookmaker.title,
        decimalOdds: quote.decimalOdds,
        probability: quote.probability,
      });
      probabilities.set(playerName, playerProbabilities);
    }
  }

  if (probabilities.size === 0) return null;
  return FrozenMarketSnapshotSchema.parse({
    status: 'available',
    market,
    eventId: response.id,
    capturedAt,
    players: Object.fromEntries(
      [...probabilities].map(([playerName, quotes]) => [
        playerName,
        {
          probability: median(quotes.map(({ probability }) => probability)),
          bookmakerCount: quotes.length,
          bookmakerQuotes: [...quotes].sort((left, right) =>
            left.title.localeCompare(right.title),
          ),
        },
      ]),
    ),
  });
}

export function playerProbability(
  snapshot: FrozenMarketSnapshot | undefined,
  player: PlayerStats,
  fixturePlayers: readonly PlayerStats[],
): MarketProbability | null {
  if (!snapshot) return null;
  const marketCandidates = Object.entries(snapshot.players)
    .map(([marketName, probability]) => ({
      marketName,
      probability,
      score: playerNameMatchScore(player.displayName, marketName),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score);
  const selected = marketCandidates[0];
  if (
    !selected ||
    marketCandidates.filter(({ score }) => score === selected.score).length !== 1
  ) {
    return null;
  }

  const logicalPlayers = [
    ...new Map(
      fixturePlayers.map((candidate) => [candidate.slug, candidate]),
    ).values(),
  ];
  const rosterCandidates = logicalPlayers
    .map((candidate) => ({
      slug: candidate.slug,
      score: playerNameMatchScore(candidate.displayName, selected.marketName),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score);
  const bestRoster = rosterCandidates[0];
  if (
    !bestRoster ||
    bestRoster.slug !== player.slug ||
    rosterCandidates.filter(({ score }) => score === bestRoster.score).length !==
      1
  ) {
    return null;
  }
  return selected.probability;
}

export function needsFrozenSnapshotSupplement(
  snapshot: MarketSnapshot | undefined,
  fixturePlayers: readonly PlayerStats[],
  fixtureDate: string,
  now: number,
): boolean {
  if (snapshot?.status !== 'available') return false;
  if (
    !snapshot.supplementedAt &&
    Object.values(snapshot.players).some(
      ({ bookmakerQuotes }) => !bookmakerQuotes?.length,
    )
  ) {
    return true;
  }
  return fixturePlayers.some(
    (player) => {
      if (playerProbability(snapshot, player, fixturePlayers) !== null) {
        return false;
      }
      const check =
        snapshot.missingPlayerChecks?.[playerMarketOddsKey(player)];
      return (
        !check ||
        shouldRetryMarketFailure(check, Date.parse(fixtureDate), now)
      );
    },
  );
}

export function supplementFrozenSnapshot(
  existing: FrozenMarketSnapshot | undefined,
  incoming: FrozenMarketSnapshot,
  fixturePlayers: readonly PlayerStats[],
  fixtureDate: string,
): FrozenMarketSnapshot {
  const players = { ...(existing?.players ?? {}) };
  for (const [playerName, probability] of Object.entries(incoming.players)) {
    const frozen = players[playerName];
    players[playerName] = frozen
      ? {
          ...frozen,
          ...(!frozen.bookmakerQuotes?.length &&
          probability.bookmakerQuotes?.length
            ? { bookmakerQuotes: probability.bookmakerQuotes }
            : {}),
        }
      : probability;
  }
  const supplemented = FrozenMarketSnapshotSchema.parse({
    ...(existing ?? incoming),
    ...(existing ? { supplementedAt: incoming.capturedAt } : {}),
    players,
  });
  const missingPlayerChecks = {
    ...(existing?.missingPlayerChecks ?? {}),
  };
  for (const player of fixturePlayers) {
    const key = playerMarketOddsKey(player);
    if (playerProbability(supplemented, player, fixturePlayers) === null) {
      missingPlayerChecks[key] = nextMarketRetryState(
        missingPlayerChecks[key],
        Date.parse(incoming.capturedAt),
        Date.parse(fixtureDate),
      );
    } else {
      delete missingPlayerChecks[key];
    }
  }
  return FrozenMarketSnapshotSchema.parse({
    ...supplemented,
    missingPlayerChecks:
      Object.keys(missingPlayerChecks).length > 0
        ? missingPlayerChecks
        : undefined,
  });
}

export function recordFrozenSnapshotCheck(
  existing: FrozenMarketSnapshot,
  fixturePlayers: readonly PlayerStats[],
  fixtureDate: string,
  checkedAt: number,
): FrozenMarketSnapshot {
  const missingPlayerChecks = {
    ...(existing.missingPlayerChecks ?? {}),
  };
  for (const player of fixturePlayers) {
    const key = playerMarketOddsKey(player);
    if (playerProbability(existing, player, fixturePlayers) === null) {
      missingPlayerChecks[key] = nextMarketRetryState(
        missingPlayerChecks[key],
        checkedAt,
        Date.parse(fixtureDate),
      );
    } else {
      delete missingPlayerChecks[key];
    }
  }
  return FrozenMarketSnapshotSchema.parse({
    ...existing,
    supplementedAt:
      existing.supplementedAt ?? new Date(checkedAt).toISOString(),
    missingPlayerChecks:
      Object.keys(missingPlayerChecks).length > 0
        ? missingPlayerChecks
        : undefined,
  });
}

const firstMarketRetryDelayMs = 12 * 60 * 60 * 1_000;
const laterMarketRetryDelayMs = 24 * 60 * 60 * 1_000;
const finalMarketRetryLeadMs = 4 * 60 * 60 * 1_000;
const missingMarketRetentionMs = 24 * 60 * 60 * 1_000;

type MarketRetryState = z.infer<typeof MarketRetryStateSchema>;
type MissingPlayerCheck = z.infer<typeof MissingPlayerCheckSchema>;

function retryAttemptCount(
  previous: MissingPlayerCheck | MarketSnapshot | undefined,
): number {
  if (!previous) return 0;
  if (typeof previous === 'string') return 1;
  if ('status' in previous) {
    if (previous.status === 'available') return 0;
    return previous.attemptCount ?? 1;
  }
  return previous.attemptCount;
}

function nextMarketRetryState(
  previous: MissingPlayerCheck | MarketSnapshot | undefined,
  checkedAt: number,
  kickoff: number,
): MarketRetryState {
  const attemptCount = retryAttemptCount(previous) + 1;
  const finalRetryAt = kickoff - finalMarketRetryLeadMs;
  let nextRetryAt: number | null = null;
  if (checkedAt < finalRetryAt) {
    const delay =
      attemptCount === 1
        ? firstMarketRetryDelayMs
        : laterMarketRetryDelayMs;
    nextRetryAt = Math.min(checkedAt + delay, finalRetryAt);
    if (nextRetryAt <= checkedAt) nextRetryAt = null;
  }
  return MarketRetryStateSchema.parse({
    checkedAt: new Date(checkedAt).toISOString(),
    attemptCount,
    nextRetryAt:
      nextRetryAt === null ? null : new Date(nextRetryAt).toISOString(),
  });
}

export function shouldRetryMarketFailure(
  failure: MissingPlayerCheck | MarketSnapshot,
  kickoff: number,
  now: number,
): boolean {
  if (now >= kickoff) return false;
  if (typeof failure === 'string') {
    return Date.parse(failure) + firstMarketRetryDelayMs <= now;
  }
  if ('status' in failure) {
    if (failure.status === 'available') return false;
    if (failure.nextRetryAt === null) return false;
    if (failure.nextRetryAt === undefined) {
      return Date.parse(failure.checkedAt) + firstMarketRetryDelayMs <= now;
    }
    return Date.parse(failure.nextRetryAt) <= now;
  }
  if (failure.nextRetryAt === null) return false;
  return Date.parse(failure.nextRetryAt) <= now;
}

export function missingMarketSnapshot(
  fixture: FixtureGroup,
  market: OddsMarketKey,
  previous: MarketSnapshot | undefined,
  checkedAt: number,
): MarketSnapshot {
  const kickoff = Date.parse(fixture.date);
  const retry = nextMarketRetryState(previous, checkedAt, kickoff);
  return MissingMarketSnapshotSchema.parse({
    status: 'unavailable',
    market,
    ...retry,
    expiresAt: new Date(kickoff + missingMarketRetentionMs).toISOString(),
  });
}

const canonicalGivenNames: Readonly<Record<string, string>> = {
  nick: 'nicolas',
  nicholas: 'nicolas',
  nicolas: 'nicolas',
};

function canonicalGivenName(value: string | undefined): string {
  if (!value) return '';
  return canonicalGivenNames[value] ?? value;
}

export function playerNameMatchScore(
  sorareDisplayName: string,
  oddsName: string,
): number {
  const sorare = normalizePlayerName(sorareDisplayName).split(' ');
  const odds = normalizePlayerName(oddsName).split(' ');
  if (sorare.join(' ') === odds.join(' ')) return 100;
  // Some feeds use the Korean family-name-first order (`Son Heung Min`)
  // while Sorare displays the same person as `Heung-min Son`. Matching an
  // identical token multiset is safe here because `playerProbability` still
  // requires a unique best match across every player in the fixture.
  if (
    sorare.length === odds.length &&
    [...sorare].sort().join(' ') === [...odds].sort().join(' ')
  ) {
    return 95;
  }

  const sorareFirst = canonicalGivenName(sorare[0]);
  const oddsFirst = canonicalGivenName(odds[0]);
  const sorareFamily = new Set(sorare.slice(1));
  const oddsFamily = new Set(odds.slice(1));
  const sharedFamilyNames = [...sorareFamily].filter((part) =>
    oddsFamily.has(part),
  ).length;
  if (
    sorareFirst &&
    sorareFirst === oddsFirst &&
    sharedFamilyNames > 0
  ) {
    return 80 + Math.min(9, sharedFamilyNames);
  }

  const sorareLast = sorare.at(-1);
  const oddsLast = odds.at(-1);
  if (
    sorareFirst &&
    oddsFirst &&
    sorareFirst[0] === oddsFirst[0] &&
    sorareLast &&
    sorareLast === oddsLast
  ) {
    return 50;
  }
  return 0;
}

function responseQuota(headers: Headers): Record<string, string | null> {
  return {
    last: headers.get('x-requests-last'),
    used: headers.get('x-requests-used'),
    remaining: headers.get('x-requests-remaining'),
  };
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

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  task: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const value = values[nextIndex];
        nextIndex += 1;
        if (value !== undefined) await task(value);
      }
    },
  );
  await Promise.all(workers);
}

export class TheOddsApiPlayerMarketOddsProvider
  implements PlayerMarketOddsProvider
{
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly options: TheOddsApiOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  async load(
    players: readonly PlayerStats[],
    loadOptions?: PlayerMarketOddsLoadOptions,
  ): Promise<Map<string, PlayerMarketOdds | null>> {
    const output = new Map<string, PlayerMarketOdds | null>(
      players.map((player) => [playerMarketOddsKey(player), null]),
    );
    const fixtures = groupFixtures(players);
    if (fixtures.length === 0) return output;

    const snapshots = new Map<string, Map<OddsMarketKey, MarketSnapshot>>();
    const fixturesNeedingApi: Array<{
      fixture: FixtureGroup;
      missingMarkets: OddsMarketKey[];
    }> = [];

    for (const fixture of fixtures) {
      const byMarket = new Map<OddsMarketKey, MarketSnapshot>();
      const loaded = await Promise.all(
        oddsMarketKeys.map(async (market) => ({
          market,
          snapshot: await this.options.store.get(fixture.key, market),
        })),
      );
      for (const { market, snapshot } of loaded) {
        if (snapshot) byMarket.set(market, snapshot);
      }
      snapshots.set(fixture.key, byMarket);

      const kickoff = Date.parse(fixture.date);
      const millisecondsUntilKickoff = kickoff - this.now();
      const insideFetchWindow =
        millisecondsUntilKickoff <= this.options.fetchWindowMs &&
        millisecondsUntilKickoff >= 0;
      if (!insideFetchWindow) continue;
      const missingMarkets = oddsMarketKeys.filter(
        (market) => {
          const snapshot = byMarket.get(market);
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
        },
      );
      if (!loadOptions?.cacheOnly && missingMarkets.length > 0) {
        fixturesNeedingApi.push({ fixture, missingMarkets });
      }
    }

    if (fixturesNeedingApi.length > 0) {
      let events: OddsEvent[] = [];
      let eventsLoaded = false;
      try {
        events = OddsEventsSchema.parse(
          (
            await this.requestJson(
              `/sports/${encodeURIComponent(this.options.sportKey)}/events`,
              {},
            )
          ).body,
        );
        eventsLoaded = true;
      } catch (error) {
        this.options.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'The Odds API event lookup failed; returning stats without market odds',
        );
      }

      if (eventsLoaded) {
        await mapWithConcurrency(fixturesNeedingApi, 4, async (pending) => {
          const event = findEvent(pending.fixture, events);
          if (!event) {
            const unavailableMarkets = pending.missingMarkets.filter(
              (market) =>
                snapshots.get(pending.fixture.key)?.get(market)?.status !==
                'available',
            );
            await this.storeMissing(pending.fixture, unavailableMarkets);
            return;
          }
          await this.fetchFixtureMarkets(
            pending.fixture,
            event,
            pending.missingMarkets,
            snapshots.get(pending.fixture.key) ??
              new Map<OddsMarketKey, MarketSnapshot>(),
          );
        });
      }
    }

    for (const fixture of fixtures) {
      const byMarket = snapshots.get(fixture.key);
      const goalSnapshot = byMarket?.get('player_goal_scorer_anytime');
      const assistSnapshot = byMarket?.get('player_assists');
      for (const player of fixture.players) {
        const goal =
          goalSnapshot?.status === 'available'
            ? playerProbability(goalSnapshot, player, fixture.players)
            : null;
        const assist =
          assistSnapshot?.status === 'available'
            ? playerProbability(assistSnapshot, player, fixture.players)
            : null;
        if (!goal && !assist) continue;
        const capturedAt = [
          goalSnapshot?.status === 'available'
            ? goalSnapshot.capturedAt
            : null,
          assistSnapshot?.status === 'available'
            ? assistSnapshot.capturedAt
            : null,
        ]
          .filter((value): value is string => value !== null)
          .sort()
          .at(-1);
        if (!capturedAt) continue;
        output.set(
          playerMarketOddsKey(player),
          PlayerMarketOddsSchema.parse({
            source: 'the-odds-api',
            capturedAt,
            goal,
            assist,
          }),
        );
      }
    }
    return output;
  }

  private async fetchFixtureMarkets(
    fixture: FixtureGroup,
    event: OddsEvent,
    markets: OddsMarketKey[],
    snapshots: Map<OddsMarketKey, MarketSnapshot>,
  ): Promise<void> {
    try {
      const response = await this.requestJson(
        `/sports/${encodeURIComponent(
          this.options.sportKey,
        )}/events/${encodeURIComponent(event.id)}/odds`,
        {
          regions: this.options.region,
          markets: markets.join(','),
          oddsFormat: 'decimal',
        },
      );
      this.options.logger.info(
        {
          fixture: fixture.key,
          markets,
          quota: responseQuota(response.headers),
        },
        'The Odds API market snapshot received',
      );
      const parsed = EventOddsSchema.parse(response.body);
      const capturedAt = new Date(this.now()).toISOString();
      for (const market of markets) {
        const extracted = extractMarketSnapshot(parsed, market, capturedAt);
        const existing = snapshots.get(market);
        if (!extracted && existing?.status === 'available') {
          const checked = recordFrozenSnapshotCheck(
            existing,
            fixture.players,
            fixture.date,
            Date.parse(capturedAt),
          );
          await this.options.store.set(fixture.key, checked);
          snapshots.set(market, checked);
          continue;
        }
        const snapshot =
          extracted
            ? supplementFrozenSnapshot(
                existing?.status === 'available' ? existing : undefined,
                extracted,
                fixture.players,
                fixture.date,
              )
            :
          missingMarketSnapshot(
            fixture,
            market,
            existing,
            Date.parse(capturedAt),
          );
        await this.options.store.set(fixture.key, snapshot);
        snapshots.set(market, snapshot);
      }
      await this.fetchFallbackFixtureMarkets(
        fixture,
        event,
        markets,
        snapshots,
      );
    } catch (error) {
      if (
        error instanceof OddsApiHttpError &&
        error.status === 422 &&
        markets.length > 1
      ) {
        this.options.logger.info(
          { fixture: fixture.key, markets },
          'Combined player-prop request unsupported; requesting markets separately',
        );
        await mapWithConcurrency(markets, 2, async (market) => {
          await this.fetchSingleFixtureMarket(
            fixture,
            event,
            market,
            snapshots,
          );
        });
        return;
      }
      this.options.logger.warn(
        {
          fixture: fixture.key,
          markets,
          error: error instanceof Error ? error.message : String(error),
        },
        'The Odds API market request failed; returning stats without new market odds',
      );
    }
  }

  private marketsNeedingFallback(
    fixture: FixtureGroup,
    markets: readonly OddsMarketKey[],
    snapshots: Map<OddsMarketKey, MarketSnapshot>,
  ): OddsMarketKey[] {
    const fallbackRegion = this.options.fallbackRegion?.trim();
    if (
      !fallbackRegion ||
      fallbackRegion.toLocaleLowerCase() ===
        this.options.region.trim().toLocaleLowerCase()
    ) {
      return [];
    }
    return markets.filter((market) => {
      const snapshot = snapshots.get(market);
      return (
        snapshot?.status !== 'available' ||
        fixture.players.some(
          (player) =>
            playerProbability(snapshot, player, fixture.players) === null,
        )
      );
    });
  }

  private async fetchFallbackFixtureMarkets(
    fixture: FixtureGroup,
    event: OddsEvent,
    markets: readonly OddsMarketKey[],
    snapshots: Map<OddsMarketKey, MarketSnapshot>,
  ): Promise<void> {
    const fallbackRegion = this.options.fallbackRegion?.trim();
    const fallbackMarkets = this.marketsNeedingFallback(
      fixture,
      markets,
      snapshots,
    );
    if (!fallbackRegion || fallbackMarkets.length === 0) return;

    try {
      const response = await this.requestJson(
        `/sports/${encodeURIComponent(
          this.options.sportKey,
        )}/events/${encodeURIComponent(event.id)}/odds`,
        {
          regions: fallbackRegion,
          markets: fallbackMarkets.join(','),
          oddsFormat: 'decimal',
        },
      );
      this.options.logger.info(
        {
          fixture: fixture.key,
          markets: fallbackMarkets,
          primaryRegion: this.options.region,
          fallbackRegion,
          quota: responseQuota(response.headers),
        },
        'The Odds API fallback market snapshot received',
      );
      await this.mergeFallbackMarketResponse(
        fixture,
        fallbackMarkets,
        snapshots,
        response.body,
      );
    } catch (error) {
      if (
        error instanceof OddsApiHttpError &&
        error.status === 422 &&
        fallbackMarkets.length > 1
      ) {
        await mapWithConcurrency(fallbackMarkets, 2, async (market) => {
          await this.fetchSingleFallbackFixtureMarket(
            fixture,
            event,
            market,
            snapshots,
            fallbackRegion,
          );
        });
        return;
      }
      this.options.logger.warn(
        {
          fixture: fixture.key,
          markets: fallbackMarkets,
          fallbackRegion,
          error: error instanceof Error ? error.message : String(error),
        },
        'The Odds API fallback market request failed; keeping primary-region odds',
      );
    }
  }

  private async fetchSingleFallbackFixtureMarket(
    fixture: FixtureGroup,
    event: OddsEvent,
    market: OddsMarketKey,
    snapshots: Map<OddsMarketKey, MarketSnapshot>,
    fallbackRegion: string,
  ): Promise<void> {
    try {
      const response = await this.requestJson(
        `/sports/${encodeURIComponent(
          this.options.sportKey,
        )}/events/${encodeURIComponent(event.id)}/odds`,
        {
          regions: fallbackRegion,
          markets: market,
          oddsFormat: 'decimal',
        },
      );
      this.options.logger.info(
        {
          fixture: fixture.key,
          markets: [market],
          primaryRegion: this.options.region,
          fallbackRegion,
          quota: responseQuota(response.headers),
        },
        'The Odds API fallback market snapshot received',
      );
      await this.mergeFallbackMarketResponse(
        fixture,
        [market],
        snapshots,
        response.body,
      );
    } catch (error) {
      this.options.logger.warn(
        {
          fixture: fixture.key,
          markets: [market],
          fallbackRegion,
          error: error instanceof Error ? error.message : String(error),
        },
        'The Odds API fallback market request failed; keeping primary-region odds',
      );
    }
  }

  private async mergeFallbackMarketResponse(
    fixture: FixtureGroup,
    markets: readonly OddsMarketKey[],
    snapshots: Map<OddsMarketKey, MarketSnapshot>,
    responseBody: unknown,
  ): Promise<void> {
    const parsed = EventOddsSchema.parse(responseBody);
    const capturedAt = new Date(this.now()).toISOString();
    for (const market of markets) {
      const extracted = extractMarketSnapshot(parsed, market, capturedAt);
      if (!extracted) continue;
      const existing = snapshots.get(market);
      const existingAvailable =
        existing?.status === 'available' ? existing : undefined;
      const supplemented = supplementFrozenSnapshot(
        existingAvailable,
        extracted,
        fixture.players,
        fixture.date,
      );
      const resolvedRequestedPlayer = fixture.players.some(
        (player) =>
          (!existingAvailable ||
            playerProbability(
              existingAvailable,
              player,
              fixture.players,
            ) === null) &&
          playerProbability(supplemented, player, fixture.players) !== null,
      );
      const addedUsefulFallbackData =
        !existingAvailable ||
        Object.entries(supplemented.players).some(([playerName, probability]) => {
          const previous = existingAvailable.players[playerName];
          return (
            !previous ||
            (!previous.bookmakerQuotes?.length &&
              Boolean(probability.bookmakerQuotes?.length))
          );
        });
      if (!resolvedRequestedPlayer && !addedUsefulFallbackData) continue;
      await this.options.store.set(fixture.key, supplemented);
      snapshots.set(market, supplemented);
    }
  }

  private async fetchSingleFixtureMarket(
    fixture: FixtureGroup,
    event: OddsEvent,
    market: OddsMarketKey,
    snapshots: Map<OddsMarketKey, MarketSnapshot>,
  ): Promise<void> {
    try {
      const response = await this.requestJson(
        `/sports/${encodeURIComponent(
          this.options.sportKey,
        )}/events/${encodeURIComponent(event.id)}/odds`,
        {
          regions: this.options.region,
          markets: market,
          oddsFormat: 'decimal',
        },
      );
      this.options.logger.info(
        {
          fixture: fixture.key,
          markets: [market],
          quota: responseQuota(response.headers),
        },
        'The Odds API market snapshot received',
      );
      const capturedAt = new Date(this.now()).toISOString();
      const extracted = extractMarketSnapshot(
        EventOddsSchema.parse(response.body),
        market,
        capturedAt,
      );
      const existing = snapshots.get(market);
      if (!extracted && existing?.status === 'available') {
        const checked = recordFrozenSnapshotCheck(
          existing,
          fixture.players,
          fixture.date,
          Date.parse(capturedAt),
        );
        await this.options.store.set(fixture.key, checked);
        snapshots.set(market, checked);
        await this.fetchFallbackFixtureMarkets(
          fixture,
          event,
          [market],
          snapshots,
        );
        return;
      }
      const snapshot =
        extracted
          ? supplementFrozenSnapshot(
              existing?.status === 'available' ? existing : undefined,
              extracted,
              fixture.players,
              fixture.date,
            )
          :
        missingMarketSnapshot(
          fixture,
          market,
          existing,
          Date.parse(capturedAt),
        );
      await this.options.store.set(fixture.key, snapshot);
      snapshots.set(market, snapshot);
      await this.fetchFallbackFixtureMarkets(
        fixture,
        event,
        [market],
        snapshots,
      );
    } catch (error) {
      if (error instanceof OddsApiHttpError && error.status === 422) {
        const existing = snapshots.get(market);
        if (existing?.status === 'available') {
          const checked = recordFrozenSnapshotCheck(
            existing,
            fixture.players,
            fixture.date,
            this.now(),
          );
          await this.options.store.set(fixture.key, checked);
          snapshots.set(market, checked);
          await this.fetchFallbackFixtureMarkets(
            fixture,
            event,
            [market],
            snapshots,
          );
          return;
        }
        const snapshot = missingMarketSnapshot(
          fixture,
          market,
          existing,
          this.now(),
        );
        await this.options.store.set(fixture.key, snapshot);
        snapshots.set(market, snapshot);
        await this.fetchFallbackFixtureMarkets(
          fixture,
          event,
          [market],
          snapshots,
        );
        return;
      }
      this.options.logger.warn(
        {
          fixture: fixture.key,
          markets: [market],
          error: error instanceof Error ? error.message : String(error),
        },
        'The Odds API market request failed; returning stats without new market odds',
      );
    }
  }

  private async storeMissing(
    fixture: FixtureGroup,
    markets: readonly OddsMarketKey[],
  ): Promise<void> {
    const checkedAt = this.now();
    await Promise.all(
      markets.map(async (market) => {
        const previous = await this.options.store.get(fixture.key, market);
        await this.options.store.set(
          fixture.key,
          missingMarketSnapshot(fixture, market, previous, checkedAt),
        );
      }),
    );
  }

  private async requestJson(
    path: string,
    query: Readonly<Record<string, string>>,
  ): Promise<JsonResponse> {
    const url = new URL(
      `${this.options.baseUrl.replace(/\/$/, '')}${path}`,
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
        const retryable =
          response.status === 429 || [502, 503, 504].includes(response.status);
        if (retryable && attempt < this.options.maxRetries) {
          const waitMs = retryDelayMs(
            response.headers.get('retry-after'),
            attempt,
          );
          this.options.logger.warn(
            { attempt: attempt + 1, status: response.status, waitMs },
            'The Odds API temporarily unavailable; retrying',
          );
          await response.body?.cancel();
          await this.sleep(waitMs);
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new OddsApiHttpError(response.status);
        }
        return { body: await response.json(), headers: response.headers };
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
    throw new Error('The Odds API retry budget exhausted');
  }
}
