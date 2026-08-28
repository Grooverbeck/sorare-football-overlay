import type {
  LineupSortValuesRequest,
  LineupSortValuesSuccessResponse,
  PlayerStatsRequest,
  PlayerStatsSuccessResponse,
} from '@sorare-overlay/shared';
import type {
  FetchLineupSortValuesMessage,
  FetchPlayerStatsMessage,
  LineupSortValuesWorkerResponse,
  PlayerStatsWorkerResponse,
} from './messages.js';
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
  const response = await new Promise<PlayerStatsWorkerResponse>((resolve, reject) => {
    chrome.runtime.sendMessage(message, (result: PlayerStatsWorkerResponse) => {
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

export async function fetchLineupSortValues(
  payload: LineupSortValuesRequest,
): Promise<LineupSortValuesSuccessResponse> {
  const requestId = `sort-${crypto.randomUUID()}`;
  const startedAt = performance.now();
  const message: FetchLineupSortValuesMessage = {
    type: 'FETCH_LINEUP_SORT_VALUES',
    payload,
    requestId,
  };
  logStatsDiagnostic('lineup-sort-request', {
    requestId,
    requested:
      (payload.slugs?.length ?? 0) + (payload.playerNames?.length ?? 0),
  });
  const response = await new Promise<LineupSortValuesWorkerResponse>(
    (resolve, reject) => {
      chrome.runtime.sendMessage(
        message,
        (result: LineupSortValuesWorkerResponse) => {
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
        },
      );
    },
  );

  if (!response.ok) {
    logStatsDiagnostic('lineup-sort-error', {
      requestId: response.requestId,
      error: response.error,
      durationMs: response.durationMs,
      status: response.status ?? null,
    });
    throw new Error(
      `${response.error.code}: ${response.error.message} (Request-ID: ${response.requestId})`,
    );
  }
  logStatsDiagnostic('lineup-sort-response', {
    requestId: response.requestId,
    durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    backendDurationMs: response.value.meta.durationMs,
    requested: response.value.meta.requested,
    returned: response.value.meta.returned,
  });
  return response.value;
}
