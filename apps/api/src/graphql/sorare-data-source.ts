import type { FootballPosition, PlayerAppearance } from '@sorare-overlay/shared';
import { parse } from 'graphql';
import type {
  PlayerAppearanceHistoryQuery,
  PlayerAppearanceHistoryQueryVariables,
  PlayerNextGamesQuery,
  PlayerNextGamesQueryVariables,
  PlayerStatsBatchQuery,
  PlayerStatsBatchQueryVariables,
  Position,
} from '../generated/sorare.js';
import type {
  PlayerNameResolutionCache,
  PlayerStatsDataSource,
  SourcePlayer,
  SourcePlayerFixture,
  SourcePlayerRequest,
} from '../services/data-source.js';
import { SorareGraphqlClient } from './client.js';
import {
  PLAYER_APPEARANCE_HISTORY_QUERY,
  PLAYER_NEXT_GAMES_QUERY,
  PLAYER_STATS_BATCH_QUERY,
} from './player-stats.query.js';

const toSorarePosition: Record<FootballPosition, Position> = {
  Goalkeeper: 'Goalkeeper',
  Defender: 'Defender',
  Midfielder: 'Midfielder',
  Forward: 'Forward',
};

const fromSorarePosition: Record<string, FootballPosition | undefined> = {
  Goalkeeper: 'Goalkeeper',
  Defender: 'Defender',
  Midfielder: 'Midfielder',
  Forward: 'Forward',
};

function currentCardPosition(
  cardPositions: readonly Position[] | undefined,
  anyPositions: readonly Position[] | undefined,
): FootballPosition | undefined {
  const primaryCardPosition = fromSorarePosition[cardPositions?.[0] ?? ''];
  if (primaryCardPosition) return primaryCardPosition;
  if (anyPositions?.length !== 1) return undefined;
  return fromSorarePosition[anyPositions[0] ?? ''];
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

function impliedProbabilityFromDecimalOdds(value: number | null | undefined): number | null {
  if (value === null || value === undefined || value < 1) return null;
  return Math.min(1, 1 / value);
}

function normalizeBasisPoints(value: number | null | undefined): number | null {
  if (value === null || value === undefined || value < 0 || value > 10_000) return null;
  return value / 10_000;
}

function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase();
}

function expectedPositionForName(
  name: string,
  positions: Readonly<Record<string, FootballPosition>> | undefined,
): FootballPosition | undefined {
  if (!positions) return undefined;
  const normalized = normalizeName(name);
  return Object.entries(positions).find(([key]) => normalizeName(key) === normalized)?.[1];
}

function resolutionKey(name: string, position: FootballPosition | undefined): string {
  return `${normalizeName(name)}:${position ?? 'any'}`;
}

function namesLikelyMatch(query: string, displayName: string): boolean {
  const requested = normalizeName(query).split(/\s+/);
  const candidate = normalizeName(displayName).split(/\s+/);
  if (requested.join(' ') === candidate.join(' ')) return true;
  if (requested.length !== 2 || candidate.length !== 2) return false;
  const [requestedFirst, requestedLast] = requested;
  const [candidateFirst, candidateLast] = candidate;
  return Boolean(
    requestedFirst &&
      candidateFirst &&
      requestedLast === candidateLast &&
      Math.min(requestedFirst.length, candidateFirst.length) >= 3 &&
      (requestedFirst.startsWith(candidateFirst) || candidateFirst.startsWith(requestedFirst)),
  );
}

function slugFromName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

interface SearchPlayerHit {
  player: {
    slug: string;
    displayName: string;
    position: string;
  };
}

interface SearchPlayerResult {
  hits: SearchPlayerHit[];
}

interface SearchCardResult {
  hits: Array<{
    card: {
      __typename?: string;
      anyPlayer: {
        __typename?: string;
        slug: string;
        displayName: string;
        position: string;
      };
    } | null;
  }>;
}

interface SlugCandidatePlayer {
  __typename?: string;
  slug: string;
  displayName: string;
  position: string;
}

const RESOLVE_SLUG_CANDIDATES_QUERY = parse(`
  query ResolveSlugCandidates($slugs: [String!]!) {
    players(slugs: $slugs) {
      __typename
      ... on Player { slug displayName position }
    }
  }
`);

