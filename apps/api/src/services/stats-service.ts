import {
  calculateHistoricalAssistMetrics,
  calculateHistoricalDecisiveMetrics,
  calculateHistoricalGoalMetrics,
  calculatePlayerMetrics,
  type FootballPosition,
  type PlayerStats,
  type ValidatedPlayerStatsRequest,
} from '@sorare-overlay/shared';
import {
  supportsSplitPlayerStatsCache,
  type Cache,
  type PlayerFormStats,
  type SplitPlayerStatsCacheAccess,
} from '../cache.js';
import {
  playerMarketFieldDrivesRequest,
  playerMarketFieldSupported,
  playerMarketOddsKey,
  playerMarketOddsSupported,
  type PlayerMarketOddsProvider,
} from '../providers/market-odds-provider.js';
import type { GoalscorerProbabilityProvider } from '../providers/goalscorer-provider.js';
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

export interface StatsServiceResult {
  data: PlayerStats[];
  cacheHits: number;
  source: 'sorare' | 'mock';
  deferredPlayerNames: string[];
  diagnostics: {
    requestedPlayers: number;
    resolvedPlayers: number;
    returnedPlayers: number;
    cacheHits: number;
    deferredNames: number;
    partialHistories: number;
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

function needsMatchProbabilitiesFallback(stats: PlayerStats): boolean {
  if (!stats.nextGame) return false;
  const probabilities = stats.nextGame.matchProbabilities;
  return (
    (probabilities === null ||
      probabilities.win === null ||
      probabilities.draw === null ||
      probabilities.loss === null)
  );
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

type PendingRefresh = 'formHistory' | 'fixture' | 'marketOdds';

interface FixtureRefreshEntry {
  key: string;
  request: SourcePlayerRequest;
  form: PlayerFormStats;
  existingFixture?: PlayerStats['nextGame'];
}

export type BackgroundTaskScheduler = (task: Promise<void>) => void;
export const DEFAULT_NAME_RESOLUTION_BUDGET_MS = 650;

interface LoadBatchOptions {
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
  | { status: 'rejected' }
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
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({ status: 'rejected' });
      },
    );
  });
}

