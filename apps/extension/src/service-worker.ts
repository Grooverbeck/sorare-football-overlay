import {
  ApiErrorResponseSchema,
  PlayerStatsRequestSchema,
  PlayerStatsSuccessResponseSchema,
} from '@sorare-overlay/shared';
import type { FetchPlayerStatsMessage, WorkerResponse } from './messages.js';

function errorResponse(code: string, message: string): WorkerResponse {
  return { ok: false, error: { code, message } };
}

function isSorareSender(sender: chrome.runtime.MessageSender): boolean {
  if (!sender.url) return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === 'https:' && ['sorare.com', 'www.sorare.com'].includes(url.hostname);
  } catch {
    return false;
  }
}

async function handleMessage(
  message: FetchPlayerStatsMessage,
  sender: chrome.runtime.MessageSender,
): Promise<WorkerResponse> {
  if (!isSorareSender(sender)) return errorResponse('FORBIDDEN', 'Message source is not sorare.com');
  if (message?.type !== 'FETCH_PLAYER_STATS') {
    return errorResponse('UNKNOWN_MESSAGE', 'Unknown extension message');
  }
  const request = PlayerStatsRequestSchema.safeParse(message.payload);
  if (!request.success) return errorResponse('INVALID_REQUEST', 'Invalid player-stats request');

  try {
    const response = await fetch(`${__API_BASE_URL__}/api/player-stats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request.data),
      cache: 'no-store',
    });
    const json: unknown = await response.json();
    if (!response.ok) {
      const parsed = ApiErrorResponseSchema.safeParse(json);
      return parsed.success
        ? { ok: false, error: parsed.data.error }
        : errorResponse('BACKEND_ERROR', `Backend returned HTTP ${response.status}`);
    }
    const parsed = PlayerStatsSuccessResponseSchema.safeParse(json);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : errorResponse('INVALID_BACKEND_RESPONSE', 'Backend response has an unexpected shape');
  } catch {
    return errorResponse('BACKEND_UNAVAILABLE', 'Statistikdienst ist nicht erreichbar');
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  void handleMessage(message as FetchPlayerStatsMessage, sender).then(sendResponse);
  return true;
});
