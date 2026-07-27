import type {
  FootballPosition,
  MatchProbabilities,
  PlayerAppearance,
} from '@sorare-overlay/shared';

export interface SourcePlayerRequest {
  slug: string;
  position?: FootballPosition;
  includeHistoricalAssists?: boolean;
  resolvedFromName?: string;
  nameResolution?: 'direct' | 'search';
}

export interface PlayerNameResolutionOptions {
  forceSearch?: boolean;
}

export interface PlayerNameResolutionCache {
  get(
    name: string,
    position: FootballPosition | undefined,
  ): Promise<SourcePlayerRequest | null | undefined>;
  set(
    name: string,
    position: FootballPosition | undefined,
    value: SourcePlayerRequest | null,
  ): void | Promise<void>;
}

export interface SourceNextGame {
  date: string;
  homeTeamName: string | null;
  awayTeamName: string | null;
  playerTeamName: string | null;
  opponentTeamName: string | null;
  cleanSheetProbability: number | null;
  matchProbabilities: MatchProbabilities | null;
}

export interface SourcePlayer {
  slug: string;
  displayName: string;
  position: FootballPosition;
  appearances: PlayerAppearance[];
  nextGame: SourceNextGame | null;
}

export interface SourcePlayerFixture {
  slug: string;
  nextGame: SourceNextGame | null;
}

export interface PlayerStatsDataSource {
  readonly source: 'sorare' | 'mock';
  resolvePlayerNames(
    names: readonly string[],
    positions?: Readonly<Record<string, FootballPosition>>,
    options?: PlayerNameResolutionOptions,
  ): Promise<SourcePlayerRequest[]>;
  fetchPlayers(requests: readonly SourcePlayerRequest[]): Promise<SourcePlayer[]>;
  fetchNextGames(
    requests: readonly SourcePlayerRequest[],
  ): Promise<SourcePlayerFixture[]>;
}
