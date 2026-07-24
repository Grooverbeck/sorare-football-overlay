import type {
  ApiErrorResponse,
  PlayerStatsRequest,
  PlayerStatsSuccessResponse,
} from '@sorare-overlay/shared';

export interface FetchPlayerStatsMessage {
  type: 'FETCH_PLAYER_STATS';
  payload: PlayerStatsRequest;
}

export type WorkerResponse =
  | { ok: true; value: PlayerStatsSuccessResponse }
  | { ok: false; error: ApiErrorResponse['error'] };
