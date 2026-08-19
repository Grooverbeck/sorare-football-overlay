import {
  ApiErrorResponseSchema,
  PlayerStatsRequestSchema,
  PlayerStatsSuccessResponseSchema,
} from '@sorare-overlay/shared';
import type { FetchPlayerStatsMessage, WorkerResponse } from './messages.js';

const backendRequestTimeoutMs = 15_000;

function errorResponse(
  code: string,
  message: string,
  requestId: string,
  startedAt: number,
  status?: number,
): WorkerResponse {
  return {
    ok: false,
    error: { code, message, requestId },
    requestId,
    durationMs: Math.round(performance.now() - startedAt),
    ...(status === undefined ? {} : { status }),
  };
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

interface HandleMessageOptions {
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export async function handleMessage(
  message: FetchPlayerStatsMessage,
  sender: chrome.runtime.MessageSender,
  options: HandleMessageOptions = {},
): Promise<WorkerResponse> {
  const startedAt = performance.now();
  const requestId = message?.requestId || crypto.randomUUID();
  if (!isSorareSender(sender)) {
    return errorResponse(
      'FORBIDDEN',
      'Message source is not sorare.com',
      requestId,
      startedAt,
    );
  }
  if (message?.type !== 'FETCH_PLAYER_STATS') {
    return errorResponse(
      'UNKNOWN_MESSAGE',
      'Unknown extension message',
      requestId,
      startedAt,
    );
  }
  const request = PlayerStatsRequestSchema.safeParse(message.payload);
  if (!request.success) {
    return errorResponse(
      'INVALID_REQUEST',
      'Invalid player-stats request',
      requestId,
      startedAt,
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    backendRequestTimeoutMs,
  );
  try {
    const apiBaseUrl = options.apiBaseUrl ?? __API_BASE_URL__;
    const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const response = await fetchImpl(`${apiBaseUrl}/api/player-stats`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': requestId,
      },
      body: JSON.stringify(request.data),
      cache: 'no-store',
      signal: controller.signal,
    });
    const backendRequestId = response.headers.get('x-request-id') ?? requestId;
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return errorResponse(
        'INVALID_BACKEND_RESPONSE',
        `Backend returned invalid JSON (HTTP ${response.status})`,
        backendRequestId,
        startedAt,
        response.status,
      );
    }
    if (!response.ok) {
      const parsed = ApiErrorResponseSchema.safeParse(json);
      return parsed.success
        ? {
            ok: false,
            error: {
              ...parsed.data.error,
              requestId: parsed.data.error.requestId ?? backendRequestId,
            },
            requestId: parsed.data.error.requestId ?? backendRequestId,
            durationMs: Math.round(performance.now() - startedAt),
            status: response.status,
          }
        : errorResponse(
            'BACKEND_ERROR',
            `Backend returned HTTP ${response.status}`,
            backendRequestId,
            startedAt,
            response.status,
          );
    }
    const parsed = PlayerStatsSuccessResponseSchema.safeParse(json);
    return parsed.success
      ? {
          ok: true,
          value: parsed.data,
          requestId: backendRequestId,
          durationMs: Math.round(performance.now() - startedAt),
        }
      : errorResponse(
          'INVALID_BACKEND_RESPONSE',
          'Backend response has an unexpected shape',
          backendRequestId,
          startedAt,
          response.status,
        );
  } catch (error) {
    console.warn('[Sorare Overlay] Backend request failed:', error);
    const timedOut = error instanceof Error && error.name === 'AbortError';
    return errorResponse(
      timedOut ? 'BACKEND_TIMEOUT' : 'BACKEND_UNAVAILABLE',
      timedOut
        ? 'Statistikabruf hat zu lange gedauert'
        : 'Statistikdienst ist nicht erreichbar',
      requestId,
      startedAt,
    );
  } finally {
    clearTimeout(timeout);
  }
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener(
    (message: unknown, sender, sendResponse) => {
      void handleMessage(message as FetchPlayerStatsMessage, sender).then(
        sendResponse,
      );
      return true;
    },
  );
}
