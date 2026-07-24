import type { PlayerStatsRequest, PlayerStatsSuccessResponse } from '@sorare-overlay/shared';
import type { FetchPlayerStatsMessage, WorkerResponse } from './messages.js';

export async function fetchPlayerStats(
  payload: PlayerStatsRequest,
): Promise<PlayerStatsSuccessResponse> {
  const message: FetchPlayerStatsMessage = { type: 'FETCH_PLAYER_STATS', payload };
  const response = await new Promise<WorkerResponse>((resolve, reject) => {
    chrome.runtime.sendMessage(message, (result: WorkerResponse) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(result);
    });
  });

  if (!response.ok) throw new Error(response.error.message);
  return response.value;
}
