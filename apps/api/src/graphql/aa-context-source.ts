import { calculatePlayerMetrics, selectAaAppearances, type PlayerAppearance, type PlayerStats } from '@sorare-overlay/shared';
import type { AaContextSource, AaMembership, AaMemberships } from '../services/aa-context.js';
import type { SorareGraphqlClient } from './client.js';
import type { AaMembershipsQuery, NationalAaHistoryQuery, NationalAaHistoryQueryVariables } from '../generated/sorare.js';

export const AA_MEMBERSHIPS_QUERY = /* GraphQL */ `query AaMemberships($slugs: [String!]) {
  players(slugs: $slugs) { __typename ... on Player {
    slug activeClub { id slug shortName } activeNationalTeam { id slug shortName }
  } }
}`;
export const NATIONAL_AA_QUERY = /* GraphQL */ `query NationalAaHistory($slug: String!, $position: Position!, $after: String) {
  anyPlayer(slug: $slug) { __typename ... on Player {
    activeNationalTeam { id slug shortName latestGames(first: 20, after: $after, includingLive: false) {
      pageInfo { hasNextPage endCursor }
      nodes { id date lowCoverage statusTyped winner { id }
        playerGameScore(playerSlug: $slug, position: $position) { __typename positionTyped
          ... on PlayerGameScore { allAroundScore footballPlayerGameStats { anyTeam { id } minsPlayed playedInGame } }
        }
      }
    } }
  } }
}`;

export class SorareAaContextSource implements AaContextSource {
  constructor(private readonly client: SorareGraphqlClient, private readonly excludeLowCoverage: boolean) {}

  async memberships(slugs: string[]): Promise<Map<string, AaMemberships>> {
    const data = await this.client.request<AaMembershipsQuery, {slugs: string[]}>(AA_MEMBERSHIPS_QUERY, {slugs});
    return new Map(data.players.flatMap(p => p.__typename === 'Player' && p.slug
      ? [[p.slug, {club: p.activeClub ?? null, national: p.activeNationalTeam ?? null}] as const] : []));
  }

  async national(stats: PlayerStats, team: AaMembership) {
    const appearances: PlayerAppearance[] = [];
    const seen = new Set<string>();
    let after: string | null = null;
    const options = {excludeLowCoverage: this.excludeLowCoverage, limit: 10};
    // At most forty NATIONAL games, independent of the club form window.
    // Never persist a half-read history if either page fails.
    for (let page = 0; page < 2; page++) {
      const data: NationalAaHistoryQuery = await this.client.request<NationalAaHistoryQuery, NationalAaHistoryQueryVariables>(
        NATIONAL_AA_QUERY, {slug: stats.slug, position: stats.position, after});
      if (data.anyPlayer.__typename !== 'Player') throw new Error('Football player missing');
      const current = data.anyPlayer.activeNationalTeam;
      if (!current || current.id !== team.id || current.slug !== team.slug) throw new Error('National membership changed');
      for (const game of current.latestGames.nodes) {
        if (seen.has(game.id)) continue;
        seen.add(game.id);
        const score = game.playerGameScore;
        if (score?.__typename !== 'PlayerGameScore') continue;
        const appearance = score?.footballPlayerGameStats;
        if (game.statusTyped !== 'played' || score?.__typename !== 'PlayerGameScore' ||
          score.positionTyped !== stats.position || !appearance?.playedInGame ||
          appearance.anyTeam.id !== team.id || !Number.isFinite(score.allAroundScore)) continue;
        appearances.push({
          date: game.date, position: stats.position, allAroundScore: score.allAroundScore!,
          minsPlayed: appearance.minsPlayed ?? null, lowCoverage: game.lowCoverage,
          goals: null, cleanSheet60: null,
          ...(game.winner !== undefined ? {teamResult: game.winner === null ? 'draw' as const :
            game.winner.id === team.id ? 'win' as const : 'loss' as const} : {}),
          // The input is already restricted to this national team. The shared
          // AA selector still applies the exact same minutes/position rules.
        });
      }
      if (selectAaAppearances(appearances, stats.position, options).length >= 10) break;
      const info = current.latestGames.pageInfo;
      if (!info.hasNextPage || !info.endCursor || !current.latestGames.nodes.length) break;
      after = info.endCursor;
    }
    const metrics = calculatePlayerMetrics(appearances, stats.position, options);
    return {aaL10: metrics.aaL10, aaL10TeamWinRate: metrics.aaL10TeamWinRate};
  }
}
