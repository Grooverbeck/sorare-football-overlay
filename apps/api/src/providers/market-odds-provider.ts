import {
  FootballPositionSchema,
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
  providerProtection,
  protectionForUsage,
  quotaUsage,
  type OddsUsageProtection,
  type ProviderQuotaUsage,
  type ProviderQuotaUsageStore,
} from './odds-usage.js';

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

export const FrozenMarketSnapshotSchema = z.object({
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
  // Providers that bill per returned event can target a later supplement by
  // ID even when the requested market was not listed on the first response.
  eventId: z.string().min(1).optional(),
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

export const MarketSupplementPlayerSchema = z.object({
  slug: z.string().trim().min(1).max(160),
  displayName: z.string().trim().min(1).max(200),
  position: FootballPositionSchema,
});

export const MarketSupplementBatchSchema = z.object({
  queuedAt: z.string().datetime(),
  readyAt: z.string().datetime(),
  players: z.array(MarketSupplementPlayerSchema),
});

export type MarketSupplementPlayer = z.infer<
  typeof MarketSupplementPlayerSchema
>;
export type MarketSupplementBatch = z.infer<
  typeof MarketSupplementBatchSchema
>;

export interface MarketSnapshotRead {
  fixtureKey: string;
  market: OddsMarketKey;
}

export interface MarketSnapshotStore {
  get(fixtureKey: string, market: OddsMarketKey): Promise<MarketSnapshot | undefined>;
  getMany?(
    requests: readonly MarketSnapshotRead[],
  ): Promise<Array<MarketSnapshot | undefined>>;
  set(fixtureKey: string, snapshot: MarketSnapshot): void | Promise<void>;
  claimRefreshLease?(
    fixtureKey: string,
    requestGroup: string,
    ttlMs: number,
  ): Promise<boolean>;
  releaseRefreshLease?(
    fixtureKey: string,
    requestGroup: string,
  ): Promise<void>;
  enqueueSupplementPlayers?(
    fixtureKey: string,
    requestGroup: string,
    players: readonly MarketSupplementPlayer[],
    delayMs: number,
    ttlMs: number,
  ): Promise<MarketSupplementBatch>;
  getSupplementBatch?(
    fixtureKey: string,
    requestGroup: string,
  ): Promise<MarketSupplementBatch | undefined>;
  clearSupplementBatch?(
    fixtureKey: string,
    requestGroup: string,
  ): Promise<void>;
}

interface MemoryEntry {
  snapshot: MarketSnapshot;
  expiresAt: number | null;
}

export function mergeSupplementBatch(
  existing: MarketSupplementBatch | undefined,
  players: readonly MarketSupplementPlayer[],
  now: number,
  delayMs: number,
): MarketSupplementBatch {
  const mergedPlayers = new Map<string, MarketSupplementPlayer>();
  for (const player of [...(existing?.players ?? []), ...players]) {
    mergedPlayers.set(playerMarketOddsKey(player), player);
  }
  return MarketSupplementBatchSchema.parse({
    queuedAt: existing?.queuedAt ?? new Date(now).toISOString(),
    readyAt:
      existing?.readyAt ?? new Date(now + Math.max(0, delayMs)).toISOString(),
    players: [...mergedPlayers.values()],
  });
}

export class InMemoryMarketSnapshotStore implements MarketSnapshotStore {
  private readonly entries = new Map<string, MemoryEntry>();
  private readonly refreshLeases = new Map<string, number>();
  private readonly supplementBatches = new Map<
    string,
    { batch: MarketSupplementBatch; expiresAt: number }
  >();

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

  getMany(
    requests: readonly MarketSnapshotRead[],
  ): Promise<Array<MarketSnapshot | undefined>> {
    return Promise.all(
      requests.map(({ fixtureKey, market }) => this.get(fixtureKey, market)),
    );
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

  async claimRefreshLease(
    fixtureKey: string,
    requestGroup: string,
    ttlMs: number,
  ): Promise<boolean> {
    const key = this.coordinationKey(fixtureKey, requestGroup);
    const expiresAt = this.refreshLeases.get(key);
    if (expiresAt !== undefined && expiresAt > this.now()) return false;
    this.refreshLeases.set(key, this.now() + ttlMs);
    return true;
  }

  async releaseRefreshLease(
    fixtureKey: string,
    requestGroup: string,
  ): Promise<void> {
    this.refreshLeases.delete(
      this.coordinationKey(fixtureKey, requestGroup),
    );
  }

  async enqueueSupplementPlayers(
    fixtureKey: string,
    requestGroup: string,
    players: readonly MarketSupplementPlayer[],
    delayMs: number,
    ttlMs: number,
  ): Promise<MarketSupplementBatch> {
    const key = this.coordinationKey(fixtureKey, requestGroup);
    const existing = this.supplementBatches.get(key);
    const active =
      existing !== undefined && existing.expiresAt > this.now()
        ? existing.batch
        : undefined;
    const batch = mergeSupplementBatch(active, players, this.now(), delayMs);
    this.supplementBatches.set(key, {
      batch,
      expiresAt: this.now() + ttlMs,
    });
    return batch;
  }

  async getSupplementBatch(
    fixtureKey: string,
    requestGroup: string,
  ): Promise<MarketSupplementBatch | undefined> {
    const key = this.coordinationKey(fixtureKey, requestGroup);
    const entry = this.supplementBatches.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.supplementBatches.delete(key);
      return undefined;
    }
    return entry.batch;
  }

  async clearSupplementBatch(
    fixtureKey: string,
    requestGroup: string,
  ): Promise<void> {
    this.supplementBatches.delete(
      this.coordinationKey(fixtureKey, requestGroup),
    );
  }

  private key(fixtureKey: string, market: OddsMarketKey): string {
    return `${fixtureKey}:${market}`;
  }

  private coordinationKey(fixtureKey: string, requestGroup: string): string {
    return `${requestGroup}:${fixtureKey}`;
  }
}

export interface PlayerMarketOddsProvider {
  load(
    players: readonly PlayerStats[],
    options?: PlayerMarketOddsLoadOptions,
  ): Promise<Map<string, PlayerMarketOdds | null>>;
  supports?(player: PlayerStats): boolean;
  supportsMarket?(
    player: PlayerStats,
    market: PlayerMarketField,
  ): boolean;
  refreshUsage?(): Promise<ProviderQuotaUsage[]>;
}

export type PlayerMarketField = 'goal' | 'assist';

export interface PlayerMarketOddsLoadOptions {
  // Read immutable snapshots only. External bookmaker APIs must never be
  // contacted on the player-stats response path.
  cacheOnly?: boolean;
  // Internal wall-clock deadline shared by nested cache-only provider
  // compositions. Leaf providers may ignore it; composite providers use it
  // to return partial snapshots before their parent budget expires.
  cacheOnlyDeadlineMs?: number;
}

const defaultCacheOnlySnapshotReadBudgetMs = 100;

export function settleCacheReadWithin<T>(
  pending: Promise<T>,
  cacheOnly: boolean,
  timeoutMs = defaultCacheOnlySnapshotReadBudgetMs,
): Promise<T | undefined> {
  if (!cacheOnly) return pending;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: T | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => finish(undefined), Math.max(1, timeoutMs));
    void pending.then(
      (value) => finish(value),
      () => finish(undefined),
    );
  });
}

