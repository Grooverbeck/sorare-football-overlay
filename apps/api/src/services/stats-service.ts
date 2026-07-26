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
  playerMarketOddsKey,
  playerMarketOddsSupported,
  type PlayerMarketOddsProvider,
} from '../providers/market-odds-provider.js';
import type { GoalscorerProbabilityProvider } from '../providers/goalscorer-provider.js';
import type {
  PlayerStatsDataSource,
  SourcePlayer,
  SourcePlayerRequest,
} from './data-source.js';

export interface StatsServiceResult {
  data: PlayerStats[];
  cacheHits: number;
  source: 'sorare' | 'mock';
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

type PendingRefresh = 'fixture' | 'marketOdds';

interface CachedFormOnly {
  key: string;
  request: SourcePlayerRequest;
  form: PlayerFormStats;
}

export type BackgroundTaskScheduler = (task: Promise<void>) => void;

export class StatsService {
  private readonly inFlight = new Map<string, Promise<PlayerStats | undefined>>();

  constructor(
    private readonly dataSource: PlayerStatsDataSource,
    private readonly goalscorerProvider: GoalscorerProbabilityProvider,
    private readonly cache: Cache<PlayerStats>,
    private readonly excludeLowCoverage: boolean,
    private readonly marketOddsProvider: PlayerMarketOddsProvider,
    private readonly scheduleBackground?: BackgroundTaskScheduler,
  ) {}

  async getPlayerStats(request: ValidatedPlayerStatsRequest): Promise<StatsServiceResult> {
    const directRequests = request.slugs.map((slug): SourcePlayerRequest => {
      const position = request.positions?.[slug];
      return {
        slug,
        ...(position ? { position } : {}),
        ...(request.includeHistoricalAssists
          ? { includeHistoricalAssists: true }
          : {}),
      };
    });
    const resolvedRequests = (
      await this.dataSource.resolvePlayerNames(
        request.playerNames,
        request.positions,
      )
    ).map(
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
    const immediate = new Map<string, PlayerStats>();
    const cachedFormsWithoutFixture: CachedFormOnly[] = [];
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
      for (const { key, playerRequest, parts } of cachedParts) {
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
          immediate.set(key, { ...parts.form, nextGame: parts.fixture });
        } else {
          immediate.set(key, {
            ...parts.form,
            nextGame: null,
            ...(this.scheduleBackground
              ? { pendingRefreshes: ['fixture'] as PendingRefresh[] }
              : {}),
          });
          cachedFormsWithoutFixture.push({
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

    if (
      request.refreshFixtures &&
      splitCache &&
      cachedFormsWithoutFixture.length > 0
    ) {
      const refreshedKeys = await this.hydrateFixturesForResponse(
        cachedFormsWithoutFixture,
        immediate,
        splitCache,
      );
      if (refreshedKeys.size > 0) {
        for (let index = cachedFormsWithoutFixture.length - 1; index >= 0; index -= 1) {
          const entry = cachedFormsWithoutFixture[index];
          if (entry && refreshedKeys.has(entry.key)) {
            cachedFormsWithoutFixture.splice(index, 1);
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
      const batch = this.loadBatch(fresh);
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

    const cachedOrLoaded = (
      await Promise.all(
        playerRequests.map(async (playerRequest) => {
          const key = cacheKey(playerRequest, this.excludeLowCoverage);
          return (
            immediate.get(key) ??
            (await this.inFlight.get(
              inFlightKey(playerRequest, this.excludeLowCoverage),
            ))
          );
        }),
      )
    ).filter((stats): stats is PlayerStats => Boolean(stats));
    const oddsEligiblePlayers = cachedOrLoaded.filter(
      (stats) => playerMarketOddsSupported(this.marketOddsProvider, stats),
    );
    const marketOdds = await this.marketOddsProvider
      .load(oddsEligiblePlayers, { cacheOnly: true })
      .catch(() => new Map());
    const marketRefreshPlayers: PlayerStats[] = [];
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
      if (
        this.scheduleBackground &&
        supportsMarketOdds &&
        (!odds?.goal || !odds.assist)
      ) {
        pending.add('marketOdds');
        marketRefreshPlayers.push(stats);
      }
      return {
        ...stats,
        nextGame: stats.nextGame
          ? {
              ...stats.nextGame,
              marketOdds: odds,
            }
          : null,
        ...(pending.size > 0
          ? { pendingRefreshes: [...pending] }
          : { pendingRefreshes: undefined }),
      };
    });

    if (this.scheduleBackground) {
      const tasks: Promise<void>[] = [];
      if (cachedFormsWithoutFixture.length > 0) {
        tasks.push(this.refreshFixtures(cachedFormsWithoutFixture));
      }
      if (marketRefreshPlayers.length > 0) {
        tasks.push(
          this.marketOddsProvider
            .load(marketRefreshPlayers)
            .then(() => undefined),
        );
      }
      if (tasks.length > 0) {
        this.scheduleBackground(Promise.all(tasks).then(() => undefined));
      }
    }

    return { data, cacheHits, source: this.dataSource.source };
  }

  private async hydrateFixturesForResponse(
    entries: readonly CachedFormOnly[],
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
      const fixtureBySlug = new Map(
        fixtures.map(({ slug, nextGame }) => [slug, nextGame]),
      );
      const refreshedKeys = new Set<string>();
      for (const { key, request, form } of entries) {
        if (!fixtureBySlug.has(request.slug)) continue;
        const nextGame = fixtureBySlug.get(request.slug) ?? null;
        const resolvedNextGame = await splitCache.setFixture(key, nextGame);
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

  private async refreshFixtures(entries: CachedFormOnly[]): Promise<void> {
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
    const fixtures = await this.dataSource.fetchNextGames(requests);
    const fixtureBySlug = new Map(
      fixtures.map(({ slug, nextGame }) => [slug, nextGame]),
    );
    const refreshedPlayers: PlayerStats[] = [];
    await Promise.all(
      entries.map(async ({ key, request, form }) => {
        if (!fixtureBySlug.has(request.slug)) return;
        const nextGame = fixtureBySlug.get(request.slug) ?? null;
        const resolvedNextGame = await splitCache.setFixture(key, nextGame);
        refreshedPlayers.push({ ...form, nextGame: resolvedNextGame });
      }),
    );
    const oddsEligible = refreshedPlayers.filter(
      (stats) => playerMarketOddsSupported(this.marketOddsProvider, stats),
    );
    if (oddsEligible.length > 0) {
      await this.marketOddsProvider.load(oddsEligible);
    }
  }

  private async loadBatch(requests: SourcePlayerRequest[]): Promise<Map<string, PlayerStats>> {
    const players = await this.dataSource.fetchPlayers(requests);
    const splitCache = supportsSplitPlayerStatsCache(this.cache)
      ? this.cache
      : undefined;
    const requestByResultKey = new Map(
      requests.map((request) => [`${request.slug}:${request.position ?? 'default'}`, request]),
    );
    const result = new Map<string, PlayerStats>();

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
      let storedStats = stats;
      if (requested.includeHistoricalAssists && splitCache) {
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
    return result;
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
      ...(includeHistoricalAssists
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
