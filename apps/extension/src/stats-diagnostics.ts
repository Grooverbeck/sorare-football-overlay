import type {
  PlayerStats,
  PlayerStatsRequest,
  PlayerStatsSuccessResponse,
} from '@sorare-overlay/shared';

const diagnosticPrefix = '[Sorare Overlay][StatsDiag]';
const responseRequestIds = new WeakMap<
  PlayerStatsSuccessResponse,
  string
>();
let requestSequence = 0;

function diagnosticsEnabled(): boolean {
  try {
    return (
      typeof chrome !== 'undefined' &&
      Boolean(chrome.runtime?.id) &&
      ['sorare.com', 'www.sorare.com'].includes(
        globalThis.location?.hostname ?? '',
      )
    );
  } catch {
    return false;
  }
}

export function summarizeStats(stats: PlayerStats): Record<string, unknown> {
  return {
    slug: stats.slug,
    displayName: stats.displayName,
    position: stats.position,
    aaL10: stats.aaL10,
    cleanSheetProbability:
      stats.nextGame?.cleanSheetProbability ?? null,
    fixture: stats.nextGame
      ? {
          date: stats.nextGame.date,
          homeTeamName: stats.nextGame.homeTeamName,
          awayTeamName: stats.nextGame.awayTeamName,
          playerTeamName: stats.nextGame.playerTeamName,
          opponentTeamName: stats.nextGame.opponentTeamName,
        }
      : null,
    pendingRefreshes: stats.pendingRefreshes ?? [],
  };
}

export function logStatsDiagnostic(
  stage: string,
  detail: Record<string, unknown>,
): void {
  if (!diagnosticsEnabled()) return;
  console.info(
    `${diagnosticPrefix} ${JSON.stringify({
      stage,
      capturedAt: new Date().toISOString(),
      ...detail,
    })}`,
  );
}

export function beginStatsDiagnosticRequest(
  payload: PlayerStatsRequest,
  apiBaseUrl: string,
): string {
  requestSequence += 1;
  const requestId = `${Date.now().toString(36)}-${requestSequence}`;
  logStatsDiagnostic('request', {
    requestId,
    apiBaseUrl,
    payload,
  });
  return requestId;
}

export function recordStatsDiagnosticResponse(
  requestId: string,
  response: PlayerStatsSuccessResponse,
): void {
  responseRequestIds.set(response, requestId);
  logStatsDiagnostic('response', {
    requestId,
    meta: response.meta,
    players: response.data.map(summarizeStats),
  });
}

export function statsDiagnosticRequestId(
  response: PlayerStatsSuccessResponse,
): string | undefined {
  return responseRequestIds.get(response);
}
