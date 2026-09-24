import {
  calculateHistoricalAssistMetrics,
  calculateHistoricalDecisiveMetrics,
  calculateHistoricalGoalMetrics,
  calculatePlayerMetrics,
  fixtureStatusKey,
  type FootballPosition,
  type PlayerMarketSnapshot,
  type PlayerStats,
  type ValidatedPlayerMarketSnapshotsRequest,
  type ValidatedPlayerStatsRequest,
} from '@sorare-overlay/shared';
import {
  supportsSplitPlayerStatsCache,
  type Cache,
  type PlayerFormStats,
  type SplitPlayerStatsCacheAccess,
} from '../cache.js';
import {
  marketFixtureKey,
  playerMarketFieldDrivesRequest,
  playerMarketFieldSupported,
  playerMarketOddsKey,
  playerMarketOddsSupported,
  type PlayerMarketOddsProvider,
} from '../providers/market-odds-provider.js';
import type { GoalscorerProbabilityProvider } from '../providers/goalscorer-provider.js';
import type { FixtureLifecycle } from './fixture-lifecycle.js';
import {
  UnavailableFixtureMatchOddsProvider,
  type FixtureMatchOddsProvider,
} from '../providers/match-odds-provider.js';
import type {
  PlayerStatsDataSource,
  SourcePlayer,
  SourcePlayerFixture,
  SourcePlayerRequest,
} from './data-source.js';
import {
  playerTeamFixtureIdentity,
  sameFixtureIdentity,
} from './fixture-identity.js';
import { mapSettledWithConcurrency, mapWithConcurrency } from './concurrency.js';
import type { PlayerLoadLeases } from './player-load-leases.js';
import type { AaContextService } from './aa-context.js';

export interface StatsServiceResult {
  data: PlayerStats[];
  cacheHits: number;
  source: 'sorare' | 'mock';
  deferredPlayerNames: string[];
  deferredPlayerSlugs: string[];
  diagnostics: {
    requestedPlayers: number;
    resolvedPlayers: number;
    returnedPlayers: number;
    cacheHits: number;
    deferredNames: number;
    partialHistories: number;
    responseBudgetExceeded: boolean;
    durationsMs: {
      nameResolution: number;
      cache: number;
      baseAndHistory: number;
      result: number;
      total: number;
    };
  };
}

function cacheKey(request: SourcePlayerRequest, excludeLowCoverage: boolean): string {
  const positionKey = request.position ?? 'auto-v3';
  return `${request.slug}:${positionKey}:${excludeLowCoverage ? 'no-low' : 'all'}`;
}

function inFlightKey(
  request: SourcePlayerRequest,
  excludeLowCoverage: boolean,
): string {
  return `${cacheKey(request, excludeLowCoverage)}:${
    request.includeHistoricalAssists ? 'assist-history' : 'base'
  }`;
}

function hasRequestedHistoricalWindows(
  stats: PlayerFormStats,
  includeHistoricalAssists: boolean,
): boolean {
  return (
    !includeHistoricalAssists ||
    (stats.historicalAssists !== undefined &&
      stats.historicalGoals !== undefined &&
      stats.historicalDecisives !== undefined)
  );
}

type StatsPhase = Exclude<keyof StatsServiceResult['diagnostics']['durationsMs'], 'total'>;
interface StatsLoadProgress {
  ready: Map<string, PlayerStats>;
  requests: SourcePlayerRequest[];
  cacheHits: number;
  phase: StatsPhase;
  phaseStartedAt: number;
  durationsMs: Record<StatsPhase, number>;
}

function createStatsLoadProgress(): StatsLoadProgress {
  return {
    ready: new Map(), requests: [], cacheHits: 0,
    phase: 'nameResolution', phaseStartedAt: performance.now(),
    durationsMs: {nameResolution: 0, cache: 0, baseAndHistory: 0, result: 0},
  };
}

function startStatsPhase(progress: StatsLoadProgress, phase: StatsPhase): void {
  progress.durationsMs[progress.phase] = elapsedMs(progress.phaseStartedAt);
  progress.phase = phase;
  progress.phaseStartedAt = performance.now();
}

export interface PlayerMarketSnapshotsResult {
  data: PlayerMarketSnapshot[];
  source: 'sorare' | 'mock';
  durationMs: number;
}

const CACHE_ONLY_ODDS_BATCH_EXTRA_PER_PLAYER_MS = 25;
const CACHE_ONLY_ODDS_BATCH_MAX_MS = 1_600;
const BACKGROUND_PLAYER_LOAD_CHUNK_SIZE = 8;
const BACKGROUND_PLAYER_LOAD_CONCURRENCY = 2;
const HISTORY_COMPLETION_CONCURRENCY = 4;
const FIXTURE_REFRESH_CLAIM_CONCURRENCY = 6;

function chunks<T>(values: readonly T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

function hasNoUsablePlayerData(stats: PlayerStats): boolean {
  return (
    stats.nextGame === null &&
    stats.aaL10.sampleSize === 0 &&
    stats.cleanSheetL10.sampleSize === 0 &&
    stats.goalL10.sampleSize === 0
  );
}

function mergeMatchProbabilities(
  primary: NonNullable<PlayerStats['nextGame']>['matchProbabilities'],
  fallback: NonNullable<PlayerStats['nextGame']>['matchProbabilities'],
): NonNullable<PlayerStats['nextGame']>['matchProbabilities'] {
  if (primary === null) return fallback;
  if (fallback === null) return primary;
  return {
    win: primary.win ?? fallback.win,
    draw: primary.draw ?? fallback.draw,
    loss: primary.loss ?? fallback.loss,
  };
}

function needsFixtureTeamOddsFallback(stats: PlayerStats): boolean {
  if (!stats.nextGame) return false;
  const probabilities = stats.nextGame.matchProbabilities;
  const needsCleanSheet =
    (stats.position === 'Goalkeeper' || stats.position === 'Defender') &&
    stats.nextGame.cleanSheetProbability === null;
  return (
    needsCleanSheet ||
    (probabilities === null ||
      probabilities.win === null ||
      probabilities.draw === null ||
      probabilities.loss === null)
  );
}

function teamSlugsLikelyMatch(
  candidateSlug: string | undefined,
  expectedSlug: string | undefined,
): boolean {
  if (!candidateSlug || !expectedSlug) return false;
  const candidate = candidateSlug.trim().toLowerCase();
  const expected = expectedSlug.trim().toLowerCase();
  return (
    candidate === expected ||
    candidate.startsWith(`${expected}-`) ||
    expected.startsWith(`${candidate}-`)
  );
}

function hydrateConfirmedFixtureTeamIdentity(
  fixture: PlayerStats['nextGame'],
  request: SourcePlayerRequest | undefined,
): PlayerStats['nextGame'] {
  if (
    !fixture ||
    !request?.resolvedFromName ||
    !request.teamSlug ||
    fixture.playerTeamSlug
  ) {
    return fixture;
  }
  const home = teamSlugsLikelyMatch(
    fixture.homeTeamSlug,
    request.teamSlug,
  );
  const away = teamSlugsLikelyMatch(
    fixture.awayTeamSlug,
    request.teamSlug,
  );
  if (home === away) return fixture;
  const playerTeamName = home
    ? fixture.homeTeamName
    : fixture.awayTeamName;
  const opponentTeamName = home
    ? fixture.awayTeamName
    : fixture.homeTeamName;
  const playerTeamSlug = home
    ? fixture.homeTeamSlug
    : fixture.awayTeamSlug;
  if (!playerTeamName || !opponentTeamName || !playerTeamSlug) return fixture;
  return {
    ...fixture,
    playerTeamName,
    opponentTeamName,
    playerTeamSlug,
  };
}

function fixtureStartsBefore(
  candidate: NonNullable<PlayerStats['nextGame']>,
  current: NonNullable<PlayerStats['nextGame']>,
): boolean {
  const candidateKickoff = Date.parse(candidate.date);
  const currentKickoff = Date.parse(current.date);
  return (
    Number.isFinite(candidateKickoff) &&
    Number.isFinite(currentKickoff) &&
    candidateKickoff < currentKickoff
  );
}

function preservePlayerMarketOdds(
  teamFixture: NonNullable<PlayerStats['nextGame']>,
  playerFixture: NonNullable<PlayerStats['nextGame']>,
): NonNullable<PlayerStats['nextGame']> {
  const { marketOdds: _teamMarketOdds, ...shared } = teamFixture;
  return {
    ...shared,
    ...(sameFixtureIdentity(teamFixture, playerFixture) && playerFixture.marketOdds !== undefined
      ? { marketOdds: playerFixture.marketOdds }
      : {}),
  };
}

function harmonizePlayerTeamFixtures(
  players: readonly PlayerStats[],
  requests: readonly SourcePlayerRequest[] = [],
): PlayerStats[] {
  const requestedTeamByPlayer = new Map<string, string>();
  for (const request of requests) {
    if (!request.teamSlug) continue;
    requestedTeamByPlayer.set(
      `${request.slug}:${request.position ?? 'default'}`,
      request.teamSlug,
    );
  }
  const requestedTeam = (player: PlayerStats): string | undefined =>
    requestedTeamByPlayer.get(`${player.slug}:${player.position}`) ??
    requestedTeamByPlayer.get(`${player.slug}:default`);
  const fixtureByTeam = new Map<
    string,
    NonNullable<PlayerStats['nextGame']>
  >();
  for (const player of players) {
    const fixture = player.nextGame;
    const teamName = fixture?.playerTeamName;
    if (!fixture || !teamName) continue;
    const teamKey =
      fixture.playerTeamSlug ??
      requestedTeam(player) ??
      playerTeamFixtureIdentity(fixture);
    if (!teamKey) continue;
    const existing = fixtureByTeam.get(teamKey);
    const kickoff = Date.parse(fixture.date);
    const existingKickoff = existing ? Date.parse(existing.date) : Number.NaN;
    if (
      !existing ||
      (Number.isFinite(kickoff) &&
        (!Number.isFinite(existingKickoff) || kickoff < existingKickoff))
    ) {
      fixtureByTeam.set(teamKey, fixture);
    }
  }

  return players.map((player) => {
    const fixture = player.nextGame;
    const teamKey =
      fixture?.playerTeamSlug ??
      requestedTeam(player) ??
      (fixture?.playerTeamName
        ? playerTeamFixtureIdentity(fixture)
        : undefined);
    const shared = teamKey ? fixtureByTeam.get(teamKey) : undefined;
    if (!shared || shared === fixture) return player;
    const { marketOdds: _sharedMarketOdds, ...sharedFixture } = shared;
    return {
      ...player,
      nextGame: {
        ...sharedFixture,
        // Preserve only the player-specific prop snapshot. CS and H-D-A come
        // from the selected shared team fixture.
        ...(fixture?.marketOdds !== undefined
          ? { marketOdds: fixture.marketOdds }
          : { marketOdds: null }),
      },
    };
  });
}

type PendingRefresh = NonNullable<PlayerStats['pendingRefreshes']>[number];

interface FixtureRefreshEntry {
  key: string;
  request: SourcePlayerRequest;
  form: PlayerFormStats;
  existingFixture?: PlayerStats['nextGame'];
}

function fixtureRefreshClaimKey(
  fixture: NonNullable<PlayerStats['nextGame']>,
): string | null {
  const fixtureKey = marketFixtureKey(fixture);
  const playerTeamKey = playerTeamFixtureIdentity(fixture);
  return fixtureKey && playerTeamKey
    ? `${fixtureKey}|${playerTeamKey}`
    : null;
}

export type BackgroundTaskScheduler = (task: Promise<void>) => void;
export const DEFAULT_NAME_RESOLUTION_BUDGET_MS = 650;

interface LoadBatchOptions {
  onDeferred?: (request: SourcePlayerRequest) => void;
  onLoaded?: (key: string, stats: PlayerStats) => void;
  allowPartialHistory?: boolean;
  completeHistory?: boolean;
  overwriteForm?: boolean;
  scheduleHistoryCompletion?: boolean;
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}

type TimedResult<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }
  | { status: 'timed-out' };

