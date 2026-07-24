import type {
  FootballPosition,
  MatchProbabilities,
  PlayerAppearance,
} from '@sorare-overlay/shared';

export interface SourcePlayerRequest {
  slug: string;
  position?: FootballPosition;
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

export interface PlayerStatsDataSource {
  readonly source: 'sorare' | 'mock';
  resolvePlayerNames(
    names: readonly string[],
    positions?: Readonly<Record<string, FootballPosition>>,
  ): Promise<SourcePlayerRequest[]>;
  fetchPlayers(requests: readonly SourcePlayerRequest[]): Promise<SourcePlayer[]>;
}
