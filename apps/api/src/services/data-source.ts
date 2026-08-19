import type {
  FootballPosition,
  MatchProbabilities,
  PlayerAppearance,
} from '@sorare-overlay/shared';

export interface SourcePlayerRequest {
  slug: string;
  position?: FootballPosition;
  teamSlug?: string;
  includeHistoricalAssists?: boolean;
  resolvedFromName?: string;
  nameResolution?: 'direct' | 'search';
}

export interface PlayerNameResolutionOptions {
  forceSearch?: boolean;
  // Only consult the persistent/in-memory name mapping. This lets request
  // handlers return known players immediately while cold resolutions continue
  // through ExecutionContext.waitUntil().
  cacheOnly?: boolean;
  teamSlugs?: Readonly<Record<string, string>>;
}

export interface PlayerNameResolutionCacheRead {
  name: string;
  position: FootballPosition | undefined;
  teamSlug?: string;
}

export interface PlayerNameResolutionCache {
  get(
    name: string,
    position: FootballPosition | undefined,
    teamSlug?: string,
  ): Promise<SourcePlayerRequest | null | undefined>;
  getMany?(
    requests: readonly PlayerNameResolutionCacheRead[],
  ): Promise<Array<SourcePlayerRequest | null | undefined>>;
  set(
    name: string,
    position: FootballPosition | undefined,
    value: SourcePlayerRequest | null,
    teamSlug?: string,
  ): void | Promise<void>;
}

export interface SourceNextGame {
  date: string;
  competitionSlug?: string | null;
  homeTeamName: string | null;
  awayTeamName: string | null;
  homeTeamSlug?: string;
  awayTeamSlug?: string;
  playerTeamName: string | null;
  opponentTeamName: string | null;
  playerTeamSlug?: string;
  cleanSheetProbability: number | null;
  matchProbabilities: MatchProbabilities | null;
}

export interface SourcePlayer {
  slug: string;
  displayName: string;
  position: FootballPosition;
  activeClubId?: string;
  appearances: PlayerAppearance[];
  // `partial` means the returned appearances are the useful subset from the
  // cheap player payload. They are safe to display with their real sample
  // size, but must not be stored as the normal weekly L10 form snapshot.
  historyStatus?: 'complete' | 'partial';
  nextGame: SourceNextGame | null;
}

export interface SourcePlayerFixture {
  slug: string;
  // Confirmed by Sorare's activeClub, even when nextGame is temporarily null.
  playerTeamSlug?: string;
  nextGame: SourceNextGame | null;
}

export interface PlayerStatsDataSource {
  readonly source: 'sorare' | 'mock';
  resolvePlayerNames(
    names: readonly string[],
    positions?: Readonly<Record<string, FootballPosition>>,
    options?: PlayerNameResolutionOptions,
  ): Promise<SourcePlayerRequest[]>;
  // Optional fast path for request handlers with a background-task scheduler.
  // Implementations return the cheap, immediately available score window and
  // mark players that still need deeper history as `partial`.
  fetchPlayersBase?(
    requests: readonly SourcePlayerRequest[],
  ): Promise<SourcePlayer[]>;
  fetchPlayers(requests: readonly SourcePlayerRequest[]): Promise<SourcePlayer[]>;
  fetchNextGames(
    requests: readonly SourcePlayerRequest[],
  ): Promise<SourcePlayerFixture[]>;
}