function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<TimedResult<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ status: 'timed-out' });
    }, timeoutMs);
    void promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({ status: 'fulfilled', value });
      },
      (reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({ status: 'rejected', reason });
      },
    );
  });
}

export class StatsService {
  private readonly inFlight = new Map<string, Promise<{stats: PlayerStats | undefined; deferred: boolean}>>();

  constructor(
    private readonly dataSource: PlayerStatsDataSource,
    private readonly goalscorerProvider: GoalscorerProbabilityProvider,
    private readonly cache: Cache<PlayerStats>,
    private readonly excludeLowCoverage: boolean,
    private readonly marketOddsProvider: PlayerMarketOddsProvider,
    private readonly scheduleBackground?: BackgroundTaskScheduler,
    private readonly nameResolutionBudgetMs =
      DEFAULT_NAME_RESOLUTION_BUDGET_MS,
    private readonly fixtureMatchOddsProvider: FixtureMatchOddsProvider =
      new UnavailableFixtureMatchOddsProvider(),
    private readonly cacheOnlyOddsBudgetMs = 350,
    private readonly responseBudgetMs = 9_000,
    private readonly playerLoadLeases?: PlayerLoadLeases,
    private readonly fixtureLifecycle?: FixtureLifecycle,
    private readonly aaContextService?: AaContextService,
  ) {}

  async getPlayerStats(
    request: ValidatedPlayerStatsRequest,
  ): Promise<StatsServiceResult> {
    const result=await this.getPlayerStatsWithinBudget(request);
    let data = this.fixtureLifecycle ? await this.fixtureLifecycle.decorate(result.data) : result.data;
    // Project only after club form/fixture loading and persistence have ended.
    // Legacy clients keep their existing club-scoped contract and tooltips.
    if (request.supportsAaContext && this.aaContextService) data = await this.aaContextService.decorate(data);
    return {...result, data};
  }

  private async getPlayerStatsWithinBudget(
    request: ValidatedPlayerStatsRequest,
  ): Promise<StatsServiceResult> {
    if (!this.scheduleBackground) return this.loadPlayerStats(request);
    const progress = createStatsLoadProgress();
    const pending = this.loadPlayerStats(request, progress);
    const settled = await settleWithin(pending, this.responseBudgetMs);
    if (settled.status === 'fulfilled') return settled.value;
    if (settled.status === 'rejected') throw settled.reason;

    // Keep the cache-warming request alive after returning a bounded partial
    // response. The extension retries only the identities listed below.
    this.scheduleBackground(
      pending.then(
        () => undefined,
        () => undefined,
      ),
    );
    const data = [...progress.ready.values()].map((stats): PlayerStats => {
      const pending = new Set(stats.pendingRefreshes ?? []);
      if (stats.nextGame && playerMarketOddsSupported(this.marketOddsProvider, stats)) pending.add('marketOdds');
      if (needsFixtureTeamOddsFallback(stats) && this.fixtureMatchOddsProvider.supports(stats)) pending.add('fixture');
      return {...stats, ...(pending.size ? {pendingRefreshes: [...pending]} : {})};
    });
    const missing = (target: SourcePlayerRequest) => !progress.ready.has(cacheKey(target, this.excludeLowCoverage));
    const deferredPlayerSlugs = request.slugs.filter(slug =>
      !progress.requests.some(target => target.slug === slug && !missing(target)));
    const deferredPlayerNames = request.playerNames.filter(name =>
      !progress.requests.some(target => target.resolvedFromName === name && !missing(target)));
    return {
      data,
      cacheHits: progress.cacheHits,
      source: this.dataSource.source,
      deferredPlayerNames,
      deferredPlayerSlugs,
      diagnostics: {
        requestedPlayers: request.slugs.length + request.playerNames.length,
        resolvedPlayers: progress.requests.length,
        returnedPlayers: data.length,
        cacheHits: progress.cacheHits,
        deferredNames: deferredPlayerNames.length,
        partialHistories: data.filter(stats => stats.pendingRefreshes?.includes('formHistory')).length,
        responseBudgetExceeded: true,
        durationsMs: {
          ...progress.durationsMs,
          // Preserve the phase that actually exhausted the deadline instead
          // of reporting zero for every phase on the slowest requests.
          [progress.phase]: elapsedMs(progress.phaseStartedAt),
          total: this.responseBudgetMs,
        },
      },
    };
  }