const RESOLVE_PLAYER_NAME_QUERY = parse(`
  query ResolvePlayerName($query: String!) {
    searchPlayers(query: $query, pageSize: 5) {
      hits {
        player { slug displayName position }
      }
    }
    searchCards(query: $query, pageSize: 5) {
      hits {
        card {
          __typename
          anyPlayer {
            __typename
            ... on Player { slug displayName position }
          }
        }
      }
    }
  }
`);

export class SorareDataSource implements PlayerStatsDataSource {
  readonly source = 'sorare' as const;
  private readonly resolvedNames = new Map<string, SourcePlayerRequest>();
  private readonly unresolvedNamesUntil = new Map<string, number>();
  private readonly batchSize: number;
  private readonly fixtureBatchSize: number;

  constructor(
    private readonly client: SorareGraphqlClient,
    requestedBatchSize: number,
    elevatedComplexityLimit = false,
    private readonly unresolvedNameTtlMs = 86_400_000,
    private readonly excludeLowCoverage = true,
    private readonly nameResolutionCache?: PlayerNameResolutionCache,
  ) {
    // Four full L10 player payloads currently exceed Sorare's anonymous
    // complexity limit (589 > 500); three remain below it.
    this.batchSize = elevatedComplexityLimit
      ? requestedBatchSize
      : Math.min(requestedBatchSize, 3);
    // The fixture-only query omits the expensive score history and remains
    // comfortably below Sorare's anonymous complexity ceiling in larger
    // batches.
    this.fixtureBatchSize = Math.min(requestedBatchSize, 50);
  }

  async resolvePlayerNames(
    names: readonly string[],
    expectedPositions?: Readonly<Record<string, FootballPosition>>,
  ): Promise<SourcePlayerRequest[]> {
    await this.hydrateCachedResolutions(names, expectedPositions);
    const missing = [
      ...new Map(
        names
          .filter((name) => {
            const position = expectedPositionForName(name, expectedPositions);
            return !this.hasCachedResolution(name, position);
          })
          .map((name) => [normalizeName(name), name]),
      ).values(),
    ];
    await Promise.all(
      missing.map(async (name) =>
        this.resolveName(name, expectedPositionForName(name, expectedPositions))),
    );
    const unresolved = missing.filter((name) => {
      const position = expectedPositionForName(name, expectedPositions);
      return !this.resolvedNames.has(resolutionKey(name, position));
    });
    await this.resolveSlugCandidates(unresolved, expectedPositions);
    await Promise.all(
      unresolved.map(async (name) => {
        const position = expectedPositionForName(name, expectedPositions);
        if (!this.resolvedNames.has(resolutionKey(name, position))) {
          await this.persistResolution(name, position, null);
        }
      }),
    );
    return names.flatMap((name) => {
      const expectedPosition = expectedPositionForName(name, expectedPositions);
      const resolved = this.resolvedNames.get(resolutionKey(name, expectedPosition));
      if (!resolved) return [];
      // A position persisted during name resolution is the player's broad
      // profile position, not necessarily the concrete current card position.
      // Only forward a position when the card DOM explicitly supplied it.
      return [
        {
          slug: resolved.slug,
          ...(expectedPosition ? { position: expectedPosition } : {}),
        },
      ];
    });
  }

  private async resolveSlugCandidates(
    names: readonly string[],
    expectedPositions?: Readonly<Record<string, FootballPosition>>,
  ): Promise<void> {
    if (names.length === 0) return;
    const nameBySlug = new Map(names.map((name) => [slugFromName(name), name]));
    const data = await this.client.request<
      { players: SlugCandidatePlayer[] },
      { slugs: string[] }
    >(RESOLVE_SLUG_CANDIDATES_QUERY, { slugs: [...nameBySlug.keys()] });

    for (const player of data.players) {
      if (player.__typename && player.__typename !== 'Player') continue;
      const requestedName = nameBySlug.get(player.slug);
      const position = fromSorarePosition[player.position];
      const expectedPosition = requestedName
        ? expectedPositionForName(requestedName, expectedPositions)
        : undefined;
      if (
        requestedName &&
        position &&
        (!expectedPosition || position === expectedPosition) &&
        namesLikelyMatch(requestedName, player.displayName)
      ) {
        const key = resolutionKey(requestedName, expectedPosition);
        const resolved = { slug: player.slug, position };
        this.resolvedNames.set(key, resolved);
        this.unresolvedNamesUntil.delete(key);
        await this.persistResolution(requestedName, expectedPosition, resolved);
      }
    }
  }

