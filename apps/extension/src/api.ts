import type {
  LineupSortValuesRequest,
  LineupSortValuesSuccessResponse,
  PlayerMarketSnapshotsRequest,
  PlayerMarketSnapshotsSuccessResponse,
  PlayerStatsRequest,
  PlayerStatsSuccessResponse,
} from '@sorare-overlay/shared';
import type {
  FetchLineupSortValuesMessage,
  FetchPlayerMarketSnapshotsMessage,
  FetchPlayerStatsMessage,
  LineupSortValuesWorkerResponse,
  PlayerMarketSnapshotsWorkerResponse,
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

export async function fetchPlayerMarketSnapshots(
  payload: PlayerMarketSnapshotsRequest,
): Promise<PlayerMarketSnapshotsSuccessResponse> {
  const requestId = `market-${crypto.randomUUID()}`;
  const message: FetchPlayerMarketSnapshotsMessage = {
    type: 'FETCH_PLAYER_MARKET_SNAPSHOTS',
    payload,
    requestId,
  };
  const response = await new Promise<PlayerMarketSnapshotsWorkerResponse>(
    (resolve, reject) => {
      chrome.runtime.sendMessage(
        message,
        (result: PlayerMarketSnapshotsWorkerResponse) => {
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
    logStatsDiagnostic('market-snapshots-error', {
      requestId: response.requestId,
      error: response.error,
      durationMs: response.durationMs,
      status: response.status ?? null,
    });
    throw new Error(
      `${response.error.code}: ${response.error.message} (Request-ID: ${response.requestId})`,
    );
  }
  logStatsDiagnostic('market-snapshots-response', {
    requestId: response.requestId,
    durationMs: response.durationMs,
    backendDurationMs: response.value.meta.durationMs,
    requested: response.value.meta.requested,
    returned: response.value.meta.returned,
  });
  return response.value;
}