  async getPlayerMarketSnapshots(
    request: ValidatedPlayerMarketSnapshotsRequest,
  ): Promise<PlayerMarketSnapshotsResult> {
    const startedAt = performance.now();
    const emptyMetric = { value: null, sampleSize: 0 } as const;
    const players = request.players.map((target): PlayerStats => {
      const nextGame = target.nextGame
        ? (() => {
            const { marketOdds: _clientMarketOdds, ...fixture } =
              target.nextGame;
            return { ...fixture, marketOdds: null };
          })()
        : null;
      return {
        slug: target.slug,
        displayName: target.displayName,
        position: target.position,
        aaL10: emptyMetric,
        cleanSheetL10: emptyMetric,
        goalL10: emptyMetric,
        nextGame,
        excludedLowCoverage: 0,
      };
    });
    const eligiblePlayers = players.filter((player) =>
      playerMarketOddsSupported(this.marketOddsProvider, player),
    );
    const refreshDuePlayerKeys = new Set<string>();
    const refreshDueState = { complete: false };
    const marketOdds = await this.loadCacheOnlyWithinBudget(
      this.marketOddsProvider.load(eligiblePlayers, {
        cacheOnly: true,
        cacheOnlyDeadlineMs: Date.now() + this.cacheOnlyOddsBudgetMs,
        refreshDuePlayerKeys,
        refreshDueState,
      }),
    );

    const data = players.map((player): PlayerMarketSnapshot => {
      const key = playerMarketOddsKey(player);
      const supported = playerMarketOddsSupported(
        this.marketOddsProvider,
        player,
      );
      const odds = supported ? marketOdds.get(key) ?? null : null;
      const missingRequestDrivingMarket = (
        ['goal', 'assist'] as const
      ).some(
        (market) =>
          playerMarketFieldDrivesRequest(
            this.marketOddsProvider,
            player,
            market,
          ) && !odds?.[market],
      );
      const refreshState = !supported
        ? ('unsupported' as const)
        : this.marketOddsProvider.reportsRefreshDue === true &&
            refreshDueState.complete
          ? refreshDuePlayerKeys.has(key)
            ? ('pending' as const)
            : ('settled' as const)
          : missingRequestDrivingMarket
            ? ('pending' as const)
            : ('settled' as const);
      const fixture = player.nextGame
        ? {
            date: player.nextGame.date,
            ...(player.nextGame.homeTeamSlug
              ? { homeTeamSlug: player.nextGame.homeTeamSlug }
              : {}),
            ...(player.nextGame.awayTeamSlug
              ? { awayTeamSlug: player.nextGame.awayTeamSlug }
              : {}),
            ...(player.nextGame.playerTeamSlug
              ? { playerTeamSlug: player.nextGame.playerTeamSlug }
              : {}),
          }
        : null;
      return {
        slug: player.slug,
        position: player.position,
        fixture,
        marketOdds: odds,
        refreshState,
      };
    });

    return {
      data,
      source: this.dataSource.source,
      durationMs: elapsedMs(startedAt),
    };
  }

