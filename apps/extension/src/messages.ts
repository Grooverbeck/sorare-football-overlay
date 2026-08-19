import type {
  ApiErrorResponse,
  PlayerStatsRequest,
  PlayerStatsSuccessResponse,
} from '@sorare-overlay/shared';

export interface FetchPlayerStatsMessage {
  type: 'FETCH_PLAYER_STATS';
  payload: PlayerStatsRequest;
  requestId: string;
}

export type WorkerResponse =
  | {
      ok: true;
      value: PlayerStatsSuccessResponse;
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
