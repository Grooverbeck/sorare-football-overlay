import { describe, expect, it, vi } from 'vitest';
import { handleMessage } from '../service-worker.js';

describe('extension service worker player-stats requests', () => {
  it('forwards and returns the same backend request identity', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get('x-request-id')).toBe(
        'extension-request-1',
      );
      return new Response(
        JSON.stringify({
          data: [],
          meta: {
            requested: 1,
            returned: 0,
            cacheHits: 0,
            source: 'sorare',
            deferredPlayerSlugs: ['cold-player'],
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'extension-request-1',
          },
        },
      );
    });

    const response = await handleMessage(
      {
        type: 'FETCH_PLAYER_STATS',
        payload: { slugs: ['cold-player'], playerNames: [] },
        requestId: 'extension-request-1',
      },
      { url: 'https://sorare.com/football' },
      { apiBaseUrl: 'https://overlay.example', fetchImpl },
    );

    expect(response).toMatchObject({
      ok: true,
      requestId: 'extension-request-1',
      value: {
        meta: { deferredPlayerSlugs: ['cold-player'] },
      },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://overlay.example/api/player-stats',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('classifies invalid JSON separately from network outages', async () => {
    const response = await handleMessage(
      {
        type: 'FETCH_PLAYER_STATS',
        payload: { slugs: ['cold-player'], playerNames: [] },
        requestId: 'extension-request-2',
      },
      { url: 'https://sorare.com/football' },
      {
        apiBaseUrl: 'https://overlay.example',
        fetchImpl: vi.fn<typeof fetch>(async () =>
          new Response('<html>upstream error</html>', {
            status: 502,
            headers: { 'x-request-id': 'backend-request-2' },
          }),
        ),
      },
    );

    expect(response).toMatchObject({
      ok: false,
      requestId: 'backend-request-2',
      status: 502,
      error: {
        code: 'INVALID_BACKEND_RESPONSE',
        requestId: 'backend-request-2',
      },
    });
  });
});