  private async loadPlayerStats(
    request: ValidatedPlayerStatsRequest,
    progress = createStatsLoadProgress(),
  ): Promise<StatsServiceResult> {
    const requestStartedAt = performance.now();
    const nameResolutionStartedAt = performance.now();
    const directRequests = request.slugs.map((slug): SourcePlayerRequest => {
      const position = request.positions?.[slug];
      const teamSlug = request.playerTeams?.[slug];
      return {
        slug,
        ...(position ? { position } : {}),
        ...(teamSlug ? { teamSlug } : {}),
        ...(request.includeHistoricalAssists
          ? { includeHistoricalAssists: true }
          : {}),
      };
    });
    const nameResolution = await this.resolveNamesForResponse(
      request.playerNames,
      request.positions,
      request.playerTeams,
      request.includeHistoricalAssists,
    );
    const nameResolutionDurationMs = elapsedMs(nameResolutionStartedAt);
    const resolvedRequests = nameResolution.resolved.map(
      (resolved): SourcePlayerRequest => ({
        ...resolved,
        ...(request.includeHistoricalAssists
          ? { includeHistoricalAssists: true }
          : {}),
      }),
    );
    const playerRequests = [
      ...new Map(
        [...directRequests, ...resolvedRequests].map((playerRequest) => [
          `${playerRequest.slug}:${playerRequest.position ?? 'default'}`,
          playerRequest,
        ]),
      ).values(),
    ];
    const cacheStartedAt = performance.now();
    startStatsPhase(progress, 'cache');
    progress.requests = [...directRequests, ...resolvedRequests];
    const immediate = progress.ready;
    const fixtureRefreshEntries: FixtureRefreshEntry[] = [];
    const unresolvedFixtureIdentities = new Set<string>();
    let cacheHits = 0;
    const splitCache = supportsSplitPlayerStatsCache(this.cache)
      ? this.cache
      : undefined;

    if (splitCache) {
      const keyedRequests = playerRequests.map((playerRequest) => ({
        key: cacheKey(playerRequest, this.excludeLowCoverage),
        playerRequest,
      }));
      const partsByKey = await splitCache.getPartsMany(
        keyedRequests.map(({ key }) => key),
      );
      if(request.checkFixtureStatus && this.fixtureLifecycle) {
        const checked=await this.fixtureLifecycle.check([...partsByKey.values()].flatMap(parts=>parts.fixture?[parts.fixture]:[]));
        for(const [key,parts] of partsByKey) {
          if(parts.fixture && await this.fixtureLifecycle.isFinished(parts.fixture)) {
            partsByKey.set(key,parts.form ? {form:parts.form} : {});
          } else if(parts.fixture && checked.has(fixtureStatusKey(parts.fixture)??'') && await this.fixtureLifecycle.isActive(parts.fixture)) {
            await splitCache.refreshFixture(key,parts.fixture);
          }
        }
      }
      const cachedParts = keyedRequests.map(({ key, playerRequest }) => ({
        key,
        playerRequest,
        parts: partsByKey.get(key) ?? {},
      }));
      const conflictingParts = cachedParts.filter(({ playerRequest, parts }) =>
        parts.form && parts.fixture?.playerTeamSlug && playerRequest.resolvedFromName && playerRequest.teamSlug &&
        !teamSlugsLikelyMatch(parts.fixture.playerTeamSlug, playerRequest.teamSlug),
      );
      const conflictingKeys = new Set(conflictingParts.map(({ key }) => key));
      let confirmedFixtures = new Map<string, SourcePlayerFixture>();
      if (conflictingParts.length > 0) {
        // A formerly confirmed name-cache alias can still be stale.
        // Revalidate only conflicts, in one position-independent batch,
        // without passing either hint back to the source as trusted identity.
        // Seed safe partial results before I/O so the normal response deadline
        // never returns the disputed club's fixture while confirmation waits.
        for (const { key, parts } of cachedParts) {
          if (!parts.form || !hasRequestedHistoricalWindows(parts.form, request.includeHistoricalAssists)) continue;
          immediate.set(key, {
            ...parts.form,
            nextGame: conflictingKeys.has(key) ? null : parts.fixture ?? null,
            ...(conflictingKeys.has(key) ? { pendingRefreshes: ['fixture'] as PendingRefresh[] } : {}),
          });
        }
        try {
          const fixtures = await this.dataSource.fetchNextGames(
            [...new Set(conflictingParts.map(({ playerRequest }) => playerRequest.slug))].map(slug => ({ slug })),
          );
          confirmedFixtures = new Map(fixtures.map(fixture => [fixture.slug, fixture]));
        } catch {
          // Preserve form data, but do not show or request odds for an
          // unresolved club. The pending fixture is retried by the client.
        }
      }
      const hydratedCachedParts = await Promise.all(
        cachedParts.map(async (cached) => {
          if (
            cached.parts.form === undefined ||
            !cached.playerRequest.teamSlug
          ) {
            return cached;
          }
          if (conflictingKeys.has(cached.key) && cached.parts.fixture) {
            const original = cached.parts.fixture;
            const confirmed = confirmedFixtures.get(cached.playerRequest.slug);
            const confirmedTeam = confirmed?.playerTeamSlug;
            const unresolved = () => {
              unresolvedFixtureIdentities.add(cached.key);
              return { ...cached, parts: { ...cached.parts, fixture: null } };
            };
            if (!confirmedTeam) return unresolved();
            if (teamSlugsLikelyMatch(original.playerTeamSlug, confirmedTeam)) return cached;
            try {
              // A different request may already have repaired/advanced this
              // player while the source was loading. Keep that newer result.
              const latest = await splitCache.getParts(cached.key);
              if (latest.fixture && (
                !sameFixtureIdentity(original, latest.fixture) ||
                original.playerTeamSlug !== latest.fixture.playerTeamSlug
              )) return { ...cached, parts: { ...cached.parts, fixture: latest.fixture } };

              const candidate: PlayerStats['nextGame'] | undefined = confirmed.nextGame ??
                await splitCache.getTeamFixture(cached.key, confirmedTeam);
              if (!candidate || !teamSlugsLikelyMatch(candidate.playerTeamSlug, confirmedTeam)) return unresolved();
              // Never carry the old match's player props (or a teammate's
              // props) into the new club fixture. Providers read the new key.
              const { marketOdds: _marketOdds, ...nextGame } = candidate;
              const fixture = await splitCache.refreshFixture(cached.key, nextGame);
              if (!fixture || !teamSlugsLikelyMatch(fixture.playerTeamSlug, confirmedTeam)) return unresolved();
              return { ...cached, parts: { ...cached.parts, fixture } };
            } catch {
              return unresolved();
            }
          }
          if (
            cached.parts.fixture !== undefined &&
            cached.parts.fixture !== null
          ) {
            const canonicalTeamSlug = cached.playerRequest.resolvedFromName
              ? cached.playerRequest.teamSlug
              : undefined;
            const canonicalShared = canonicalTeamSlug
              ? await splitCache.getTeamFixture(
                  cached.key,
                  canonicalTeamSlug,
                )
              : undefined;
            if (
              canonicalShared &&
              (sameFixtureIdentity(
                canonicalShared,
                cached.parts.fixture,
              ) ||
                fixtureStartsBefore(
                  canonicalShared,
                  cached.parts.fixture,
                ))
            ) {
              const fixture = await splitCache.refreshFixture(
                cached.key,
                preservePlayerMarketOdds(
                  canonicalShared,
                  cached.parts.fixture,
                ),
              );
              return { ...cached, parts: { ...cached.parts, fixture } };
            }
            const identityHydrated = hydrateConfirmedFixtureTeamIdentity(
              cached.parts.fixture,
              cached.playerRequest,
            );
            if (
              !identityHydrated ||
              identityHydrated === cached.parts.fixture
            ) {
              return cached;
            }
            const hydratedTeamSlug = identityHydrated.playerTeamSlug;
            if (!hydratedTeamSlug) return cached;
            const shared = await splitCache.getTeamFixture(
              cached.key,
              hydratedTeamSlug,
            );
            const candidate =
              shared && sameFixtureIdentity(shared, identityHydrated)
                ? preservePlayerMarketOdds(
                    shared,
                    cached.parts.fixture,
                  )
                : identityHydrated;
            const fixture = await splitCache.refreshFixture(
              cached.key,
              candidate,
            );
            return { ...cached, parts: { ...cached.parts, fixture } };
          }
          const shared = await splitCache.getTeamFixture(
            cached.key,
            cached.playerRequest.teamSlug,
          );
          return shared === undefined
            ? cached
            : { ...cached, parts: { ...cached.parts, fixture: shared } };
        }),
      );
      // Publish all available form/fixture snapshots before waiting on refresh
      // leases. A slow lease must not hide unrelated cache hits at the response
      // deadline. Fixture readiness stays pending until its check has settled.
      for (const { key, parts } of hydratedCachedParts) {
        if (!parts.form || !hasRequestedHistoricalWindows(parts.form, request.includeHistoricalAssists)) continue;
        cacheHits += 1;
        immediate.set(key, {
          ...parts.form,
          nextGame: parts.fixture ?? null,
          ...(parts.fixture !== null || unresolvedFixtureIdentities.has(key)
            ? { pendingRefreshes: ['fixture'] as PendingRefresh[] } : {}),
        });
      }
      progress.cacheHits = cacheHits;
      const claimedFixtureRefreshes = new Set<string>();
      await mapWithConcurrency(hydratedCachedParts, FIXTURE_REFRESH_CLAIM_CONCURRENCY, async ({ key, playerRequest, parts }) => {
        if (
          parts.form === undefined ||
          !hasRequestedHistoricalWindows(
            parts.form,
            request.includeHistoricalAssists,
          )
        ) {
          return;
        }
        if (parts.fixture !== undefined) {
          let fixtureRefreshDue = false;
          if (parts.fixture !== null) {
            const refreshKey = fixtureRefreshClaimKey(parts.fixture);
            if (!refreshKey || !claimedFixtureRefreshes.has(refreshKey)) {
              if (refreshKey) claimedFixtureRefreshes.add(refreshKey);
              fixtureRefreshDue = await splitCache.claimFixtureRefresh(
                parts.fixture,
              );
            }
          }
          immediate.set(key, {
            ...parts.form,
            nextGame: parts.fixture,
            ...(fixtureRefreshDue || unresolvedFixtureIdentities.has(key)
              ? { pendingRefreshes: ['fixture'] as PendingRefresh[] }
              : {}),
          });
          if (fixtureRefreshDue) {
            fixtureRefreshEntries.push({
              key,
              request: playerRequest,
              form: parts.form,
              existingFixture: parts.fixture,
            });
          }
        } else {
          immediate.set(key, {
            ...parts.form,
            nextGame: null,
            ...(this.scheduleBackground
              ? { pendingRefreshes: ['fixture'] as PendingRefresh[] }
              : {}),
          });
          fixtureRefreshEntries.push({
            key,
            request: playerRequest,
            form: parts.form,
          });
        }
      });
    } else {
      const cachedPlayers = await Promise.all(
        playerRequests.map(async (playerRequest) => {
          const key = cacheKey(playerRequest, this.excludeLowCoverage);
          return { key, cached: await this.cache.get(key) };
        }),
      );
      for (const { key, cached } of cachedPlayers) {
        if (
          cached &&
          hasRequestedHistoricalWindows(
            cached,
            request.includeHistoricalAssists,
          )
        ) {
          immediate.set(key, cached);
          cacheHits += 1;
        }
      }
    }
    const cacheDurationMs = elapsedMs(cacheStartedAt);
    progress.cacheHits = cacheHits;
    const baseAndHistoryStartedAt = performance.now();
    startStatsPhase(progress, 'baseAndHistory');

    if (
      (request.refreshFixtures || request.checkFixtureStatus) &&
      splitCache &&
      fixtureRefreshEntries.length > 0
    ) {
      const refreshedKeys = await this.hydrateFixturesForResponse(
        fixtureRefreshEntries,
        immediate,
        splitCache,
      );
      if (refreshedKeys.size > 0) {
        for (let index = fixtureRefreshEntries.length - 1; index >= 0; index -= 1) {
          const entry = fixtureRefreshEntries[index];
          if (entry && refreshedKeys.has(entry.key)) {
            fixtureRefreshEntries.splice(index, 1);
          }
        }
      }
    }

    const deferredCold = new Set<string>();
    const fresh = playerRequests.filter((playerRequest) => {
      const key = cacheKey(playerRequest, this.excludeLowCoverage);
      return (
        !immediate.has(key) &&
        !this.inFlight.has(
          inFlightKey(playerRequest, this.excludeLowCoverage),
        )
      );
    });

    if (fresh.length > 0) {
      const batchDeferred = new Set<string>();
      const batch = this.loadColdBatch(fresh, {
        allowPartialHistory: request.supportsPartialFormHistory,
        onLoaded: (key, stats) => immediate.set(key, stats),
        onDeferred: target => batchDeferred.add(cacheKey(target, this.excludeLowCoverage)),
      });
      for (const playerRequest of fresh) {
        const key = cacheKey(playerRequest, this.excludeLowCoverage);
        const pendingKey = inFlightKey(
          playerRequest,
          this.excludeLowCoverage,
        );
        const pending = batch.then((loaded) => ({stats: loaded.get(key), deferred: batchDeferred.has(key)}));
        this.inFlight.set(pendingKey, pending);
        void pending.then(
          () => this.inFlight.delete(pendingKey),
          () => this.inFlight.delete(pendingKey),
        );
      }
    }

    let firstColdLoadError: unknown;
    let cachedOrLoaded = (
      await Promise.all(
        playerRequests.map(async (playerRequest) => {
          const key = cacheKey(playerRequest, this.excludeLowCoverage);
          const cached = immediate.get(key);
          if (cached) return cached;
          try {
            const outcome = await this.inFlight.get(
              inFlightKey(playerRequest, this.excludeLowCoverage),
            );
            if (outcome?.deferred) deferredCold.add(key);
            if (outcome?.stats) immediate.set(key, outcome.stats);
            return outcome?.stats;
          } catch (error) {
            // A failed cold player must not discard unrelated cache hits or
            // successfully loaded players from the same API response.
            firstColdLoadError ??= error;
            return immediate.get(key);
          }
        }),
      )
    ).filter((stats): stats is PlayerStats => Boolean(stats));
    if (
      cachedOrLoaded.length === 0 &&
      firstColdLoadError !== undefined &&
      nameResolution.deferred.length === 0
    ) {
      throw firstColdLoadError;
    }
    cachedOrLoaded = await this.recoverUnconfirmedNameResolutions(
      playerRequests,
      cachedOrLoaded,
      request.positions,
      request.playerTeams,
      request.includeHistoricalAssists,
      request.supportsPartialFormHistory,
      (oldStats, replacement) => {
        const replace = (targets: SourcePlayerRequest[]) => {
          for (let index = 0; index < targets.length; index++) {
            const target = targets[index]!;
            if (target.slug !== oldStats.slug || (target.position && target.position !== oldStats.position)) continue;
            immediate.delete(cacheKey(target, this.excludeLowCoverage));
            targets[index] = {...replacement, ...(target.resolvedFromName ? {resolvedFromName: target.resolvedFromName} : {})};
          }
        };
        replace(playerRequests);
        replace(progress.requests);
        deferredCold.add(cacheKey(replacement, this.excludeLowCoverage));
      },
      (key, stats) => {
        immediate.set(key, stats);
        deferredCold.delete(key);
      },
    );
    const fixtureIdentityRequests = playerRequests.filter(playerRequest =>
      !unresolvedFixtureIdentities.has(cacheKey(playerRequest, this.excludeLowCoverage)),
    );
    if (splitCache) {
      cachedOrLoaded = await this.hydrateCachedTeamFixtures(
        cachedOrLoaded,
        fixtureIdentityRequests,
        splitCache,
      );
    }
    const baseAndHistoryDurationMs = elapsedMs(baseAndHistoryStartedAt);
    const resultStartedAt = performance.now();
    startStatsPhase(progress, 'result');
    cachedOrLoaded = harmonizePlayerTeamFixtures(
      cachedOrLoaded,
      fixtureIdentityRequests,
    );
    for (const target of progress.requests) {
      const stats = cachedOrLoaded.find(player => player.slug === target.slug && (!target.position || player.position === target.position));
      if (stats) immediate.set(cacheKey(target, this.excludeLowCoverage), stats);
    }
    const oddsEligiblePlayers = cachedOrLoaded.filter(
      (stats) => playerMarketOddsSupported(this.marketOddsProvider, stats),
    );
    const marketRefreshDuePlayerKeys = new Set<string>();
    const marketRefreshDueState = { complete: false };
    const marketCacheOnlyBudgetMs = this.cacheOnlyOddsReadBudgetMs(
      request.oddsCacheOnly,
      oddsEligiblePlayers.length,
    );
    const cacheOnlyOddsDeadlineMs = Date.now() + marketCacheOnlyBudgetMs;
    const fixtureCacheReadState = { complete: false };
    const marketCacheReadState = { complete: false };
    const [fixtureMatchOdds, marketOdds] = await Promise.all([
      this.loadCacheOnlyWithinBudget(
        this.fixtureMatchOddsProvider.load(cachedOrLoaded, {
          cacheOnly: true,
        }),
        this.cacheOnlyOddsBudgetMs,
        fixtureCacheReadState,
      ),
      this.loadCacheOnlyWithinBudget(
        this.marketOddsProvider.load(oddsEligiblePlayers, {
          cacheOnly: true,
          cacheOnlyDeadlineMs: cacheOnlyOddsDeadlineMs,
          refreshDuePlayerKeys: marketRefreshDuePlayerKeys,
          refreshDueState: marketRefreshDueState,
        }),
        marketCacheOnlyBudgetMs,
        marketCacheReadState,
      ),
    ]);
    const playersWithFixtureRefresh = new Set(
      fixtureRefreshEntries.map(({ request, form }) =>
        playerMarketOddsKey({
          slug: request.slug,
          position: request.position ?? form.position,
        }),
      ),
    );
    const marketRefreshPlayers: PlayerStats[] = [];
    const marketPriceRefreshPlayers: PlayerStats[] = [];
    const fixturePriceRefreshPlayerKeys = new Set<string>();
    const matchOddsRefreshPlayers: PlayerStats[] = [];
    const canScheduleOddsRefresh =
      Boolean(this.scheduleBackground) && !request.oddsCacheOnly;
    const marketStateByPlayer = new Map(
      cachedOrLoaded.map((stats) => {
        const key = playerMarketOddsKey(stats);
        const supportsMarketOdds = playerMarketOddsSupported(
          this.marketOddsProvider,
          stats,
        );
        const odds = supportsMarketOdds ? marketOdds.get(key) ?? null : null;
        const missingRequestDrivingMarket = (
          ['goal', 'assist'] as const
        ).some(
          (market) =>
            playerMarketFieldDrivesRequest(
              this.marketOddsProvider,
              stats,
              market,
            ) && !odds?.[market],
        );
        const missingDisplayedMarket = (['goal', 'assist'] as const).some(
          (market) =>
            playerMarketFieldSupported(
              this.marketOddsProvider,
              stats,
              market,
            ) && !odds?.[market],
        );
        const needsMarketOddsRefresh =
          missingRequestDrivingMarket &&
          (this.marketOddsProvider.reportsRefreshDue === true &&
          marketRefreshDueState.complete
            ? marketRefreshDuePlayerKeys.has(key)
            : true);
        const needsMarketPriceRefresh =
          Boolean(odds?.goal || odds?.assist || odds?.decisive) &&
          this.marketOddsProvider.refreshCachedPrices !== undefined &&
          this.marketOddsProvider.reportsRefreshDue === true &&
          marketRefreshDueState.complete &&
          marketRefreshDuePlayerKeys.has(key);
        return [
          key,
          {
            supportsMarketOdds,
            odds,
            missingDisplayedMarket,
            needsMarketOddsRefresh,
            needsMarketPriceRefresh,
            fixtureKey: stats.nextGame
              ? marketFixtureKey(stats.nextGame)
              : null,
          },
        ] as const;
      }),
    );
    const warmingFixtureKeys = new Set(
      [...marketStateByPlayer.values()].flatMap((state) =>
        (state.needsMarketOddsRefresh || state.needsMarketPriceRefresh) &&
        state.fixtureKey
          ? [state.fixtureKey]
          : [],
      ),
    );
    const data = cachedOrLoaded.map((stats): PlayerStats => {
      const pending = new Set<PendingRefresh>(
        stats.pendingRefreshes ?? [],
      );
      const key = playerMarketOddsKey(stats);
      const marketState = marketStateByPlayer.get(key);
      const supportsMarketOdds = marketState?.supportsMarketOdds ?? false;
      const odds = marketState?.odds ?? null;
      const needsMarketOddsRefresh =
        marketState?.needsMarketOddsRefresh ?? false;
      const needsMarketPriceRefresh =
        marketState?.needsMarketPriceRefresh ?? false;
      const sharesWarmingFixture = Boolean(
        marketState?.missingDisplayedMarket &&
          marketState.fixtureKey &&
          warmingFixtureKeys.has(marketState.fixtureKey),
      );
      const fallbackFixtureOdds = fixtureMatchOdds.get(key) ?? null;
      const nextGame = stats.nextGame
        ? {
            ...stats.nextGame,
            cleanSheetProbability:
              stats.nextGame.cleanSheetProbability ??
              fallbackFixtureOdds?.cleanSheetProbability ??
              null,
            matchProbabilities: mergeMatchProbabilities(
              stats.nextGame.matchProbabilities,
              fallbackFixtureOdds
                ? {
                    win: fallbackFixtureOdds.win,
                    draw: fallbackFixtureOdds.draw,
                    loss: fallbackFixtureOdds.loss,
                  }
                : null,
            ),
            marketOdds: odds,
          }
        : null;
      const statsWithFallback = { ...stats, nextGame };
      // Cache timeouts are not proof of a missing market. The compact sort
      // client must retry the read, without starting any bookmaker request.
      if (request.oddsCacheOnly && supportsMarketOdds && !marketCacheReadState.complete && !odds?.goal) pending.add('marketOdds');
      if (request.oddsCacheOnly && !fixtureCacheReadState.complete &&
          (stats.position === 'Goalkeeper' || stats.position === 'Defender') &&
          nextGame && nextGame.cleanSheetProbability === null) pending.add('fixture');
      if (
        canScheduleOddsRefresh &&
        supportsMarketOdds &&
        (needsMarketOddsRefresh ||
          needsMarketPriceRefresh ||
          sharesWarmingFixture)
      ) {
        pending.add('marketOdds');
        if (
          needsMarketOddsRefresh &&
          !playersWithFixtureRefresh.has(key)
        ) {
          marketRefreshPlayers.push(stats);
        }
        if (needsMarketPriceRefresh) {
          if (playersWithFixtureRefresh.has(key)) {
            fixturePriceRefreshPlayerKeys.add(key);
          } else {
            marketPriceRefreshPlayers.push(stats);
          }
        }
      }
      if (
        canScheduleOddsRefresh &&
        this.fixtureMatchOddsProvider.supports(statsWithFallback) &&
        needsFixtureTeamOddsFallback(statsWithFallback)
      ) {
        pending.add('fixture');
        if (!playersWithFixtureRefresh.has(key)) {
          matchOddsRefreshPlayers.push(statsWithFallback);
        }
      }
      return {
        ...stats,
        nextGame,
        ...(pending.size > 0
          ? { pendingRefreshes: [...pending] }
          : { pendingRefreshes: undefined }),
      };
    });

    if (this.scheduleBackground) {
      const tasks: Promise<void>[] = [];
      if (!request.oddsCacheOnly && fixtureRefreshEntries.length > 0) {
        tasks.push(
          this.refreshFixtures(
            fixtureRefreshEntries,
            fixturePriceRefreshPlayerKeys,
          ),
        );
      }
      if (canScheduleOddsRefresh && marketRefreshPlayers.length > 0) {
        tasks.push(
          this.marketOddsProvider
            .load(marketRefreshPlayers)
            .then(() => undefined),
        );
      }
      if (
        canScheduleOddsRefresh &&
        marketPriceRefreshPlayers.length > 0 &&
        this.marketOddsProvider.refreshCachedPrices
      ) {
        tasks.push(
          this.marketOddsProvider.refreshCachedPrices(
            marketPriceRefreshPlayers,
          ),
        );
      }
      if (canScheduleOddsRefresh && matchOddsRefreshPlayers.length > 0) {
        tasks.push(
          this.fixtureMatchOddsProvider
            .load(matchOddsRefreshPlayers)
            .then(() => undefined),
        );
      }
      if (tasks.length > 0) {
        this.scheduleBackground(
          Promise.allSettled(tasks).then(() => undefined),
        );
      }
    }

    const resultDurationMs = elapsedMs(resultStartedAt);
    const partialHistories = data.filter((stats) =>
      stats.pendingRefreshes?.includes('formHistory'),
    ).length;
    const deferredRequests = progress.requests.filter(target =>
      deferredCold.has(cacheKey(target, this.excludeLowCoverage)));
    const deferredPlayerNames = [...new Set([
      ...nameResolution.deferred,
      ...deferredRequests.flatMap(target => target.resolvedFromName ? [target.resolvedFromName] : []),
    ])];
    const deferredPlayerSlugs = request.slugs.filter(slug =>
      deferredRequests.some(target => target.slug === slug));
    return {
      data,
      cacheHits,
      source: this.dataSource.source,
      deferredPlayerNames,
      deferredPlayerSlugs,
      diagnostics: {
        requestedPlayers:
          request.slugs.length + request.playerNames.length,
        resolvedPlayers: playerRequests.length,
        returnedPlayers: data.length,
        cacheHits,
        deferredNames: deferredPlayerNames.length,
        partialHistories,
        responseBudgetExceeded: false,
        durationsMs: {
          nameResolution: nameResolutionDurationMs,
          cache: cacheDurationMs,
          baseAndHistory: baseAndHistoryDurationMs,
          result: resultDurationMs,
          total: elapsedMs(requestStartedAt),
        },
      },
    };
  }

