import {
  selectAaAppearances,
  type FootballPosition,
  type PlayerAppearance,
} from '@sorare-overlay/shared';
import { AppError } from '../errors.js';
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
  PlayerNameResolutionOptions,
  PlayerNameResolutionCache,
  PlayerStatsDataSource,
  SourcePlayer,
  SourcePlayerFixture,
  SourcePlayerRequest,
} from '../services/data-source.js';
import { mapWithConcurrency } from '../services/concurrency.js';
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

function playerTeamResult(
  gameStatus: string | undefined,
  winner: { id: string } | null | undefined,
  playerTeamId: string | undefined,
): PlayerAppearance['teamResult'] {
  // Missing status/winner fields mean an older or mock response did not
  // request result data. A GraphQL `null` winner on a played appearance is a
  // draw.
  if (gameStatus !== 'played' || winner === undefined || !playerTeamId) {
    return undefined;
  }
  if (winner === null) return 'draw';
  return winner.id === playerTeamId ? 'win' : 'loss';
}

// A small, auditable escape hatch for Sorare card display names whose public
// player slug is not derived from that display name. Candidates are still
// fetched from Sorare and must pass the normal display-name, position and club
// checks before they can replace a cached name resolution.
const verifiedPlayerSlugAliases: Readonly<Record<string, string>> = {
  'alexis vega': 'ernesto-alexis-vega-rojas',
};

function verifiedPlayerSlugAlias(name: string): string | undefined {
  return verifiedPlayerSlugAliases[normalizeName(name)];
}

function normalizeExactDisplayName(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
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

function expectedTeamSlugForName(
  name: string,
  teamSlugs: Readonly<Record<string, string>> | undefined,
): string | undefined {
  if (!teamSlugs) return undefined;
  const normalized = normalizeName(name);
  return Object.entries(teamSlugs)
    .find(([key]) => normalizeName(key) === normalized)?.[1]
    ?.trim()
    .toLowerCase();
}

function teamSlugsLikelyMatch(
  candidateSlug: string | undefined,
  expectedSlug: string | undefined,
): boolean {
  if (!expectedSlug) return true;
  if (!candidateSlug) return false;
  const candidate = candidateSlug.trim().toLowerCase();
  const expected = expectedSlug.trim().toLowerCase();
  return (
    candidate === expected ||
    candidate.startsWith(`${expected}-`) ||
    expected.startsWith(`${candidate}-`)
  );
}

interface ResolutionCandidateNextGame {
  __typename?: string;
  homeTeam?: { slug?: string | null } | null;
  awayTeam?: { slug?: string | null } | null;
}

interface ResolutionCandidateTeamContext {
  activeClub?: { slug: string } | null;
  nextGame?: ResolutionCandidateNextGame | null;
}

function confirmedResolutionTeamSlug(
  player: ResolutionCandidateTeamContext,
  expectedTeamSlug: string | undefined,
): string | undefined {
  const activeClubSlug = player.activeClub?.slug.trim().toLowerCase();
  if (!expectedTeamSlug) return activeClubSlug;
  return [
    activeClubSlug,
    player.nextGame?.homeTeam?.slug?.trim().toLowerCase(),
    player.nextGame?.awayTeam?.slug?.trim().toLowerCase(),
  ].find((candidateSlug) =>
    teamSlugsLikelyMatch(candidateSlug, expectedTeamSlug),
  );
}

function resolutionKey(
  name: string,
  position: FootballPosition | undefined,
  teamSlug?: string,
): string {
  return `${normalizeName(name)}:${position ?? 'any'}:${teamSlug ?? 'any-team'}`;
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
    activeClub?: { slug: string } | null;
    nextGame?: ResolutionCandidateNextGame | null;
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
        activeClub?: { slug: string } | null;
        nextGame?: ResolutionCandidateNextGame | null;
      };
    } | null;
  }>;
}

interface SlugCandidatePlayer {
  __typename?: string;
  slug: string;
  displayName: string;
  position: string;
  activeClub?: { slug: string } | null;
}