  async fetchPlayers(requests: readonly SourcePlayerRequest[]): Promise<SourcePlayer[]> {
    const groups = new Map<
      string,
      {
        position: FootballPosition | undefined;
        includeHistoricalAssists: boolean;
        requests: SourcePlayerRequest[];
      }
    >();
    for (const request of requests) {
      const includeHistoricalAssists =
        request.includeHistoricalAssists === true;
      const key = `${request.position ?? 'auto'}:${includeHistoricalAssists ? 'assist-history' : 'base'}`;
      const group = groups.get(key) ?? {
        position: request.position,
        includeHistoricalAssists,
        requests: [],
      };
      group.requests.push(request);
      groups.set(key, group);
    }

    const calls: Promise<SourcePlayer[]>[] = [];
    for (const {
      position,
      includeHistoricalAssists,
      requests: groupedRequests,
    } of groups.values()) {
      for (const batch of chunks(groupedRequests, this.batchSize)) {
        calls.push(
          this.fetchBatch(batch, position, includeHistoricalAssists),
        );
      }
    }
    return (await Promise.all(calls)).flat();
  }

  async fetchNextGames(
    requests: readonly SourcePlayerRequest[],
  ): Promise<SourcePlayerFixture[]> {
    const calls = chunks(requests, this.fixtureBatchSize).map(async (batch) => {
      const variables: PlayerNextGamesQueryVariables = {
        slugs: batch.map(({ slug }) => slug),
      };
      const data = await this.client.request<
        PlayerNextGamesQuery,
        PlayerNextGamesQueryVariables
      >(PLAYER_NEXT_GAMES_QUERY, variables);
      return data.players.flatMap((player): SourcePlayerFixture[] => {
        if (player.__typename !== 'Player') return [];
        return [{ slug: player.slug, nextGame: this.nextGame(player) }];
      });
    });
    return (await Promise.all(calls)).flat();
  }

  private async resolveName(
    name: string,
    expectedPosition: FootballPosition | undefined,
  ): Promise<void> {
    const data = await this.client.request<
      { searchPlayers: SearchPlayerResult; searchCards?: SearchCardResult },
      { query: string }
    >(RESOLVE_PLAYER_NAME_QUERY, { query: name });
    const cardPlayers =
      data.searchCards?.hits.flatMap((hit) => {
        const player = hit.card?.anyPlayer;
        return player && (!player.__typename || player.__typename === 'Player')
          ? [player]
          : [];
      }) ?? [];
    const candidates = [
      ...data.searchPlayers.hits.map(({ player }) => player),
      ...cardPlayers,
    ];
    const nameMatches = candidates.filter(
      (player) =>
        namesLikelyMatch(name, player.displayName) &&
        fromSorarePosition[player.position] !== undefined,
    );
    const exact =
      nameMatches.find(
        (player) => fromSorarePosition[player.position] === expectedPosition,
      ) ?? nameMatches[0];
    const position = exact ? fromSorarePosition[exact.position] : undefined;
    const key = resolutionKey(name, expectedPosition);
    if (exact && position) {
      const resolved = { slug: exact.slug, position };
      this.resolvedNames.set(key, resolved);
      this.unresolvedNamesUntil.delete(key);
      await this.persistResolution(name, expectedPosition, resolved);
    } else {
      this.unresolvedNamesUntil.set(key, Date.now() + this.unresolvedNameTtlMs);
    }
  }