  private async loadCacheOnlyWithinBudget<T>(
    pending: Promise<Map<string, T>>,
    budgetMs = this.cacheOnlyOddsBudgetMs,
    readState?: { complete: boolean },
  ): Promise<Map<string, T>> {
    const result = await settleWithin(pending, budgetMs);
    if (result.status === 'fulfilled') {
      if (readState) readState.complete = true;
      return result.value;
    }
    return new Map();
  }

  private cacheOnlyOddsReadBudgetMs(
    explicitCacheOnly: boolean,
    playerCount: number,
  ): number {
    if (!explicitCacheOnly || playerCount <= 1) {
      return this.cacheOnlyOddsBudgetMs;
    }
    // A lineup-sort request may carry fifty players through several nested
    // snapshot stores. The former fixed 350 ms window could discard the
    // complete market map even when every requested quote was already cached.
    // Scale only explicit cache-only batches; normal card responses keep the
    // short path and no external provider work is enabled by this extra time.
    const scaledBudgetMs =
      this.cacheOnlyOddsBudgetMs +
      (playerCount - 1) * CACHE_ONLY_ODDS_BATCH_EXTRA_PER_PLAYER_MS;
    return Math.max(
      this.cacheOnlyOddsBudgetMs,
      Math.min(CACHE_ONLY_ODDS_BATCH_MAX_MS, scaledBudgetMs),
    );
  }

