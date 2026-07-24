import {
  calculatePlayerMetrics,
  type FootballPosition,
  type PlayerStats,
  type ValidatedPlayerStatsRequest,
} from '@sorare-overlay/shared';
import type { Cache } from '../cache.js';
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

export class StatsService {
  private readonly inFlight = new Map<string, Promise<PlayerStats | undefined>>();

  constructor(
    private readonly dataSource: PlayerStatsDataSource,
    private readonly goalscorerProvider: GoalscorerProbabilityProvider,
    private readonly cache: Cache<PlayerStats>,
    private readonly excludeLowCoverage: boolean,
  ) {}

  async getPlayerStats(request: ValidatedPlayerStatsRequest): Promise<StatsServiceResult> {
    const directRequests = request.slugs.map((slug): SourcePlayerRequest => {
      const position = request.positions?.[slug];
      return position ? { slug, position } : { slug };
    });
    const resolvedRequests = await this.dataSource.resolvePlayerNames(
      request.playerNames,
      request.positions,
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
    let cacheHits = 0;

    const cachedPlayers = await Promise.all(
      playerRequests.map(async (playerRequest) => {
        const key = cacheKey(playerRequest, this.excludeLowCoverage);
        return { key, cached: await this.cache.get(key) };
      }),
    );
    for (const { key, cached } of cachedPlayers) {
      if (cached) {
        immediate.set(key, cached);
        cacheHits += 1;
      }
    }

    const fresh = playerRequests.filter((playerRequest) => {
      const key = cacheKey(playerRequest, this.excludeLowCoverage);
      return !immediate.has(key) && !this.inFlight.has(key);
    });

    if (fresh.length > 0) {
      const batch = this.loadBatch(fresh);
      for (const playerRequest of fresh) {
        const key = cacheKey(playerRequest, this.excludeLowCoverage);
        const pending = batch.then((loaded) => loaded.get(key));
        this.inFlight.set(key, pending);
        void pending.then(
          () => this.inFlight.delete(key),
          () => this.inFlight.delete(key),
        );
      }
    }

    const data = (
      await Promise.all(
        playerRequests.map(async (playerRequest) => {
          const key = cacheKey(playerRequest, this.excludeLowCoverage);
          return immediate.get(key) ?? (await this.inFlight.get(key));
        }),
      )
    ).filter((stats): stats is PlayerStats => Boolean(stats));

    return { data, cacheHits, source: this.dataSource.source };
  }

  private async loadBatch(requests: SourcePlayerRequest[]): Promise<Map<string, PlayerStats>> {
    const players = await this.dataSource.fetchPlayers(requests);
    const requestByResultKey = new Map(
      requests.map((request) => [`${request.slug}:${request.position ?? 'default'}`, request]),
    );
    const result = new Map<string, PlayerStats>();

    for (const player of players) {
      const requested =
        requestByResultKey.get(`${player.slug}:${player.position}`) ??
        requestByResultKey.get(`${player.slug}:default`);
      if (!requested) continue;
      const stats = this.toPlayerStats(player, requested.position ?? player.position);
      const key = cacheKey(requested, this.excludeLowCoverage);
      let storedStats = stats;
      if (this.cache.fillMissing) {
        storedStats = await this.cache.fillMissing(key, stats);
      } else {
        await this.cache.set(key, stats);
      }
      result.set(key, storedStats);
    }
    return result;
  }

  private toPlayerStats(player: SourcePlayer, position: FootballPosition): PlayerStats {
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
      nextGame: player.nextGame,
      excludedLowCoverage: metrics.excludedLowCoverage,
    };
  }
}
