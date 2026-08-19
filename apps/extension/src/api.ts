import type { PlayerStatsRequest, PlayerStatsSuccessResponse } from '@sorare-overlay/shared';
import type { FetchPlayerStatsMessage, WorkerResponse } from './messages.js';
import {
  beginStatsDiagnosticRequest,
  logStatsDiagnostic,
  recordStatsDiagnosticResponse,
} from './stats-diagnostics.js';

export async function fetchPlayerStats(
  payload: PlayerStatsRequest,
): Promise<PlayerStatsSuccessResponse> {
  const requestId = beginStatsDiagnosticRequest(payload, __API_BASE_URL__);
  const message: FetchPlayerStatsMessage = {
    type: 'FETCH_PLAYER_STATS',
    payload,
    requestId,
  };
  const response = await new Promise<WorkerResponse>((resolve, reject) => {
    chrome.runtime.sendMessage(message, (result: WorkerResponse) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        logStatsDiagnostic('runtime-error', {
          requestId,
          message: runtimeError.message,
        });
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(result);
    });
  });

  if (!response.ok) {
    logStatsDiagnostic('backend-error', {
      requestId: response.requestId,
      error: response.error,
      durationMs: response.durationMs,
      status: response.status ?? null,
    });
    throw new Error(
      `${response.error.code}: ${response.error.message} (Request-ID: ${response.requestId})`,
    );
  }
  recordStatsDiagnosticResponse(response.requestId, response.value);
  return response.value;
}