  private async resolveNamesForResponse(
    names: readonly string[],
    positions: Readonly<Record<string, FootballPosition>> | undefined,
    teamSlugs: Readonly<Record<string, string>> | undefined,
    includeHistoricalAssists: boolean,
  ): Promise<{
    resolved: SourcePlayerRequest[];
    deferred: string[];
  }> {
    if (names.length === 0) return { resolved: [], deferred: [] };
    if (!this.scheduleBackground) {
      return {
        resolved: teamSlugs
          ? await this.dataSource.resolvePlayerNames(names, positions, {
              teamSlugs,
            })
          : await this.dataSource.resolvePlayerNames(names, positions),
        deferred: [],
      };
    }

    const cached = await this.dataSource.resolvePlayerNames(
      names,
      positions,
      { cacheOnly: true, ...(teamSlugs ? { teamSlugs } : {}) },
    );
    const cachedNames = new Set(
      cached.flatMap((request) =>
        request.resolvedFromName
          ? [request.resolvedFromName.toLocaleLowerCase()]
          : [],
      ),
    );
    const missing = names.filter(
      (name) => !cachedNames.has(name.toLocaleLowerCase()),
    );
    if (missing.length === 0) return { resolved: cached, deferred: [] };

    const pending = this.dataSource.resolvePlayerNames(missing, positions, {
      ...(teamSlugs ? { teamSlugs } : {}),
    });
    const result = await settleWithin(pending, this.nameResolutionBudgetMs);
    if (result.status === 'fulfilled') {
      return {
        resolved: [...cached, ...result.value],
        deferred: [],
      };
    }

    if (result.status === 'timed-out') {
      this.scheduleBackground(
        pending.then((resolved) =>
          this.warmResolvedPlayers(resolved, includeHistoricalAssists),
        ),
      );
    }
    return { resolved: cached, deferred: [...missing] };
  }

  private async warmResolvedPlayers(
    resolved: readonly SourcePlayerRequest[],
    includeHistoricalAssists: boolean,
  ): Promise<void> {
    const requests = [
      ...new Map(
        resolved.map((request) => {
          const warmed = {
            ...request,
            ...(includeHistoricalAssists
              ? { includeHistoricalAssists: true }
              : {}),
          };
          return [
            `${warmed.slug}:${warmed.position ?? 'default'}`,
            warmed,
          ] as const;
        }),
      ).values(),
    ];
    // Small isolated chunks preserve Sorare's invalid-player splitting while
    // avoiding one full request and history fan-out per resolved card.
    await mapSettledWithConcurrency(
      chunks(requests, BACKGROUND_PLAYER_LOAD_CHUNK_SIZE),
      BACKGROUND_PLAYER_LOAD_CONCURRENCY,
      (batch) =>
        this.loadColdBatch(batch, {
          completeHistory: true,
          overwriteForm: true,
          scheduleHistoryCompletion: false,
        }),
    );
  }

  private async recoverUnconfirmedNameResolutions(
    playerRequests: readonly SourcePlayerRequest[],
    loadedStats: readonly PlayerStats[],
    positions: Readonly<Record<string, FootballPosition>> | undefined,
    teamSlugs: Readonly<Record<string, string>> | undefined,
    includeHistoricalAssists: boolean,
    allowPartialHistory: boolean,
    onReplacement?: (previous: PlayerStats, request: SourcePlayerRequest) => void,
    onLoaded?: (key: string, stats: PlayerStats) => void,
  ): Promise<PlayerStats[]> {
    const statsByExactPlayer = new Map(
      loadedStats.map((stats) => [
        `${stats.slug}:${stats.position}`,
        stats,
      ]),
    );
    const firstStatsBySlug = new Map<string, PlayerStats>();
    for (const stats of loadedStats) {
      if (!firstStatsBySlug.has(stats.slug)) {
        firstStatsBySlug.set(stats.slug, stats);
      }
    }
    const unconfirmedNameMatches = playerRequests.flatMap((playerRequest) => {
      if (
        !playerRequest.resolvedFromName ||
        playerRequest.nameResolution === 'search'
      ) {
        return [];
      }
      const stats = playerRequest.position
        ? statsByExactPlayer.get(
            `${playerRequest.slug}:${playerRequest.position}`,
          )
        : firstStatsBySlug.get(playerRequest.slug);
      return stats &&
        !stats.pendingRefreshes?.includes('formHistory') &&
        (hasNoUsablePlayerData(stats) ||
          // Legacy name-cache entries may predate resolution provenance. Old
          // appearances do not establish identity when neither club nor next
          // game is known. Search once, even if historical sampleSize > 0.
          (!playerRequest.teamSlug && stats.nextGame === null))
        ? [{ playerRequest, stats }]
        : [];
    });
    if (unconfirmedNameMatches.length === 0) return [...loadedStats];
    const replacedStats = new Set<PlayerStats>();

    try {
      const names = [
        ...new Set(
          unconfirmedNameMatches.map(
            ({ playerRequest }) => playerRequest.resolvedFromName!,
          ),
        ),
      ];
      const searched = await this.dataSource.resolvePlayerNames(
        names,
        positions,
        { forceSearch: true, ...(teamSlugs ? { teamSlugs } : {}) },
      );
      const searchedByName = new Map(
        searched.flatMap((resolved) =>
          resolved.resolvedFromName
            ? [[resolved.resolvedFromName, resolved] as const]
            : [],
        ),
      );
      const replacements = new Map<PlayerStats, SourcePlayerRequest>();
      for (const { playerRequest, stats } of unconfirmedNameMatches) {
        const corrected = searchedByName.get(playerRequest.resolvedFromName!);
        if (!corrected || corrected.slug === playerRequest.slug) continue;
        replacements.set(stats, {
          ...corrected,
          ...(includeHistoricalAssists
            ? { includeHistoricalAssists: true }
            : {}),
        });
      }
      if (replacements.size === 0) return [...loadedStats];
      for (const [previous, replacement] of replacements) {
        replacedStats.add(previous);
        onReplacement?.(previous, replacement);
      }

      const correctedRequests = [
        ...new Map(
          [...replacements.values()].map((request) => [
            `${request.slug}:${request.position ?? 'default'}`,
            request,
          ]),
        ).values(),
      ];
      const corrected = await this.loadColdBatch(correctedRequests, {
        allowPartialHistory,
        ...(onLoaded ? {onLoaded} : {}),
      });
      return loadedStats.flatMap((stats) => {
        const correctedRequest = replacements.get(stats);
        if (!correctedRequest) return [stats];
        const replacement = corrected.get(cacheKey(correctedRequest, this.excludeLowCoverage));
        return replacement ? [replacement] : [];
      });
    } catch {
      // Name correction is best effort. A failed search or replacement fetch
      // must never discard unrelated cache hits from the current response.
      return loadedStats.filter(stats => !replacedStats.has(stats));
    }
  }