export class StatsService {
  private readonly inFlight = new Map<string, Promise<PlayerStats | undefined>>();

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
  ) {}

  async getPlayerStats(request: ValidatedPlayerStatsRequest): Promise<StatsServiceResult> {
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
    const immediate = new Map<string, PlayerStats>();
    const fixtureRefreshEntries: FixtureRefreshEntry[] = [];
    let cacheHits = 0;
    const splitCache = supportsSplitPlayerStatsCache(this.cache)
      ? this.cache
      : undefined;

    if (splitCache) {
      const cachedParts = await Promise.all(
        playerRequests.map(async (playerRequest) => ({
          key: cacheKey(playerRequest, this.excludeLowCoverage),
          playerRequest,
          parts: await splitCache.getParts(
            cacheKey(playerRequest, this.excludeLowCoverage),
          ),
        })),
      );
      const hydratedCachedParts = await Promise.all(
        cachedParts.map(async (cached) => {
          if (
            cached.parts.form === undefined ||
            (cached.parts.fixture !== undefined &&
              cached.parts.fixture !== null) ||
            !cached.playerRequest.teamSlug
          ) {
            return cached;
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
      for (const { key, playerRequest, parts } of hydratedCachedParts) {
        if (
          parts.form === undefined ||
          !hasRequestedHistoricalWindows(
            parts.form,
            request.includeHistoricalAssists,
          )
        ) {
          continue;
        }
        cacheHits += 1;
        if (parts.fixture !== undefined) {
          const fixtureRefreshDue =
            parts.fixture !== null &&
            (await splitCache.claimFixtureRefresh(parts.fixture));
          immediate.set(key, {
            ...parts.form,
            nextGame: parts.fixture,
            ...(fixtureRefreshDue
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
      }
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
    const baseAndHistoryStartedAt = performance.now();

    if (
      request.refreshFixtures &&
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
      const batch = this.loadBatch(fresh, {
        allowPartialHistory: request.supportsPartialFormHistory,
      });
      for (const playerRequest of fresh) {
        const key = cacheKey(playerRequest, this.excludeLowCoverage);
        const pendingKey = inFlightKey(
          playerRequest,
          this.excludeLowCoverage,
        );
        const pending = batch.then((loaded) => loaded.get(key));
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
            return await this.inFlight.get(
              inFlightKey(playerRequest, this.excludeLowCoverage),
            );
          } catch (error) {
            // A failed cold player must not discard unrelated cache hits or
            // successfully loaded players from the same API response.
            firstColdLoadError ??= error;
            return undefined;
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
    cachedOrLoaded = await this.recoverEmptyNameResolutions(
      playerRequests,
      cachedOrLoaded,
      request.positions,
      request.playerTeams,
      request.includeHistoricalAssists,
      request.supportsPartialFormHistory,
    );
    if (splitCache) {
      cachedOrLoaded = await this.hydrateCachedTeamFixtures(
        cachedOrLoaded,
        playerRequests,
        splitCache,
      );
    }
    const baseAndHistoryDurationMs = elapsedMs(baseAndHistoryStartedAt);
    const resultStartedAt = performance.now();
    cachedOrLoaded = harmonizePlayerTeamFixtures(
      cachedOrLoaded,
      playerRequests,
    );
    const oddsEligiblePlayers = cachedOrLoaded.filter(
      (stats) => playerMarketOddsSupported(this.marketOddsProvider, stats),
    );
    const cacheOnlyOddsDeadlineMs = Date.now() + this.cacheOnlyOddsBudgetMs;
    const [fixtureMatchOdds, marketOdds] = await Promise.all([
      this.loadCacheOnlyWithinBudget(
        this.fixtureMatchOddsProvider.load(cachedOrLoaded, {
          cacheOnly: true,
        }),
      ),
      this.loadCacheOnlyWithinBudget(
        this.marketOddsProvider.load(oddsEligiblePlayers, {
          cacheOnly: true,
          cacheOnlyDeadlineMs: cacheOnlyOddsDeadlineMs,
        }),
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
    const matchOddsRefreshPlayers: PlayerStats[] = [];
    const data = cachedOrLoaded.map((stats): PlayerStats => {
      const pending = new Set<PendingRefresh>(
        stats.pendingRefreshes ?? [],
      );
      const key = playerMarketOddsKey(stats);
      const supportsMarketOdds = playerMarketOddsSupported(
        this.marketOddsProvider,
        stats,
      );
      const odds =
        supportsMarketOdds ? marketOdds.get(key) ?? null : null;
      const needsMarketOddsRefresh = (['goal', 'assist'] as const).some(
        (market) =>
          playerMarketFieldDrivesRequest(
            this.marketOddsProvider,
            stats,
            market,
          ) && !odds?.[market],
      );
      const fallbackMatchProbabilities =
        fixtureMatchOdds.get(key) ?? null;
      const nextGame = stats.nextGame
        ? {
            ...stats.nextGame,
            matchProbabilities: mergeMatchProbabilities(
              stats.nextGame.matchProbabilities,
              fallbackMatchProbabilities,
            ),
            marketOdds: odds,
          }
        : null;
      const statsWithFallback = { ...stats, nextGame };
      if (
        this.scheduleBackground &&
        supportsMarketOdds &&
        needsMarketOddsRefresh
      ) {
        pending.add('marketOdds');
        if (!playersWithFixtureRefresh.has(key)) {
          marketRefreshPlayers.push(stats);
        }
      }
      if (
        this.scheduleBackground &&
        this.fixtureMatchOddsProvider.supports(statsWithFallback) &&
        needsMatchProbabilitiesFallback(statsWithFallback)
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
      if (fixtureRefreshEntries.length > 0) {
        tasks.push(this.refreshFixtures(fixtureRefreshEntries));
      }
      if (marketRefreshPlayers.length > 0) {
        tasks.push(
          this.marketOddsProvider
            .load(marketRefreshPlayers)
            .then(() => undefined),
        );
      }
      if (matchOddsRefreshPlayers.length > 0) {
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
    return {
      data,
      cacheHits,
      source: this.dataSource.source,
      deferredPlayerNames: nameResolution.deferred,
      diagnostics: {
        requestedPlayers:
          request.slugs.length + request.playerNames.length,
        resolvedPlayers: playerRequests.length,
        returnedPlayers: data.length,
        cacheHits,
        deferredNames: nameResolution.deferred.length,
        partialHistories,
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
  ): Promise<Map<string, T>> {
    const result = await settleWithin(pending, this.cacheOnlyOddsBudgetMs);
    if (result.status === 'fulfilled') return result.value;
    return new Map();
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
    // A cold or invalid player must not prevent the other newly resolved
    // gallery cards from reaching the cache.
    await Promise.allSettled(
      requests.map((request) =>
        this.loadBatch([request], {
          completeHistory: true,
          overwriteForm: true,
          scheduleHistoryCompletion: false,
        }),
      ),
    );
  }

  private async recoverEmptyNameResolutions(
    playerRequests: readonly SourcePlayerRequest[],
    loadedStats: readonly PlayerStats[],
    positions: Readonly<Record<string, FootballPosition>> | undefined,
    teamSlugs: Readonly<Record<string, string>> | undefined,
    includeHistoricalAssists: boolean,
    allowPartialHistory: boolean,
  ): Promise<PlayerStats[]> {
    const emptyNameMatches = playerRequests.flatMap((playerRequest) => {
      if (
        !playerRequest.resolvedFromName ||
        playerRequest.nameResolution === 'search'
      ) {
        return [];
      }
      const stats = loadedStats.find(
        (candidate) =>
          candidate.slug === playerRequest.slug &&
          (!playerRequest.position ||
            candidate.position === playerRequest.position),
      );
      return stats &&
        !stats.pendingRefreshes?.includes('formHistory') &&
        hasNoUsablePlayerData(stats)
        ? [{ playerRequest, stats }]
        : [];
    });
    if (emptyNameMatches.length === 0) return [...loadedStats];

    try {
      const names = [
        ...new Set(
          emptyNameMatches.map(
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
      for (const { playerRequest, stats } of emptyNameMatches) {
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

      const correctedRequests = [
        ...new Map(
          [...replacements.values()].map((request) => [
            `${request.slug}:${request.position ?? 'default'}`,
            request,
          ]),
        ).values(),
      ];
      const corrected = await this.loadBatch(correctedRequests, {
        allowPartialHistory,
      });
      return loadedStats.map((stats) => {
        const correctedRequest = replacements.get(stats);
        return correctedRequest
          ? corrected.get(
              cacheKey(correctedRequest, this.excludeLowCoverage),
            ) ?? stats
          : stats;
      });
    } catch {
      // Name correction is best effort. A failed search or replacement fetch
      // must never discard unrelated cache hits from the current response.
      return [...loadedStats];
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
      const fixtures = await this.dataSource.fetchNextGames(
        requests.map(({ slug }) => ({ slug })),
      );
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

  private async refreshFixtures(entries: FixtureRefreshEntry[]): Promise<void> {
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
    const fixtureRequests = requests.map(({ slug }) => ({ slug }));
    let fixtureBySlug = new Map<string, SourcePlayerFixture>();
    try {
      const fixtures = await this.dataSource.fetchNextGames(fixtureRequests);
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
    const matchOddsEligible = refreshedPlayers.filter(
      (stats) =>
        this.fixtureMatchOddsProvider.supports(stats) &&
        needsMatchProbabilitiesFallback(stats),
    );
    await Promise.allSettled([
      oddsEligible.length > 0
        ? this.marketOddsProvider.load(oddsEligible).then(() => undefined)
        : Promise.resolve(),
      matchOddsEligible.length > 0
        ? this.fixtureMatchOddsProvider
            .load(matchOddsEligible)
            .then(() => undefined)
        : Promise.resolve(),
    ]);
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
    const tasks = unique.map(async (request) => {
      const refreshKey = inFlightKey(request, this.excludeLowCoverage);
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
        const stats = loaded.get(cacheKey(request, this.excludeLowCoverage));
        if (!stats || stats.pendingRefreshes?.includes('formHistory')) {
          throw new Error('Player form history remained incomplete');
        }
      } catch (error) {
        if (splitCache) {
          await splitCache.releaseFormHistoryRefresh(refreshKey);
        }
        throw error;
      }
    });
    this.scheduleBackground(
      Promise.allSettled(tasks).then((settled) => {
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
