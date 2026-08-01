import type { PlayerStatsRequest, PlayerStatsSuccessResponse } from '@sorare-overlay/shared';
import type { FetchPlayerStatsMessage, WorkerResponse } from './messages.js';
import { sendRuntimeMessage } from './browser-api.js';
import {
  beginStatsDiagnosticRequest,
  logStatsDiagnostic,
  recordStatsDiagnosticResponse,
} from './stats-diagnostics.js';

export async function fetchPlayerStats(
  payload: PlayerStatsRequest,
): Promise<PlayerStatsSuccessResponse> {
  const requestId = beginStatsDiagnosticRequest(payload, __API_BASE_URL__);
  const message: FetchPlayerStatsMessage = { type: 'FETCH_PLAYER_STATS', payload };
  let response: WorkerResponse;
  try {
    response = await sendRuntimeMessage<WorkerResponse>(message);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown runtime error';
    logStatsDiagnostic('runtime-error', {
      requestId,
      message: errorMessage,
    });
    throw error instanceof Error ? error : new Error(errorMessage);
  }

  if (!response.ok) {
    logStatsDiagnostic('backend-error', {
      requestId,
      error: response.error,
    });
    throw new Error(`${response.error.code}: ${response.error.message}`);
  }
  recordStatsDiagnosticResponse(requestId, response.value);
  return response.value;
}