  private async hydrateCachedTeamFixtures(
    players: readonly PlayerStats[],
    requests: readonly SourcePlayerRequest[],
    splitCache: SplitPlayerStatsCacheAccess,
  ): Promise<PlayerStats[]> {
    const requestByPlayer = new Map(
      requests.flatMap((request) => {
        const entries: Array<readonly [string, SourcePlayerRequest]> = [
          [`${request.slug}:default`, request] as const,
        ];
        if (request.position) {
          entries.push([`${request.slug}:${request.position}`, request]);
        }
        return entries;
      }),
    );
    const lookups = new Map<
      string,
      { playerCacheKey: string; teamSlug: string }
    >();
    for (const player of players) {
      if (player.nextGame !== null) continue;
      const request =
        requestByPlayer.get(`${player.slug}:${player.position}`) ??
        requestByPlayer.get(`${player.slug}:default`);
      if (!request?.teamSlug || lookups.has(request.teamSlug)) continue;
      lookups.set(request.teamSlug, {
        playerCacheKey: cacheKey(request, this.excludeLowCoverage),
        teamSlug: request.teamSlug,
      });
    }
    if (lookups.size === 0) return [...players];

    const sharedByTeam = new Map(
      (
        await Promise.all(
          [...lookups.values()].map(async ({ playerCacheKey, teamSlug }) => [
            teamSlug,
            await splitCache.getTeamFixture(playerCacheKey, teamSlug),
          ] as const),
        )
      ).filter(
        (entry): entry is readonly [string, NonNullable<PlayerStats['nextGame']>] =>
          entry[1] !== undefined && entry[1] !== null,
      ),
    );

    return players.map((player) => {
      if (player.nextGame !== null) return player;
      const request =
        requestByPlayer.get(`${player.slug}:${player.position}`) ??
        requestByPlayer.get(`${player.slug}:default`);
      const shared = request?.teamSlug
        ? sharedByTeam.get(request.teamSlug)
        : undefined;
      if (!shared) return player;
      const { marketOdds: _marketOdds, ...teamFixture } = shared;
      return {
        ...player,
        nextGame: { ...teamFixture, marketOdds: null },
      };
    });
  }

  private async hydrateFixturesForResponse(
    entries: readonly FixtureRefreshEntry[],
    immediate: Map<string, PlayerStats>,
    splitCache: SplitPlayerStatsCacheAccess,
  ): Promise<Set<string>> {
    try {
      const requests = [
        ...new Map(
          entries.map(({ request }) => [
            `${request.slug}:${request.position ?? 'default'}`,
            request,
          ]),
        ).values(),
      ];
      const fixtures = await this.dataSource.fetchNextGames(requests);
      const fixtureBySlug = new Map(fixtures.map((fixture) => [fixture.slug, fixture]));
      const refreshedKeys = new Set<string>();
      for (const { key, request, form, existingFixture } of entries) {
        if (!fixtureBySlug.has(request.slug)) continue;
        const sourceFixture = fixtureBySlug.get(request.slug);
        let nextGame: PlayerStats['nextGame'] =
          sourceFixture?.nextGame ?? null;
        let borrowedTeamFixture = false;
        if (nextGame === null && sourceFixture?.playerTeamSlug) {
          const shared = await splitCache.getTeamFixture(
            key,
            sourceFixture.playerTeamSlug,
          );
          if (shared !== undefined && shared !== null) {
            nextGame = shared;
            borrowedTeamFixture = true;
          }
        }
        const resolvedNextGame = borrowedTeamFixture
          ? nextGame
          : existingFixture === undefined || existingFixture === null
            ? await splitCache.setFixture(key, nextGame)
            : await splitCache.refreshFixture(key, nextGame);
        immediate.set(key, { ...form, nextGame: resolvedNextGame });
        refreshedKeys.add(key);
      }
      return refreshedKeys;
    } catch {
      // Keep the already available form values and the pending-refresh hint.
      // The extension can retry without turning a fixture outage into a full
      // player-statistics error.
      return new Set();
    }
  }

  private async refreshFixtures(
    entries: FixtureRefreshEntry[],
    priceRefreshPlayerKeys: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    const splitCache = supportsSplitPlayerStatsCache(this.cache)
      ? this.cache
      : undefined;
    if (!splitCache) return;
    const requests = [
      ...new Map(
        entries.map(({ request }) => [
          `${request.slug}:${request.position ?? 'default'}`,
          request,
        ]),
      ).values(),
    ];
    let fixtureBySlug = new Map<string, SourcePlayerFixture>();
    try {
      const fixtures = await this.dataSource.fetchNextGames(requests);
      fixtureBySlug = new Map(fixtures.map((fixture) => [fixture.slug, fixture]));
    } catch {
      // A temporary Sorare fixture error must not suppress bookmaker refreshes
      // for the last authoritative fixture already held in the cache.
    }
    const refreshedPlayers = (
      await Promise.all(
        entries.map(async ({ key, request, form, existingFixture }) => {
          if (!fixtureBySlug.has(request.slug)) {
            return existingFixture === undefined
              ? null
              : { ...form, nextGame: existingFixture };
          }
          const sourceFixture = fixtureBySlug.get(request.slug);
          let nextGame: PlayerStats['nextGame'] =
            sourceFixture?.nextGame ?? null;
          let borrowedTeamFixture = false;
          if (nextGame === null && sourceFixture?.playerTeamSlug) {
            const shared = await splitCache.getTeamFixture(
              key,
              sourceFixture.playerTeamSlug,
            );
            if (shared !== undefined && shared !== null) {
              nextGame = shared;
              borrowedTeamFixture = true;
            }
          }
          try {
            const resolvedNextGame = borrowedTeamFixture
              ? nextGame
              : existingFixture === undefined || existingFixture === null
                ? await splitCache.setFixture(key, nextGame)
                : await splitCache.refreshFixture(key, nextGame);
            return { ...form, nextGame: resolvedNextGame };
          } catch {
            const fetchedDifferentFixture =
              existingFixture !== undefined &&
              existingFixture !== null &&
              nextGame !== null &&
              !sameFixtureIdentity(existingFixture, nextGame);
            // Once Sorare has identified a different fixture, a failed cache
            // write must not send the previous fixture to bookmaker providers.
            // A cache that intentionally holds the current fixture until the
            // following morning returns that fixture successfully above, so
            // the established rollover policy remains unchanged.
            if (fetchedDifferentFixture) return null;
            return existingFixture === undefined
              ? null
              : { ...form, nextGame: existingFixture };
          }
        }),
      )
    ).filter((player): player is PlayerStats => player !== null);
    const oddsEligible = refreshedPlayers.filter(
      (stats) => playerMarketOddsSupported(this.marketOddsProvider, stats),
    );
    const priceRefreshEligible = this.marketOddsProvider.refreshCachedPrices
      ? refreshedPlayers.filter((stats) =>
          priceRefreshPlayerKeys.has(playerMarketOddsKey(stats)),
        )
      : [];
    const matchOddsEligible = refreshedPlayers.filter(
      (stats) =>
        this.fixtureMatchOddsProvider.supports(stats) &&
        needsFixtureTeamOddsFallback(stats),
    );
    await Promise.allSettled([
      oddsEligible.length > 0
        ? this.marketOddsProvider.load(oddsEligible).then(() => undefined)
        : Promise.resolve(),
      priceRefreshEligible.length > 0 &&
      this.marketOddsProvider.refreshCachedPrices
        ? this.marketOddsProvider.refreshCachedPrices(priceRefreshEligible)
        : Promise.resolve(),
      matchOddsEligible.length > 0
        ? this.fixtureMatchOddsProvider
            .load(matchOddsEligible)
            .then(() => undefined)
        : Promise.resolve(),
    ]);
  }