export function cacheOnlySnapshotReadBudgetMs(
  loadOptions?: PlayerMarketOddsLoadOptions,
): number | undefined {
  if (
    loadOptions?.cacheOnly !== true ||
    loadOptions.cacheOnlyDeadlineMs === undefined
  ) {
    return undefined;
  }
  return Math.max(1, loadOptions.cacheOnlyDeadlineMs - Date.now());
}

export async function readMarketSnapshotsWithin(
  store: MarketSnapshotStore,
  requests: readonly MarketSnapshotRead[],
  cacheOnly: boolean,
  timeoutMs?: number,
): Promise<Array<MarketSnapshot | undefined>> {
  if (requests.length === 0) return [];
  if (!store.getMany) {
    return Promise.all(
      requests.map(({ fixtureKey, market }) =>
        settleCacheReadWithin(
          store.get(fixtureKey, market),
          cacheOnly,
          timeoutMs,
        ),
      ),
    );
  }
  const pending = store.getMany(requests);
  const loaded = await settleCacheReadWithin(pending, cacheOnly, timeoutMs);
  return loaded ?? requests.map(() => undefined);
}

export function playerMarketOddsKey(
  player: Pick<PlayerStats, 'slug' | 'position'>,
): string {
  return `${player.slug}:${player.position}`;
}

export function playerMarketOddsSupported(
  provider: PlayerMarketOddsProvider,
  player: PlayerStats,
): boolean {
  return (
    provider.supports?.(player) ??
    (player.position !== 'Goalkeeper' && player.nextGame !== null)
  );
}

export function playerMarketFieldSupported(
  provider: PlayerMarketOddsProvider,
  player: PlayerStats,
  market: PlayerMarketField,
): boolean {
  return (
    provider.supportsMarket?.(player, market) ??
    playerMarketOddsSupported(provider, player)
  );
}