  private async hydrateCachedResolutions(
    names: readonly string[],
    expectedPositions: Readonly<Record<string, FootballPosition>> | undefined,
  ): Promise<void> {
    if (!this.nameResolutionCache) return;
    const unique = [
      ...new Map(
        names.map((name) => {
          const position = expectedPositionForName(name, expectedPositions);
          return [resolutionKey(name, position), { name, position }] as const;
        }),
      ).values(),
    ];

    await Promise.all(
      unique.map(async ({ name, position }) => {
        if (this.hasCachedResolution(name, position)) return;
        const positionCached = await this.nameResolutionCache?.get(name, position);
        const genericCached =
          position && !positionCached
            ? await this.nameResolutionCache?.get(name, undefined)
            : undefined;
        const cached =
          genericCached ??
          (positionCached === null && genericCached === undefined
            ? undefined
            : positionCached);
        const key = resolutionKey(name, position);
        if (cached === null) {
          this.unresolvedNamesUntil.set(key, Date.now() + this.unresolvedNameTtlMs);
        } else if (cached) {
          this.resolvedNames.set(key, cached);
          this.unresolvedNamesUntil.delete(key);
        }
      }),
    );
  }

  private async persistResolution(
    name: string,
    position: FootballPosition | undefined,
    value: SourcePlayerRequest | null,
  ): Promise<void> {
    await this.nameResolutionCache?.set(name, position, value);
  }

  private hasCachedResolution(
    name: string,
    expectedPosition: FootballPosition | undefined,
  ): boolean {
    const key = resolutionKey(name, expectedPosition);
    if (this.resolvedNames.has(key)) return true;
    const unresolvedUntil = this.unresolvedNamesUntil.get(key);
    if (unresolvedUntil !== undefined && unresolvedUntil > Date.now()) return true;
    this.unresolvedNamesUntil.delete(key);
    return false;
  }

  private async fetchBatch(
    requests: readonly SourcePlayerRequest[],
    requestedPosition: FootballPosition | undefined,
    includeHistoricalAssists: boolean,
  ): Promise<SourcePlayer[]> {
    const variables: PlayerStatsBatchQueryVariables = {
      slugs: requests.map(({ slug }) => slug),
      position: requestedPosition ? toSorarePosition[requestedPosition] : null,
    };
    const data = await this.client.request<PlayerStatsBatchQuery, PlayerStatsBatchQueryVariables>(
      PLAYER_STATS_BATCH_QUERY,
      variables,
    );

    const candidates = data.players.flatMap(
      (player): Array<{ player: SourcePlayer; scoreWindowWasFull: boolean }> => {
        if (player.__typename !== 'Player') return [];
        const position =
          requestedPosition ??
          currentCardPosition(player.cardPositions, player.anyPositions) ??
          fromSorarePosition[player.position];
        if (!position) return [];

        const appearances = player.playerGameScores.flatMap((score): PlayerAppearance[] => {
          if (!score || score.__typename !== 'PlayerGameScore') return [];
          const scorePosition = fromSorarePosition[score.positionTyped];
          if (!scorePosition) return [];
          return [
            {
              date: score.footballGame.date,
              allAroundScore: score.allAroundScore,
              goals: score.footballPlayerGameStats.goals ?? null,
              minsPlayed: score.footballPlayerGameStats.playedInGame
                ? (score.footballPlayerGameStats.minsPlayed ?? null)
                : 0,
              cleanSheet60: score.footballPlayerGameStats.cleanSheet60 ?? null,
              lowCoverage: score.footballGame.lowCoverage,
              position: scorePosition,
            },
          ];
        });

        return [
          {
            player: {
              slug: player.slug,
              displayName: player.displayName,
              position,
              appearances: this.selectAppearanceWindow(appearances),
              nextGame: this.nextGame(player),
            },
            scoreWindowWasFull: player.playerGameScores.length >= 15,
          },
        ];
      },
    );

    return Promise.all(
      candidates.map(async ({ player, scoreWindowWasFull }) => {
        if (includeHistoricalAssists) {
          const appearances = await this.fetchAppearanceHistory(
            player.slug,
            player.position,
          );
          return {
            ...player,
            appearances: this.selectAppearanceWindow(appearances, 40),
          };
        }
        const validForSelectedPosition = this.validAppearanceCount(
          player.appearances,
          player.position,
        );
        const containsOtherPositions = player.appearances.some(
          (appearance) => appearance.position !== player.position,
        );
        if (
          validForSelectedPosition >= 10 ||
          (!scoreWindowWasFull && !containsOtherPositions)
        ) {
          return player;
        }
        const appearances = await this.fetchAppearanceHistory(player.slug, player.position);
        return {
          ...player,
          appearances: this.selectAppearanceWindow(appearances),
        };
      }),
    );
  }