type HistoryLoadMode = 'base' | 'complete';
const NAME_SEARCH_CONCURRENCY = 6;
const HISTORY_LOAD_CONCURRENCY = 4;

function batchFailureCanBeSplit(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === 'SORARE_GRAPHQL_ERROR' &&
    /(?:query\s+)?complexity|exceeds?\s+(?:the\s+)?max(?:imum)?\s+complexity/i.test(
      error.message,
    )
  );
}

const RESOLVE_SLUG_CANDIDATES_QUERY = /* GraphQL */ `
  query ResolveSlugCandidates($slugs: [String!]!) {
    players(slugs: $slugs) {
      __typename
      ... on Player { slug displayName position activeClub { slug } }
    }
  }
`;

const RESOLVE_PLAYER_NAME_QUERY = /* GraphQL */ `
  query ResolvePlayerName($query: String!) {
    searchPlayers(query: $query, pageSize: 5) {
      hits {
        player {
          slug
          displayName
          position
          activeClub { slug }
          nextGame {
            __typename
            ... on Game {
              homeTeam { slug }
              awayTeam { slug }
            }
          }
        }
      }
    }
    searchCards(query: $query, pageSize: 5) {
      hits {
        card {
          __typename
          anyPlayer {
            __typename
            ... on Player {
              slug
              displayName
              position
              activeClub { slug }
              nextGame {
                __typename
                ... on Game {
                  homeTeam { slug }
                  awayTeam { slug }
                }
              }
            }
          }
        }
      }
    }
  }
`;

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
    // The result-enriched L10 query has measured complexity 589 for three
    // players against Sorare's anonymous limit of 500. Two remain safe; API
    // keys use Sorare's elevated limit and retain the configured batch size.
    this.batchSize = elevatedComplexityLimit
      ? requestedBatchSize
      : Math.min(requestedBatchSize, 2);
    // The fixture-only query omits the expensive score history and remains
    // comfortably below Sorare's anonymous complexity ceiling in larger
    // batches.
    this.fixtureBatchSize = Math.min(requestedBatchSize, 50);
  }

  async resolvePlayerNames(
    names: readonly string[],
    expectedPositions?: Readonly<Record<string, FootballPosition>>,
    options: PlayerNameResolutionOptions = {},
  ): Promise<SourcePlayerRequest[]> {
    const expectedTeamSlugs = options.teamSlugs;
    if (!options.forceSearch) {
      await this.hydrateCachedResolutions(
        names,
        expectedPositions,
        expectedTeamSlugs,
      );
    }
    if (options.cacheOnly) {
      return this.resolvedRequestsForNames(
        names,
        expectedPositions,
        expectedTeamSlugs,
      );
    }
    const missing = [
      ...new Map(
        names
          .filter((name) => {
            const position = expectedPositionForName(name, expectedPositions);
            const teamSlug = expectedTeamSlugForName(name, expectedTeamSlugs);
            const key = resolutionKey(name, position, teamSlug);
            const verifiedSlug = verifiedPlayerSlugAlias(name);
            const cachedResolution = this.resolvedNames.get(key);
            return (
              options.forceSearch ||
              (verifiedSlug !== undefined &&
                cachedResolution?.slug !== verifiedSlug) ||
              !this.hasCachedResolution(name, position, teamSlug)
            );
          })
          .map((name) => [normalizeName(name), name]),
      ).values(),
    ];

    // Most Sorare card names map directly to their public player slug. Resolve
    // all such candidates in one cheap query before falling back to the much
    // slower full-text searches. A broken search for one unusual name must not
    // hold back every other player in the request.
    if (!options.forceSearch) {
      try {
        await this.resolveSlugCandidates(
          missing,
          expectedPositions,
          expectedTeamSlugs,
        );
      } catch {
        // Search fallbacks below can still resolve each name independently.
      }
    }
    const searchFallbacks = options.forceSearch
      ? missing
      : missing.filter((name) => {
          const position = expectedPositionForName(name, expectedPositions);
          const teamSlug = expectedTeamSlugForName(name, expectedTeamSlugs);
          return !this.resolvedNames.has(resolutionKey(name, position, teamSlug));
        });
    const completedSearches = new Set<string>();
    await mapWithConcurrency(
      searchFallbacks,
      NAME_SEARCH_CONCURRENCY,
      async (name) => {
        const position = expectedPositionForName(name, expectedPositions);
        const teamSlug = expectedTeamSlugForName(name, expectedTeamSlugs);
        const key = resolutionKey(name, position, teamSlug);
        if (options.forceSearch) {
          // The cached/direct slug is precisely what is being revalidated.
          // Do not let a failed or empty search silently reuse it.
          this.resolvedNames.delete(key);
          this.unresolvedNamesUntil.delete(key);
        }
        try {
          await this.resolveName(name, position, teamSlug);
          completedSearches.add(key);
        } catch {
          // Do not fail or negative-cache the entire batch when one Sorare
          // search times out. The extension can retry only this player later.
        }
      },
    );
    const unresolved = searchFallbacks.filter((name) => {
      const position = expectedPositionForName(name, expectedPositions);
      const teamSlug = expectedTeamSlugForName(name, expectedTeamSlugs);
      const key = resolutionKey(name, position, teamSlug);
      return completedSearches.has(key) && !this.resolvedNames.has(key);
    });
    await mapWithConcurrency(
      unresolved,
      NAME_SEARCH_CONCURRENCY,
      async (name) => {
        const position = expectedPositionForName(name, expectedPositions);
        const teamSlug = expectedTeamSlugForName(name, expectedTeamSlugs);
        if (!this.resolvedNames.has(resolutionKey(name, position, teamSlug))) {
          await this.persistResolution(name, position, teamSlug, null);
        }
      },
    );
    return this.resolvedRequestsForNames(
      names,
      expectedPositions,
      expectedTeamSlugs,
    );
  }

  private resolvedRequestsForNames(
    names: readonly string[],
    expectedPositions?: Readonly<Record<string, FootballPosition>>,
    expectedTeamSlugs?: Readonly<Record<string, string>>,
  ): SourcePlayerRequest[] {
    return names.flatMap((name) => {
      const expectedPosition = expectedPositionForName(name, expectedPositions);
      const expectedTeamSlug = expectedTeamSlugForName(name, expectedTeamSlugs);
      const resolved = this.resolvedNames.get(
        resolutionKey(name, expectedPosition, expectedTeamSlug),
      );
      if (!resolved) return [];
      // A position persisted during name resolution is the player's broad
      // profile position, not necessarily the concrete current card position.
      // Only forward a position when the card DOM explicitly supplied it.
      return [
        {
          slug: resolved.slug,
          ...(expectedPosition ? { position: expectedPosition } : {}),
          // Only forward the canonical club slug stored with the Sorare
          // resolution. The DOM-provided expected slug remains a lookup hint
          // and must never become persistent fixture identity by itself.
          ...(resolved.teamSlug ? { teamSlug: resolved.teamSlug } : {}),
          resolvedFromName: name,
          ...(resolved.nameResolution
            ? { nameResolution: resolved.nameResolution }
            : {}),
        },
      ];
    });
  }

  private async resolveSlugCandidates(
    names: readonly string[],
    expectedPositions?: Readonly<Record<string, FootballPosition>>,
    expectedTeamSlugs?: Readonly<Record<string, string>>,
  ): Promise<void> {
    if (names.length === 0) return;
    const nameBySlug = new Map(
      names.map((name) => [
        verifiedPlayerSlugAlias(name) ?? slugFromName(name),
        name,
      ]),
    );
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
      const expectedTeamSlug = requestedName
        ? expectedTeamSlugForName(requestedName, expectedTeamSlugs)
        : undefined;
      const activeClubSlug = player.activeClub?.slug.toLowerCase();
      if (
        requestedName &&
        position &&
        (!expectedPosition || position === expectedPosition) &&
        teamSlugsLikelyMatch(activeClubSlug, expectedTeamSlug) &&
        namesLikelyMatch(requestedName, player.displayName)
      ) {
        const key = resolutionKey(
          requestedName,
          expectedPosition,
          expectedTeamSlug,
        );
        const resolved = {
          slug: player.slug,
          position,
          ...(activeClubSlug ? { teamSlug: activeClubSlug } : {}),
          nameResolution: 'direct' as const,
        };
        this.resolvedNames.set(key, resolved);
        this.unresolvedNamesUntil.delete(key);
        await this.persistResolution(
          requestedName,
          expectedPosition,
          expectedTeamSlug,
          resolved,
        );
      }
    }
  }

  async fetchPlayers(
    requests: readonly SourcePlayerRequest[],
  ): Promise<SourcePlayer[]> {
    return this.fetchPlayersWithHistoryMode(requests, 'complete');
  }

  async fetchPlayersBase(
    requests: readonly SourcePlayerRequest[],
  ): Promise<SourcePlayer[]> {
    return this.fetchPlayersWithHistoryMode(requests, 'base');
  }

  private async fetchPlayersWithHistoryMode(
    requests: readonly SourcePlayerRequest[],
    historyMode: HistoryLoadMode,
  ): Promise<SourcePlayer[]> {
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
          this.fetchBatchIsolated(
            batch,
            position,
            includeHistoricalAssists,
            historyMode,
          ),
        );
      }
    }
    const settled = await Promise.allSettled(calls);
    const fulfilled = settled.flatMap((entry) =>
      entry.status === 'fulfilled' ? entry.value : [],
    );
    if (
      fulfilled.length === 0 &&
      calls.length > 0 &&
      settled.every((entry) => entry.status === 'rejected')
    ) {
      const firstFailure = settled[0];
      if (firstFailure?.status === 'rejected') throw firstFailure.reason;
    }
    return fulfilled;
  }

  private async fetchBatchIsolated(
    requests: readonly SourcePlayerRequest[],
    requestedPosition: FootballPosition | undefined,
    includeHistoricalAssists: boolean,
    historyMode: HistoryLoadMode,
  ): Promise<SourcePlayer[]> {
    try {
      return await this.fetchBatch(
        requests,
        requestedPosition,
        includeHistoricalAssists,
        historyMode,
      );
    } catch (error) {
      if (!batchFailureCanBeSplit(error)) throw error;
      if (requests.length <= 1) return [];
      const midpoint = Math.ceil(requests.length / 2);
      const [left, right] = await Promise.all([
        this.fetchBatchIsolated(
          requests.slice(0, midpoint),
          requestedPosition,
          includeHistoricalAssists,
          historyMode,
        ),
        this.fetchBatchIsolated(
          requests.slice(midpoint),
          requestedPosition,
          includeHistoricalAssists,
          historyMode,
        ),
      ]);
      return [...left, ...right];
    }
  }

  async fetchNextGames(
    requests: readonly SourcePlayerRequest[],
  ): Promise<SourcePlayerFixture[]> {
    const calls = chunks(requests, this.fixtureBatchSize).map(async (batch) => {
      const requestBySlug = new Map(
        batch.map((request) => [request.slug, request]),
      );
      const variables: PlayerNextGamesQueryVariables = {
        slugs: batch.map(({ slug }) => slug),
      };
      const data = await this.client.request<
        PlayerNextGamesQuery,
        PlayerNextGamesQueryVariables
      >(PLAYER_NEXT_GAMES_QUERY, variables);
      return data.players.flatMap((player): SourcePlayerFixture[] => {
        if (player.__typename !== 'Player') return [];
        const matchingRequest = requestBySlug.get(player.slug);
        // Only a server-resolved name may use its confirmed team to repair a
        // stale activeClub. Raw DOM team hints remain response-local and must
        // never become persistent fixture identity by themselves.
        const expectedTeamSlug = matchingRequest?.resolvedFromName
          ? matchingRequest.teamSlug
          : undefined;
        const nextGame = this.nextGame(player, expectedTeamSlug);
        const playerTeamSlug =
          nextGame?.playerTeamSlug ?? player.activeClub?.slug;
        return [
          {
            slug: player.slug,
            ...(playerTeamSlug ? { playerTeamSlug } : {}),
            nextGame,
          },
        ];
      });
    });
    return (await Promise.all(calls)).flat();
  }

  private async resolveName(
    name: string,
    expectedPosition: FootballPosition | undefined,
    expectedTeamSlug: string | undefined,
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
    const playerMatches = data.searchPlayers.hits
      .map(({ player }) => player)
      .filter(
        (player) =>
          namesLikelyMatch(name, player.displayName) &&
          fromSorarePosition[player.position] !== undefined,
      );
    const cardMatches = cardPlayers.filter(
      (player) =>
        namesLikelyMatch(name, player.displayName) &&
        fromSorarePosition[player.position] !== undefined,
    );
    const candidates = [...playerMatches, ...cardMatches];
    const teamMatches = expectedTeamSlug
      ? candidates.filter(
          (player) =>
            confirmedResolutionTeamSlug(player, expectedTeamSlug) !==
            undefined,
        )
      : candidates;
    const expectedPositionMatch = expectedPosition
      ? teamMatches.find(
          (player) => fromSorarePosition[player.position] === expectedPosition,
        )
      : undefined;
    const eligibleCardMatches = expectedTeamSlug
      ? cardMatches.filter(
          (player) =>
            confirmedResolutionTeamSlug(player, expectedTeamSlug) !==
            undefined,
        )
      : cardMatches;
    const eligiblePlayerMatches = expectedTeamSlug
      ? playerMatches.filter(
          (player) =>
            confirmedResolutionTeamSlug(player, expectedTeamSlug) !==
            undefined,
        )
      : playerMatches;
    const exactCardMatches = eligibleCardMatches.filter(
      (player) =>
        normalizeExactDisplayName(player.displayName) ===
        normalizeExactDisplayName(name),
    );
    const cardEvidence = exactCardMatches.length > 0
      ? exactCardMatches
      : eligibleCardMatches;
    const cardCounts = new Map<string, number>();
    for (const player of cardEvidence) {
      cardCounts.set(player.slug, (cardCounts.get(player.slug) ?? 0) + 1);
    }
    const strongestCardMatch = cardEvidence.reduce<
      (typeof cardEvidence)[number] | undefined
    >((best, player) => {
      if (!best) return player;
      return (cardCounts.get(player.slug) ?? 0) >
        (cardCounts.get(best.slug) ?? 0)
        ? player
        : best;
    }, undefined);
    const exactPlayerMatch = eligiblePlayerMatches.find(
      (player) =>
        normalizeExactDisplayName(player.displayName) ===
        normalizeExactDisplayName(name),
    );
    // Sorare orders searchPlayers by player relevance. Prefer its exact display-name
    // hit before card volume, which can be dominated by an older namesake's editions.
    const exact =
      expectedPositionMatch ??
      exactPlayerMatch ??
      strongestCardMatch ??
      eligiblePlayerMatches[0];
    const position = exact ? fromSorarePosition[exact.position] : undefined;
    const confirmedTeamSlug = exact
      ? confirmedResolutionTeamSlug(exact, expectedTeamSlug)
      : undefined;
    const key = resolutionKey(name, expectedPosition, expectedTeamSlug);
    if (exact && position) {
      const resolved = {
        slug: exact.slug,
        position,
        ...(confirmedTeamSlug ? { teamSlug: confirmedTeamSlug } : {}),
        nameResolution: 'search' as const,
      };
      this.resolvedNames.set(key, resolved);
      this.unresolvedNamesUntil.delete(key);
      await this.persistResolution(
        name,
        expectedPosition,
        expectedTeamSlug,
        resolved,
      );
    } else {
      this.unresolvedNamesUntil.set(key, Date.now() + this.unresolvedNameTtlMs);
    }
  }

  private async hydrateCachedResolutions(
    names: readonly string[],
    expectedPositions: Readonly<Record<string, FootballPosition>> | undefined,
    expectedTeamSlugs: Readonly<Record<string, string>> | undefined,
  ): Promise<void> {
    if (!this.nameResolutionCache) return;
    const unique = [
      ...new Map(
        names.map((name) => {
          const position = expectedPositionForName(name, expectedPositions);
          const teamSlug = expectedTeamSlugForName(name, expectedTeamSlugs);
          return [
            resolutionKey(name, position, teamSlug),
            { name, position, teamSlug },
          ] as const;
        }),
      ).values(),
    ];

    const uncached = unique.filter(
      ({ name, position, teamSlug }) =>
        !this.hasCachedResolution(name, position, teamSlug),
    );
    const reads = uncached.flatMap(({ name, position, teamSlug }) => [
      { name, position, ...(teamSlug ? { teamSlug } : {}) },
      ...(position
        ? [{ name, position: undefined, ...(teamSlug ? { teamSlug } : {}) }]
        : []),
    ]);
    const values = this.nameResolutionCache.getMany
      ? await this.nameResolutionCache.getMany(reads)
      : await Promise.all(
          reads.map(({ name, position, teamSlug }) =>
            this.nameResolutionCache!.get(name, position, teamSlug),
          ),
        );
    const cachedByKey = new Map(
      reads.map((read, index) => [
        resolutionKey(read.name, read.position, read.teamSlug),
        values[index],
      ]),
    );

    for (const { name, position, teamSlug } of uncached) {
      const positionCached = cachedByKey.get(
        resolutionKey(name, position, teamSlug),
      );
      const genericCached = position
        ? cachedByKey.get(resolutionKey(name, undefined, teamSlug))
        : undefined;
      const compatibleGeneric =
        genericCached &&
        (!position || genericCached.position === position) &&
        teamSlugsLikelyMatch(genericCached.teamSlug, teamSlug)
          ? genericCached
          : undefined;
      const cached =
        positionCached === null
          ? compatibleGeneric ?? null
          : positionCached ?? compatibleGeneric;
      const key = resolutionKey(name, position, teamSlug);
      if (cached === null) {
        if (genericCached === undefined) {
          this.unresolvedNamesUntil.set(
            key,
            Date.now() + this.unresolvedNameTtlMs,
          );
        }
      } else if (cached) {
        this.resolvedNames.set(key, cached);
        this.unresolvedNamesUntil.delete(key);
      }
    }
  }

  private async persistResolution(
    name: string,
    position: FootballPosition | undefined,
    teamSlug: string | undefined,
    value: SourcePlayerRequest | null,
  ): Promise<void> {
    if (teamSlug) {
      await this.nameResolutionCache?.set(name, position, value, teamSlug);
    } else {
      await this.nameResolutionCache?.set(name, position, value);
    }
  }

  private hasCachedResolution(
    name: string,
    expectedPosition: FootballPosition | undefined,
    expectedTeamSlug: string | undefined,
  ): boolean {
    const key = resolutionKey(name, expectedPosition, expectedTeamSlug);
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
    historyMode: HistoryLoadMode,
  ): Promise<SourcePlayer[]> {
    const variables: PlayerStatsBatchQueryVariables = {
      slugs: requests.map(({ slug }) => slug),
      position: requestedPosition ? toSorarePosition[requestedPosition] : null,
    };
    const data = await this.client.request<PlayerStatsBatchQuery, PlayerStatsBatchQueryVariables>(
      PLAYER_STATS_BATCH_QUERY,
      variables,
    );
    const requestBySlug = new Map(
      requests.map((request) => [request.slug, request]),
    );

    const candidates = data.players.flatMap(
      (player): Array<{ player: SourcePlayer; scoreWindowWasFull: boolean }> => {
        if (player.__typename !== 'Player') return [];
        const position =
          requestedPosition ??
          currentCardPosition(player.cardPositions, player.anyPositions) ??
          fromSorarePosition[player.position];
        if (!position) return [];
        const activeClubId = player.activeClub?.id;
        const matchingRequest = requestBySlug.get(player.slug);
        const expectedTeamSlug = matchingRequest?.resolvedFromName
          ? matchingRequest.teamSlug
          : undefined;

        const appearances = player.playerGameScores.flatMap((score): PlayerAppearance[] => {
          if (!score || score.__typename !== 'PlayerGameScore') return [];
          const scorePosition = fromSorarePosition[score.positionTyped];
          if (!scorePosition) return [];
          const appearanceTeamId = score.footballPlayerGameStats.anyTeam?.id;
          const teamResult = playerTeamResult(
            score.footballGame.statusTyped,
            score.footballGame.winner,
            appearanceTeamId,
          );
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
              ...(teamResult ? { teamResult } : {}),
              ...(activeClubId && appearanceTeamId
                ? {
                    currentClubGame:
                      appearanceTeamId === activeClubId,
                  }
                : {}),
            },
          ];
        });
        return [
          {
            player: {
              slug: player.slug,
              displayName: player.displayName,
              position,
              ...(activeClubId ? { activeClubId } : {}),
              appearances: this.selectAppearanceWindow(
                appearances,
                position,
              ),
              nextGame: this.nextGame(player, expectedTeamSlug),
            },
            scoreWindowWasFull: player.playerGameScores.length >= 15,
          },
        ];
      },
    );

    return mapWithConcurrency(
      candidates,
      HISTORY_LOAD_CONCURRENCY,
      async ({ player, scoreWindowWasFull }) => {
        const validForSelectedPosition = this.validAaAppearanceCount(
          player.appearances,
          player.position,
        );
        const containsOtherPositions = player.appearances.some(
          (appearance) => appearance.position !== player.position,
        );
        const needsHistory =
          includeHistoricalAssists ||
          (validForSelectedPosition < 10 &&
            (scoreWindowWasFull || containsOtherPositions));
        if (!needsHistory) {
          return { ...player, historyStatus: 'complete' as const };
        }
        if (historyMode === 'base') {
          return { ...player, historyStatus: 'partial' as const };
        }

        if (includeHistoricalAssists) {
          try {
            const appearances = await this.fetchAppearanceHistory(
              player.slug,
              player.position,
              player.activeClubId,
              true,
            );
            return {
              ...player,
              appearances: this.selectAppearanceWindow(
                appearances,
                player.position,
                40,
              ),
              historyStatus: 'complete' as const,
            };
          } catch {
            return { ...player, historyStatus: 'partial' as const };
          }
        }
        try {
          const appearances = await this.fetchAppearanceHistory(
            player.slug,
            player.position,
            player.activeClubId,
          );
          return {
            ...player,
            appearances: this.selectAppearanceWindow(
              appearances,
              player.position,
            ),
            historyStatus: 'complete' as const,
          };
        } catch {
          return { ...player, historyStatus: 'partial' as const };
        }
      },
    );
  }

  private validAaAppearanceCount(
    appearances: readonly PlayerAppearance[],
    position: FootballPosition,
  ): number {
    return selectAaAppearances(appearances, position, {
      excludeLowCoverage: this.excludeLowCoverage,
      limit: 10,
    }).length;
  }

  private selectAppearanceWindow(
    appearances: readonly PlayerAppearance[],
    position: FootballPosition,
    limit = 10,
  ): PlayerAppearance[] {
    const played = appearances
      .filter((appearance) => (appearance.minsPlayed ?? 0) > 0)
      .sort((left, right) => Date.parse(right.date) - Date.parse(left.date));
    const selectedAaAppearances = selectAaAppearances(
      played,
      position,
      {
        excludeLowCoverage: this.excludeLowCoverage,
        limit,
      },
    );
    if (selectedAaAppearances.length < limit) return played;
    const oldestSelected = selectedAaAppearances.at(-1);
    const cutoffIndex = oldestSelected
      ? played.indexOf(oldestSelected)
      : -1;
    return cutoffIndex < 0 ? played : played.slice(0, cutoffIndex + 1);
  }

  private async fetchAppearanceHistory(
    slug: string,
    position: FootballPosition,
    activeClubId?: string,
    fullHistory = false,
  ): Promise<PlayerAppearance[]> {
    const appearances: PlayerAppearance[] = [];
    let after: string | null = null;
    let fetchedGames = 0;
    const maximumGames = 40;
    const pageSize = 20;

    while (fetchedGames < maximumGames) {
      const variables: PlayerAppearanceHistoryQueryVariables = {
        slug,
        position: toSorarePosition[position],
        first: Math.min(pageSize, maximumGames - fetchedGames),
        after,
      };
      const data = await this.client.request<
        PlayerAppearanceHistoryQuery,
        PlayerAppearanceHistoryQueryVariables
      >(PLAYER_APPEARANCE_HISTORY_QUERY, variables);
      if (data.anyPlayer.__typename !== 'Player') return appearances;

      const connection = data.anyPlayer.pastGames;
      fetchedGames += connection.nodes.length;
      appearances.push(
        ...connection.nodes.flatMap((game): PlayerAppearance[] => {
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
          const appearanceTeamId = score.footballPlayerGameStats.anyTeam?.id;
          const teamResult = playerTeamResult(
            game.statusTyped,
            game.winner,
            appearanceTeamId,
          );
          return [
            {
              date: game.date,
              allAroundScore: score.allAroundScore,
              goals: score.footballPlayerGameStats.goals ?? null,
              assists: score.footballPlayerGameStats.goalAssist ?? null,
              minsPlayed: score.footballPlayerGameStats.minsPlayed ?? null,
              cleanSheet60:
                score.footballPlayerGameStats.cleanSheet60 ?? null,
              lowCoverage: game.lowCoverage,
              position: scorePosition,
              ...(teamResult ? { teamResult } : {}),
              ...(activeClubId && appearanceTeamId
                ? {
                    currentClubGame:
                      appearanceTeamId === activeClubId,
                  }
                : {}),
            },
          ];
        }),
      );

      if (
        !fullHistory &&
        this.validAaAppearanceCount(appearances, position) >= 10
      ) {
        break;
      }
      const pageInfo = connection.pageInfo;
      if (
        pageInfo?.hasNextPage !== true ||
        !pageInfo.endCursor ||
        connection.nodes.length === 0
      ) {
        break;
      }
      after = pageInfo.endCursor;
    }
    return appearances;
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
    expectedTeamSlug?: string,
  ) {
    const game = player.nextGame;
    if (!game || game.__typename !== 'Game') return null;
    const clubId = player.activeClub?.id;
    const activeHome = clubId !== undefined && game.homeTeam?.id === clubId;
    const activeAway = clubId !== undefined && game.awayTeam?.id === clubId;
    const expectedHome = teamSlugsLikelyMatch(
      game.homeTeam?.slug,
      expectedTeamSlug,
    );
    const expectedAway = teamSlugsLikelyMatch(
      game.awayTeam?.slug,
      expectedTeamSlug,
    );
    const home =
      activeHome ||
      (!activeHome && !activeAway && expectedHome && !expectedAway);
    const away =
      activeAway ||
      (!activeHome && !activeAway && expectedAway && !expectedHome);
    const playerTeamSlug = activeHome || activeAway
      ? player.activeClub?.slug
      : home
        ? game.homeTeam?.slug
        : away
          ? game.awayTeam?.slug
          : undefined;
    const stats = home ? game.homeStats : away ? game.awayStats : null;
    const footballStats = stats?.__typename === 'FootballTeamGameStats' ? stats : null;
    return {
      date: game.date,
      ...(game.competition?.slug
        ? { competitionSlug: game.competition.slug }
        : {}),
      homeTeamName: game.homeTeam?.shortName ?? null,
      awayTeamName: game.awayTeam?.shortName ?? null,
      ...(game.homeTeam?.slug ? { homeTeamSlug: game.homeTeam.slug } : {}),
      ...(game.awayTeam?.slug ? { awayTeamSlug: game.awayTeam.slug } : {}),
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
      ...(playerTeamSlug ? { playerTeamSlug } : {}),
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