export class UnavailablePlayerMarketOddsProvider
  implements PlayerMarketOddsProvider
{
  supports(): boolean {
    return false;
  }

  supportsMarket(): boolean {
    return false;
  }

  async load(
    players: readonly PlayerStats[],
    _options?: PlayerMarketOddsLoadOptions,
  ): Promise<Map<string, PlayerMarketOdds | null>> {
    return new Map(players.map((player) => [playerMarketOddsKey(player), null]));
  }
}

export class MockPlayerMarketOddsProvider implements PlayerMarketOddsProvider {
  constructor(private readonly now: () => number = Date.now) {}

  supports(player: PlayerStats): boolean {
    return player.position !== 'Goalkeeper' && player.nextGame !== null;
  }

  supportsMarket(player: PlayerStats): boolean {
    return this.supports(player);
  }

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

export interface FixtureGroup<
  TPlayer extends MarketSupplementPlayer = PlayerStats,
> {
  key: string;
  date: string;
  homeTeamName: string;
  awayTeamName: string;
  players: TPlayer[];
}

interface TheOddsApiOptions {
  apiKey: string;
  baseUrl: string;
  sportKey: string;
  additionalSportKeys?: readonly string[];
  region: string;
  fallbackRegion?: string;
  fetchWindowMs: number;
  requestTimeoutMs: number;
  maxRetries: number;
  store: MarketSnapshotStore;
  logger: AppLogger;
  usageStore?: ProviderQuotaUsageStore;
  refreshUsage?: boolean;
  supportedCompetitionSlugs?: readonly string[];
  supportedMarkets?: readonly PlayerMarketField[];
  supplementBatchDelayMs?: number;
  supplementBatchTtlMs?: number;
  refreshLeaseTtlMs?: number;
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

const defaultSupplementBatchDelayMs = 0;
const defaultSupplementBatchTtlMs = 15 * 60 * 1_000;
const defaultRefreshLeaseTtlMs = 90 * 1_000;

const mlsTeamAliases: Readonly<Record<string, string>> = {
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

const ligaMxTeamAliases: Readonly<Record<string, string>> = {
  // Leagues Cup pairs MLS teams with Liga MX teams. Sorare, bookmakers and
  // English-language feeds frequently use different club prefixes or the
  // common Chivas/Rayados names for the same side.
  atlas: 'atlas',
  'club atlas': 'atlas',
  america: 'club america',
  'club america': 'club america',
  'atletico san luis': 'atletico san luis',
  'atletico de san luis': 'atletico san luis',
  'club atletico de san luis': 'atletico san luis',
  guadalajara: 'guadalajara',
  'club guadalajara': 'guadalajara',
  'cd guadalajara': 'guadalajara',
  chivas: 'guadalajara',
  'chivas guadalajara': 'guadalajara',
  'cruz azul': 'cruz azul',
  juarez: 'juarez',
  'club juarez': 'juarez',
  leon: 'leon',
  'club leon': 'leon',
  mazatlan: 'mazatlan',
  'club mazatlan': 'mazatlan',
  monterrey: 'monterrey',
  rayados: 'monterrey',
  'rayados monterrey': 'monterrey',
  necaxa: 'necaxa',
  'club necaxa': 'necaxa',
  pachuca: 'pachuca',
  'club pachuca': 'pachuca',
  puebla: 'puebla',
  'club puebla': 'puebla',
  pumas: 'pumas unam',
  unam: 'pumas unam',
  'pumas unam': 'pumas unam',
  'unam pumas': 'pumas unam',
  queretaro: 'queretaro',
  'club queretaro': 'queretaro',
  'santos laguna': 'santos laguna',
  tigres: 'tigres uanl',
  'tigres uanl': 'tigres uanl',
  tijuana: 'tijuana',
  'club tijuana': 'tijuana',
  xolos: 'tijuana',
  'xolos de tijuana': 'tijuana',
  toluca: 'toluca',
  'deportivo toluca': 'toluca',
  atlante: 'atlante',
  'club atlante': 'atlante',
};

const contenderTeamAliases: Readonly<Record<string, string>> = {
  // Austrian Bundesliga: Sorare generally uses club short names while the
  // bookmaker feed often includes sponsors or common prefixes.
  salzburg: 'salzburg',
  'rb salzburg': 'salzburg',
  wattens: 'wsg tirol',
  'wsg tirol': 'wsg tirol',
  lask: 'lask',
  'lask linz': 'lask',
  'grazer ak': 'grazer ak',
  'grazer ak 1902': 'grazer ak',
  'sturm graz': 'sturm graz',
  'sk sturm graz': 'sturm graz',
  'austria lustenau': 'austria lustenau',
  ried: 'ried',
  'sv ried': 'ried',
  wac: 'wolfsberger ac',
  'wolfsberger ac': 'wolfsberger ac',
  'austria wien': 'austria wien',
  'fk austria wien': 'austria wien',
  'rapid wien': 'rapid wien',
  'sk rapid': 'rapid wien',
  altach: 'altach',
  'scr altach': 'altach',
  hartberg: 'hartberg',
  'tsv hartberg': 'hartberg',

  // 2. Bundesliga: normalize the current Sorare short names and The Odds API
  // display names to one stable fixture identity.
  bochum: 'bochum',
  'vfl bochum': 'bochum',
  'hertha bsc': 'hertha',
  'hertha berlin': 'hertha',
  heidenheim: 'heidenheim',
  '1 heidenheim': 'heidenheim',
  osnabruck: 'osnabruck',
  'vfl osnabruck': 'osnabruck',
  'darmstadt 98': 'darmstadt 98',
  'sv darmstadt 98': 'darmstadt 98',
  magdeburg: 'magdeburg',
  '1 magdeburg': 'magdeburg',
  wolfsburg: 'wolfsburg',
  'vfl wolfsburg': 'wolfsburg',
  kaiserslautern: 'kaiserslautern',
  '1 kaiserslautern': 'kaiserslautern',
  nurnberg: 'nurnberg',
  '1 nurnberg': 'nurnberg',
};

const europeanTeamAliases: Readonly<Record<string, string>> = {
  // Provider feeds commonly translate or expand these names differently.
  'athletic bilbao': 'athletic bilbao',
  'athletic club': 'athletic bilbao',
  'bayern munchen': 'bayern munich',
  'bayern munich': 'bayern munich',
  'borussia m gladbach': 'borussia monchengladbach',
  'borussia monchengladbach': 'borussia monchengladbach',
  monchengladbach: 'borussia monchengladbach',
  cologne: 'cologne',
  koln: 'cologne',
  '1 koln': 'cologne',
  lyon: 'lyon',
  'olympique lyonnais': 'lyon',
  'real betis': 'real betis',
  'real betis balompie': 'real betis',
};

const teamAliases: Readonly<Record<string, string>> = {
  ...mlsTeamAliases,
  ...ligaMxTeamAliases,
  ...contenderTeamAliases,
  ...europeanTeamAliases,
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

const providerClubTokens = new Set([
  'ac',
  'afc',
  'bsc',
  'cf',
  'fc',
  'fk',
  'gnk',
  'hnk',
  'nk',
  'rb',
  'rc',
  'rcd',
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

/**
 * Accepts provider prefixes/sponsors only when both names still share a
 * distinctive token. Ambiguous single words such as `Real` or `United` never
 * match on their own.
 */
export function providerTeamNamesMatch(left: string, right: string): boolean {
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

const defaultSupportedCompetitionSlugs = ['mlspa'] as const;
const knownMlsTeamNames = new Set(Object.values(mlsTeamAliases));

export function supportsPlayerCompetition(
  player: PlayerStats,
  supportedCompetitionSlugs: readonly string[] =
    defaultSupportedCompetitionSlugs,
): boolean {
  return (
    player.position !== 'Goalkeeper' &&
    supportsFixtureCompetition(player, supportedCompetitionSlugs)
  );
}

export function supportsFixtureCompetition(
  player: PlayerStats,
  supportedCompetitionSlugs: readonly string[] =
    defaultSupportedCompetitionSlugs,
): boolean {
  if (!player.nextGame) return false;
  const supported = new Set(
    supportedCompetitionSlugs.map((slug) => slug.trim().toLocaleLowerCase()),
  );
  const competitionSlug = player.nextGame.competitionSlug;
  if (competitionSlug !== undefined) {
    return (
      competitionSlug !== null &&
      supported.has(competitionSlug.trim().toLocaleLowerCase())
    );
  }

  // Existing fixture:v1 entries predate `competitionSlug`. During their lazy
  // migration, accept only fixtures whose two normalized teams are both part
  // of the known MLS provider universe. Unknown legacy fixtures fail closed.
  return (
    supported.has('mlspa') &&
    Boolean(player.nextGame.homeTeamName) &&
    Boolean(player.nextGame.awayTeamName) &&
    knownMlsTeamNames.has(
      normalizeTeamName(player.nextGame.homeTeamName ?? ''),
    ) &&
    knownMlsTeamNames.has(
      normalizeTeamName(player.nextGame.awayTeamName ?? ''),
    )
  );
}

const canonicalPlayerNameParts: Readonly<Record<string, string>> = {
  // Sorare and several bookmakers use different English transliterations for
  // the same Cyrillic surname. Keep this deliberately narrow so unrelated
  // near-matches cannot be merged by the odds matcher.
  markhiyev: 'markhiev',
};

export function normalizePlayerName(value: string): string {
  // NFKD removes accents, but letters such as Icelandic thorn/eth are not
  // decomposed. Odds feeds commonly transliterate them while Sorare keeps the
  // native spelling (for example `Stefán Þórðarson` vs `Stefan Thordarson`).
  const transliterated = value
    .replace(/[Þþ]/g, 'th')
    .replace(/[Ðð]/g, 'd');
  const parts = normalizeWords(transliterated)
    .split(' ')
    .map((part) => canonicalPlayerNameParts[part] ?? part);
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

export function groupFixtures(
  players: readonly PlayerStats[],
  options: { includeGoalkeepers?: boolean } = {},
): FixtureGroup[] {
  const groups = new Map<string, FixtureGroup>();
  for (const player of players) {
    if (
      (!options.includeGoalkeepers && player.position === 'Goalkeeper') ||
      !player.nextGame
    ) {
      continue;
    }
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

function findEvent(
  fixture: FixtureGroup<MarketSupplementPlayer>,
  events: readonly OddsEvent[],
): OddsEvent | null {
  const kickoff = Date.parse(fixture.date);
  const candidates = events
    .filter(
      (event) =>
        providerTeamNamesMatch(event.home_team, fixture.homeTeamName) &&
        providerTeamNamesMatch(event.away_team, fixture.awayTeamName),
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
  player: MarketSupplementPlayer,
  fixturePlayers: readonly MarketSupplementPlayer[],
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
  fixturePlayers: readonly MarketSupplementPlayer[],
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
  const kickoff = Date.parse(fixtureDate);
  const lastFixtureCheck = Date.parse(
    snapshot.supplementedAt ?? snapshot.capturedAt,
  );
  const finalRetryAt = kickoff - finalMarketRetryLeadMs;
  const unseenPlayerRetryAt =
    lastFixtureCheck < finalRetryAt
      ? Math.min(lastFixtureCheck + firstMarketRetryDelayMs, finalRetryAt)
      : null;
  return fixturePlayers.some(
    (player) => {
      if (playerProbability(snapshot, player, fixturePlayers) !== null) {
        return false;
      }
      const check =
        snapshot.missingPlayerChecks?.[playerMarketOddsKey(player)];
      return (
        check
          ? shouldRetryMarketFailure(check, kickoff, now)
          : unseenPlayerRetryAt !== null &&
            now >= unseenPlayerRetryAt &&
            now < kickoff
      );
    },
  );
}

export function supplementFrozenSnapshot(
  existing: FrozenMarketSnapshot | undefined,
  incoming: FrozenMarketSnapshot,
  fixturePlayers: readonly MarketSupplementPlayer[],
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
  fixturePlayers: readonly MarketSupplementPlayer[],
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
    supplementedAt: new Date(checkedAt).toISOString(),
    missingPlayerChecks:
      Object.keys(missingPlayerChecks).length > 0
        ? missingPlayerChecks
        : undefined,
  });
}

const firstMarketRetryDelayMs = 12 * 60 * 60 * 1_000;
const laterMarketRetryDelayMs = 24 * 60 * 60 * 1_000;
const earlyMarketRetryLeadMs = 24 * 60 * 60 * 1_000;
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
    const retryAt =
      attemptCount === 1
        ? Math.max(
            checkedAt + firstMarketRetryDelayMs,
            kickoff - earlyMarketRetryLeadMs,
          )
        : checkedAt + laterMarketRetryDelayMs;
    nextRetryAt = Math.min(retryAt, finalRetryAt);
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
  fixture: FixtureGroup<MarketSupplementPlayer>,
  market: OddsMarketKey,
  previous: MarketSnapshot | undefined,
  checkedAt: number,
  eventId?: string,
): MarketSnapshot {
  const kickoff = Date.parse(fixture.date);
  const retry = nextMarketRetryState(previous, checkedAt, kickoff);
  return MissingMarketSnapshotSchema.parse({
    status: 'unavailable',
    market,
    ...(eventId ? { eventId } : {}),
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

export function theOddsApiQuotaUsage(
  headers: Headers,
  checkedAt: string,
): ProviderQuotaUsage | null {
  const usedHeader = headers.get('x-requests-used');
  const remainingHeader = headers.get('x-requests-remaining');
  if (usedHeader === null || remainingHeader === null) return null;
  const used = Number(usedHeader);
  const remaining = Number(remainingHeader);
  if (!Number.isFinite(used) || !Number.isFinite(remaining)) return null;
  return quotaUsage(
    'the-odds-api',
    'requests',
    used,
    used + remaining,
    checkedAt,
  );
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

  supports(player: PlayerStats): boolean {
    return supportsPlayerCompetition(
      player,
      this.options.supportedCompetitionSlugs ??
        defaultSupportedCompetitionSlugs,
    );
  }

  supportsMarket(
    player: PlayerStats,
    market: PlayerMarketField,
  ): boolean {
    return this.supports(player) && this.supportedFields().includes(market);
  }

  private supportedFields(): readonly PlayerMarketField[] {
    return this.options.supportedMarkets ?? ['goal', 'assist'];
  }

  private supportedMarketKeys(): readonly OddsMarketKey[] {
    const fields = this.supportedFields();
    return oddsMarketKeys.filter((market) =>
      fields.includes(
        market === 'player_goal_scorer_anytime' ? 'goal' : 'assist',
      ),
    );
  }

  private sportKeys(): string[] {
    return [
      ...new Set(
        [
          this.options.sportKey,
          ...(this.options.additionalSportKeys ?? []),
        ]
          .map((sportKey) => sportKey.trim())
          .filter(Boolean),
      ),
    ];
  }

  async refreshUsage(): Promise<ProviderQuotaUsage[]> {
    if (this.options.refreshUsage === false) return [];
    const response = await this.requestJson('/sports', {});
    const usage = theOddsApiQuotaUsage(
      response.headers,
      new Date(this.now()).toISOString(),
    );
    if (!usage) return [];
    return [usage];
  }

  private refreshRequestGroup(): string {
    return [
      'the-odds-api',
      this.options.sportKey,
      this.options.region,
      'player-props',
    ].join(':');
  }

  private async loadFixtureSnapshots(
    fixtureKey: string,
    cacheOnly: boolean,
    cacheOnlyReadBudgetMs?: number,
  ): Promise<Map<OddsMarketKey, MarketSnapshot>> {
    const byMarket = new Map<OddsMarketKey, MarketSnapshot>();
    const reads = this.supportedMarketKeys().map(async (market) => ({
      market,
      snapshot: await settleCacheReadWithin(
        this.options.store.get(fixtureKey, market),
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
    const markets = this.supportedMarketKeys();
    const entries = fixtures.flatMap((fixture) =>
      markets.map((market) => ({
        fixtureKey: fixture.key,
        market,
      })),
    );
    const loaded = await readMarketSnapshotsWithin(
      this.options.store,
      entries,
      true,
      cacheOnlySnapshotReadBudgetMs(loadOptions),
    );
    const snapshots = new Map<string, Map<OddsMarketKey, MarketSnapshot>>(
      fixtures.map((fixture) => [fixture.key, new Map()]),
    );
    for (const [index, entry] of entries.entries()) {
      const snapshot = loaded[index];
      if (snapshot) snapshots.get(entry.fixtureKey)?.set(entry.market, snapshot);
    }
    return snapshots;
  }

  private marketsNeedingApi(
    fixture: FixtureGroup<MarketSupplementPlayer>,
    byMarket: Map<OddsMarketKey, MarketSnapshot>,
    protection: OddsUsageProtection,
  ): OddsMarketKey[] {
    const kickoff = Date.parse(fixture.date);
    return this.supportedMarketKeys().filter((market) => {
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
  }

  private supplementPlayers(
    fixture: FixtureGroup<MarketSupplementPlayer>,
    markets: readonly OddsMarketKey[],
    snapshots: Map<OddsMarketKey, MarketSnapshot>,
  ): MarketSupplementPlayer[] {
    const missing = fixture.players.filter((player) =>
      markets.some((market) => {
        const snapshot = snapshots.get(market);
        return (
          snapshot?.status === 'available' &&
          playerProbability(snapshot, player, fixture.players) === null
        );
      }),
    );
    return missing.length > 0 ? missing : fixture.players;
  }

  private mergeQueuedPlayers(
    fixture: FixtureGroup,
    batch: MarketSupplementBatch | undefined,
  ): FixtureGroup<MarketSupplementPlayer> {
    if (!batch) return fixture;
    const players = new Map<string, MarketSupplementPlayer>();
    for (const player of [...fixture.players, ...batch.players]) {
      players.set(playerMarketOddsKey(player), player);
    }
    return { ...fixture, players: [...players.values()] };
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
          'the-odds-api',
          this.options.logger,
          this.now(),
        );

    const snapshots = new Map<string, Map<OddsMarketKey, MarketSnapshot>>();
    const fixturesNeedingApi: Array<{
      fixture: FixtureGroup;
      missingMarkets: OddsMarketKey[];
      supplementOnly: boolean;
    }> = [];

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

      const kickoff = Date.parse(fixture.date);
      const millisecondsUntilKickoff = kickoff - this.now();
      const insideFetchWindow =
        millisecondsUntilKickoff <= this.options.fetchWindowMs &&
        millisecondsUntilKickoff >= 0;
      if (!insideFetchWindow) continue;
      const missingMarkets = this.marketsNeedingApi(
        fixture,
        byMarket,
        protection,
      );
      if (
        !loadOptions?.cacheOnly &&
        protection.allowExternalRequests &&
        missingMarkets.length > 0
      ) {
        fixturesNeedingApi.push({
          fixture,
          missingMarkets,
          supplementOnly: missingMarkets.every(
            (market) => byMarket.get(market)?.status === 'available',
          ),
        });
      }
    }

    if (fixturesNeedingApi.length > 0) {
      const requestGroup = this.refreshRequestGroup();
      const batchDelayMs =
        this.options.supplementBatchDelayMs ?? defaultSupplementBatchDelayMs;
      const batchTtlMs =
        this.options.supplementBatchTtlMs ?? defaultSupplementBatchTtlMs;
      const leaseTtlMs =
        this.options.refreshLeaseTtlMs ?? defaultRefreshLeaseTtlMs;
      const coordinated = (
        await Promise.all(
          fixturesNeedingApi.map(async (pending) => {
            if (
              pending.supplementOnly &&
              this.options.store.enqueueSupplementPlayers
            ) {
              await this.options.store.enqueueSupplementPlayers(
                pending.fixture.key,
                requestGroup,
                this.supplementPlayers(
                  pending.fixture,
                  pending.missingMarkets,
                  snapshots.get(pending.fixture.key) ??
                    new Map<OddsMarketKey, MarketSnapshot>(),
                ),
                batchDelayMs,
                batchTtlMs,
              );
            }

            const ownsLease = this.options.store.claimRefreshLease
              ? await this.options.store.claimRefreshLease(
                  pending.fixture.key,
                  requestGroup,
                  leaseTtlMs,
                )
              : true;
            if (!ownsLease) {
              this.options.logger.debug(
                { fixture: pending.fixture.key, requestGroup },
                'The Odds API refresh skipped because another Worker owns the lease',
              );
              return null;
            }

            if (pending.supplementOnly && batchDelayMs > 0) {
              await this.sleep(batchDelayMs);
            }
            const batch = pending.supplementOnly
              ? await this.options.store.getSupplementBatch?.(
                  pending.fixture.key,
                  requestGroup,
                )
              : undefined;
            const fixture = this.mergeQueuedPlayers(pending.fixture, batch);
            const byMarket = await this.loadFixtureSnapshots(
              fixture.key,
              loadOptions?.cacheOnly === true,
            );
            snapshots.set(fixture.key, byMarket);
            const missingMarkets = this.marketsNeedingApi(
              fixture,
              byMarket,
              protection,
            );
            if (missingMarkets.length === 0) {
              return null;
            }
            return {
              fixture,
              missingMarkets,
              queuedSupplement: pending.supplementOnly,
            };
          }),
        )
      ).filter(
        (
          pending,
        ): pending is {
          fixture: FixtureGroup<MarketSupplementPlayer>;
          missingMarkets: OddsMarketKey[];
          queuedSupplement: boolean;
        } => pending !== null,
      );

      if (coordinated.length === 0) {
        return this.resultsFromSnapshots(output, fixtures, snapshots);
      }
      const sportKeys = this.sportKeys();
      const eventCatalogs: Array<{
        sportKey: string;
        events: OddsEvent[];
      }> = [];
      await mapWithConcurrency(sportKeys, 2, async (sportKey) => {
        try {
          const events = OddsEventsSchema.parse(
            (
              await this.requestJson(
                `/sports/${encodeURIComponent(sportKey)}/events`,
                {},
              )
            ).body,
          );
          eventCatalogs.push({ sportKey, events });
        } catch (error) {
          this.options.logger.warn(
            {
              sportKey,
              error: error instanceof Error ? error.message : String(error),
            },
            'The Odds API event lookup failed for sport; keeping fixture eligible for retry',
          );
        }
      });

      if (eventCatalogs.length > 0) {
        const allEventLookupsSucceeded =
          eventCatalogs.length === sportKeys.length;
        await mapWithConcurrency(coordinated, 4, async (pending) => {
          const match = eventCatalogs
            .map((catalog) => ({
              sportKey: catalog.sportKey,
              event: findEvent(pending.fixture, catalog.events),
            }))
            .find(
              (
                candidate,
              ): candidate is { sportKey: string; event: OddsEvent } =>
                candidate.event !== null,
            );
          if (!match) {
            if (allEventLookupsSucceeded) {
              const unavailableMarkets = pending.missingMarkets.filter(
                (market) =>
                  snapshots.get(pending.fixture.key)?.get(market)?.status !==
                  'available',
              );
              await this.storeMissing(pending.fixture, unavailableMarkets);
            }
            return;
          }
          await this.fetchFixtureMarkets(
            pending.fixture,
            match.event,
            pending.missingMarkets,
            snapshots.get(pending.fixture.key) ??
              new Map<OddsMarketKey, MarketSnapshot>(),
            protection,
            match.sportKey,
          );
        });
      }
      // Supplement queues intentionally expire instead of being deleted here.
      // A player may be enqueued by another isolate while this owner is still
      // fetching. Retaining the short-lived queue prevents that late player
      // from being acknowledged without ever being processed and also keeps
      // transient provider failures retryable.
    }

    return this.resultsFromSnapshots(output, fixtures, snapshots);
  }

  private resultsFromSnapshots(
    output: Map<string, PlayerMarketOdds | null>,
    fixtures: readonly FixtureGroup[],
    snapshots: Map<string, Map<OddsMarketKey, MarketSnapshot>>,
  ): Map<string, PlayerMarketOdds | null> {
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
    fixture: FixtureGroup<MarketSupplementPlayer>,
    event: OddsEvent,
    markets: OddsMarketKey[],
    snapshots: Map<OddsMarketKey, MarketSnapshot>,
    protection: OddsUsageProtection,
    sportKey: string,
  ): Promise<void> {
    try {
      const response = await this.requestJson(
        `/sports/${encodeURIComponent(
          sportKey,
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
          sportKey,
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
        protection.allowRegionalFallback,
        sportKey,
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
            protection.allowRegionalFallback,
            sportKey,
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
    fixture: FixtureGroup<MarketSupplementPlayer>,
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
    fixture: FixtureGroup<MarketSupplementPlayer>,
    event: OddsEvent,
    markets: readonly OddsMarketKey[],
    snapshots: Map<OddsMarketKey, MarketSnapshot>,
    allowRegionalFallback: boolean,
    sportKey: string,
  ): Promise<void> {
    if (!allowRegionalFallback) return;
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
          sportKey,
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
          sportKey,
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
            sportKey,
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
    fixture: FixtureGroup<MarketSupplementPlayer>,
    event: OddsEvent,
    market: OddsMarketKey,
    snapshots: Map<OddsMarketKey, MarketSnapshot>,
    fallbackRegion: string,
    sportKey: string,
  ): Promise<void> {
    try {
      const response = await this.requestJson(
        `/sports/${encodeURIComponent(
          sportKey,
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
          sportKey,
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
    fixture: FixtureGroup<MarketSupplementPlayer>,
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
    fixture: FixtureGroup<MarketSupplementPlayer>,
    event: OddsEvent,
    market: OddsMarketKey,
    snapshots: Map<OddsMarketKey, MarketSnapshot>,
    allowRegionalFallback: boolean,
    sportKey: string,
  ): Promise<void> {
    try {
      const response = await this.requestJson(
        `/sports/${encodeURIComponent(
          sportKey,
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
          sportKey,
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
          allowRegionalFallback,
          sportKey,
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
        allowRegionalFallback,
        sportKey,
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
            allowRegionalFallback,
            sportKey,
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
          allowRegionalFallback,
          sportKey,
        );
        return;
      }
      this.options.logger.warn(
        {
          fixture: fixture.key,
          sportKey,
          markets: [market],
          error: error instanceof Error ? error.message : String(error),
        },
        'The Odds API market request failed; returning stats without new market odds',
      );
    }
  }

  private async storeMissing(
    fixture: FixtureGroup<MarketSupplementPlayer>,
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
        const body = await response.json();
        await this.rememberQuota(response.headers);
        return { body, headers: response.headers };
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

  private async rememberQuota(headers: Headers): Promise<void> {
    if (!this.options.usageStore) return;
    const usage = theOddsApiQuotaUsage(
      headers,
      new Date(this.now()).toISOString(),
    );
    if (!usage) return;
    try {
      await this.options.usageStore.set(usage);
    } catch (error) {
      this.options.logger.warn(
        {
          provider: 'the-odds-api',
          error: error instanceof Error ? error.message : String(error),
        },
        'Bookmaker quota usage could not be persisted',
      );
    }
  }
}