  private validAppearanceCount(
    appearances: readonly PlayerAppearance[],
    position: FootballPosition,
  ): number {
    return appearances.filter(
      (appearance) =>
        appearance.position === position &&
        (appearance.minsPlayed ?? 0) > 0 &&
        (!this.excludeLowCoverage || !appearance.lowCoverage),
    ).length;
  }

  private selectAppearanceWindow(
    appearances: readonly PlayerAppearance[],
    limit = 10,
  ): PlayerAppearance[] {
    const selected: PlayerAppearance[] = [];
    let valid = 0;
    const played = appearances
      .filter((appearance) => (appearance.minsPlayed ?? 0) > 0)
      .sort((left, right) => Date.parse(right.date) - Date.parse(left.date));

    for (const appearance of played) {
      selected.push(appearance);
      if (!this.excludeLowCoverage || !appearance.lowCoverage) valid += 1;
      if (valid >= limit) break;
    }
    return selected;
  }

  private async fetchAppearanceHistory(
    slug: string,
    position: FootballPosition,
  ): Promise<PlayerAppearance[]> {
    const variables: PlayerAppearanceHistoryQueryVariables = {
      slug,
      position: toSorarePosition[position],
    };
    const data = await this.client.request<
      PlayerAppearanceHistoryQuery,
      PlayerAppearanceHistoryQueryVariables
    >(PLAYER_APPEARANCE_HISTORY_QUERY, variables);
    if (data.anyPlayer.__typename !== 'Player') return [];

    return data.anyPlayer.pastGames.nodes.flatMap((game): PlayerAppearance[] => {
      const score = game.playerGameScore;
      if (
        !score ||
        score.__typename !== 'PlayerGameScore' ||
        !score.footballPlayerGameStats.playedInGame
      ) {
        return [];
      }
      const scorePosition = fromSorarePosition[score.positionTyped];
      if (!scorePosition) return [];
      return [
        {
          date: game.date,
          allAroundScore: score.allAroundScore,
          goals: score.footballPlayerGameStats.goals ?? null,
          assists: score.footballPlayerGameStats.goalAssist ?? null,
          minsPlayed: score.footballPlayerGameStats.minsPlayed ?? null,
          cleanSheet60: score.footballPlayerGameStats.cleanSheet60 ?? null,
          lowCoverage: game.lowCoverage,
          position: scorePosition,
        },
      ];
    });
  }

  private nextGame(
    player:
      | Extract<
          PlayerStatsBatchQuery['players'][number],
          { __typename?: 'Player' }
        >
      | Extract<
          PlayerNextGamesQuery['players'][number],
          { __typename?: 'Player' }
        >,
  ) {
    const game = player.nextGame;
    if (!game || game.__typename !== 'Game') return null;
    const clubId = player.activeClub?.id;
    const home = clubId !== undefined && game.homeTeam?.id === clubId;
    const away = clubId !== undefined && game.awayTeam?.id === clubId;
    const stats = home ? game.homeStats : away ? game.awayStats : null;
    const footballStats = stats?.__typename === 'FootballTeamGameStats' ? stats : null;
    return {
      date: game.date,
      homeTeamName: game.homeTeam?.shortName ?? null,
      awayTeamName: game.awayTeam?.shortName ?? null,
      playerTeamName: home
        ? game.homeTeam?.shortName ?? null
        : away
          ? game.awayTeam?.shortName ?? null
          : null,
      opponentTeamName: home
        ? game.awayTeam?.shortName ?? null
        : away
          ? game.homeTeam?.shortName ?? null
          : null,
      cleanSheetProbability: impliedProbabilityFromDecimalOdds(footballStats?.cleanSheetOdds),
      matchProbabilities: footballStats
        ? {
            win: normalizeBasisPoints(footballStats.winOddsBasisPoints),
            draw: normalizeBasisPoints(footballStats.drawOddsBasisPoints),
            loss: normalizeBasisPoints(footballStats.loseOddsBasisPoints),
          }
        : null,
    };
  }
}