  private async loadColdBatch(
    requests: SourcePlayerRequest[],
    options: LoadBatchOptions,
  ): Promise<Map<string, PlayerStats>> {
    if (!this.playerLoadLeases) return this.loadBatch(requests, options);
    const leases = this.playerLoadLeases;
    const owner = crypto.randomUUID();
    const claimed: Array<{request: SourcePlayerRequest; leaseKey: string}> = [];
    const result = new Map<string, PlayerStats>();
    try {
      const admissions = await Promise.allSettled(requests.map(async request => {
        const key = cacheKey(request, this.excludeLowCoverage);
        const leaseKey = inFlightKey(request, this.excludeLowCoverage);
        const admitted = await leases.claim(leaseKey, owner);
        if (admitted) claimed.push({request, leaseKey});
        // Recheck after admission: another owner may just have filled the cache.
        const cached = await this.cache.get(key);
        if (cached && hasRequestedHistoricalWindows(cached, request.includeHistoricalAssists === true)) {
          result.set(key, cached);
          options.onLoaded?.(key, cached);
        } else if (!admitted) options.onDeferred?.(request);
      }));
      const failed = admissions.find(entry => entry.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      const toLoad = claimed.map(entry => entry.request).filter(request => !result.has(cacheKey(request, this.excludeLowCoverage)));
      if (toLoad.length) {
        for (const [key, stats] of await this.loadBatch(toLoad, options)) result.set(key, stats);
      }
      await Promise.all(claimed.filter(entry => {
        const stats = result.get(cacheKey(entry.request, this.excludeLowCoverage));
        return !stats || stats.pendingRefreshes?.includes('formHistory');
      }).map(entry => leases.release(entry.leaseKey, owner)));
      // Retain successful claims until expiry: Cloudflare cache writes may
      // still be in waitUntil. Followers use cached results or defer briefly.
      return result;
    } catch (error) {
      await Promise.allSettled(claimed.map(entry => leases.release(entry.leaseKey, owner)));
      throw error;
    }
  }

  private async loadBatch(
    requests: SourcePlayerRequest[],
    options: LoadBatchOptions = {},
  ): Promise<Map<string, PlayerStats>> {
    const allowPartialHistory = options.allowPartialHistory === true;
    const useBasePath =
      allowPartialHistory &&
      !options.completeHistory &&
      Boolean(this.scheduleBackground) &&
      this.dataSource.fetchPlayersBase !== undefined;
    const players = useBasePath
      ? await this.dataSource.fetchPlayersBase!(requests)
      : await this.dataSource.fetchPlayers(requests);
    const splitCache = supportsSplitPlayerStatsCache(this.cache)
      ? this.cache
      : undefined;
    const requestByResultKey = new Map(
      requests.map((request) => [`${request.slug}:${request.position ?? 'default'}`, request]),
    );
    const result = new Map<string, PlayerStats>();
    const partialRequests: SourcePlayerRequest[] = [];

    for (const player of players) {
      const requested =
        requestByResultKey.get(`${player.slug}:${player.position}`) ??
        requestByResultKey.get(`${player.slug}:default`);
      if (!requested) continue;
      const stats = this.toPlayerStats(
        player,
        requested.position ?? player.position,
        requested.includeHistoricalAssists === true,
      );
      const key = cacheKey(requested, this.excludeLowCoverage);
      const historyIsPartial = player.historyStatus === 'partial';
      if (historyIsPartial && !allowPartialHistory) {
        // Old clients do not understand the `formHistory` capability. Keep
        // the failure isolated to this player rather than returning an
        // apparently complete short form or breaking the entire batch.
        continue;
      }
      let storedStats = stats;
      if (historyIsPartial) {
        storedStats = {
          ...stats,
          pendingRefreshes: ['formHistory'],
        };
        if (splitCache) {
          const resolvedNextGame = await splitCache.setFixture(
            key,
            stats.nextGame,
          );
          storedStats = { ...storedStats, nextGame: resolvedNextGame };
        }
        partialRequests.push(requested);
      } else if (options.overwriteForm && splitCache) {
        const {
          nextGame,
          pendingRefreshes: _pendingRefreshes,
          mlsAaContext: _mlsAaContext,
          ...form
        } = stats;
        const resolvedNextGame = await splitCache.setFixture(key, nextGame);
        await splitCache.setForm(key, form);
        storedStats = { ...form, nextGame: resolvedNextGame };
      } else if (options.overwriteForm) {
        await this.cache.set(key, stats);
      } else if (requested.includeHistoricalAssists && splitCache) {
        const resolvedNextGame = await splitCache.setFixture(
          key,
          stats.nextGame,
        );
        storedStats = { ...stats, nextGame: resolvedNextGame };
        await this.cache.set(key, storedStats);
      } else if (requested.includeHistoricalAssists) {
        await this.cache.set(key, stats);
      } else if (this.cache.fillMissing) {
        storedStats = await this.cache.fillMissing(key, stats);
      } else {
        await this.cache.set(key, stats);
      }
      result.set(key, storedStats);
      options.onLoaded?.(key, storedStats);
    }
    if (
      partialRequests.length > 0 &&
      options.scheduleHistoryCompletion !== false
    ) {
      this.scheduleHistoryCompletion(partialRequests);
    }
    return result;
  }

  private scheduleHistoryCompletion(
    requests: readonly SourcePlayerRequest[],
  ): void {
    if (!this.scheduleBackground) return;
    const unique = [
      ...new Map(
        requests.map((request) => [
          inFlightKey(request, this.excludeLowCoverage),
          request,
        ]),
      ).values(),
    ];
    const splitCache = supportsSplitPlayerStatsCache(this.cache)
      ? this.cache
      : undefined;
    this.scheduleBackground(
      mapSettledWithConcurrency(
        unique,
        HISTORY_COMPLETION_CONCURRENCY,
        async (request) => {
          const refreshKey = inFlightKey(
            request,
            this.excludeLowCoverage,
          );
          const claimed =
            splitCache === undefined ||
            (await splitCache.claimFormHistoryRefresh(refreshKey));
          if (!claimed) return;
          try {
            const loaded = await this.loadBatch([request], {
              allowPartialHistory: true,
              completeHistory: true,
              overwriteForm: true,
              scheduleHistoryCompletion: false,
            });
            const stats = loaded.get(
              cacheKey(request, this.excludeLowCoverage),
            );
            if (!stats || stats.pendingRefreshes?.includes('formHistory')) {
              throw new Error('Player form history remained incomplete');
            }
          } catch (error) {
            if (splitCache) {
              await splitCache.releaseFormHistoryRefresh(refreshKey);
            }
            throw error;
          }
        },
      ).then((settled) => {
        const failed = settled.filter(
          (entry) => entry.status === 'rejected',
        ).length;
        if (failed > 0) {
          throw new Error(
            `${failed} player form history refreshes remained incomplete`,
          );
        }
      }),
    );
  }

  private toPlayerStats(
    player: SourcePlayer,
    position: FootballPosition,
    includeHistoricalAssists: boolean,
  ): PlayerStats {
    const options = { excludeLowCoverage: this.excludeLowCoverage, limit: 10 };
    const metrics = calculatePlayerMetrics(player.appearances, position, options);
    const goalProbability = this.goalscorerProvider.calculate(
      player.appearances,
      position,
      options,
    );
    return {
      slug: player.slug,
      displayName: player.displayName,
      position,
      aaL10: metrics.aaL10,
      aaL10TeamWinRate: metrics.aaL10TeamWinRate,
      cleanSheetL10: metrics.cleanSheetL10,
      goalL10: goalProbability.metric,
      ...(includeHistoricalAssists && player.historyStatus !== 'partial'
        ? {
            historicalGoals: calculateHistoricalGoalMetrics(
              player.appearances,
              position,
              this.excludeLowCoverage,
            ),
            historicalAssists: calculateHistoricalAssistMetrics(
              player.appearances,
              position,
              this.excludeLowCoverage,
            ),
            historicalDecisives: calculateHistoricalDecisiveMetrics(
              player.appearances,
              position,
              this.excludeLowCoverage,
            ),
          }
        : {}),
      nextGame: player.nextGame,
      excludedLowCoverage: metrics.excludedLowCoverage,
    };
  }
}
