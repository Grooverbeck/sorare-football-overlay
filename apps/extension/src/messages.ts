import type {
  ApiErrorResponse,
  LineupSortValuesRequest,
  LineupSortValuesSuccessResponse,
  PlayerMarketSnapshotsRequest,
  PlayerMarketSnapshotsSuccessResponse,
  PlayerStatsRequest,
  PlayerStatsSuccessResponse,
} from '@sorare-overlay/shared';

export interface FetchPlayerStatsMessage {
  type: 'FETCH_PLAYER_STATS';
  payload: PlayerStatsRequest;
  requestId: string;
}

export interface FetchLineupSortValuesMessage {
  type: 'FETCH_LINEUP_SORT_VALUES';
  payload: LineupSortValuesRequest;
  requestId: string;
}

export interface FetchPlayerMarketSnapshotsMessage {
  type: 'FETCH_PLAYER_MARKET_SNAPSHOTS';
  payload: PlayerMarketSnapshotsRequest;
  requestId: string;
}

export type ExtensionMessage =
  | FetchPlayerStatsMessage
  | FetchLineupSortValuesMessage
  | FetchPlayerMarketSnapshotsMessage;

export type WorkerResponse<T> =
  | {
      ok: true;
      value: T;
      requestId: string;
      durationMs: number;
    }
  | {
      ok: false;
      error: ApiErrorResponse['error'];
      requestId: string;
      durationMs: number;
      status?: number;
    };

export type PlayerStatsWorkerResponse = WorkerResponse<PlayerStatsSuccessResponse>;
export type LineupSortValuesWorkerResponse = WorkerResponse<
  LineupSortValuesSuccessResponse
>;
export type PlayerMarketSnapshotsWorkerResponse = WorkerResponse<
  PlayerMarketSnapshotsSuccessResponse
>;
