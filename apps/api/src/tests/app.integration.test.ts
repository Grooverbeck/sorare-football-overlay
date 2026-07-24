import type { FootballPosition, PlayerStats } from '@sorare-overlay/shared';
import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { createApp } from '../app.js';
import { TtlCache } from '../cache.js';
import { MockDataSource } from '../mock/mock-data-source.js';
import { HistoricalGoalscorerProvider } from '../providers/goalscorer-provider.js';
import { StatsService } from '../services/stats-service.js';

const logger = pino({ level: 'silent' });

function testApp() {
  const service = new StatsService(
    new MockDataSource(),
    new HistoricalGoalscorerProvider(),
    new TtlCache<PlayerStats>(60_000),
    true,
  );
  return createApp({ statsService: service, logger, corsOrigins: ['http://localhost:5173'] });
}

describe('POST /api/player-stats', () => {
  afterEach(() => {
    // Keep this suite independent from any process-level environment changes.
  });

  it('returns batched, position-aware stats and cache metadata', async () => {
    const app = testApp();
    const positions: Record<string, FootballPosition> = {
      'virgil-van-dijk': 'Defender',
      'jude-bellingham': 'Midfielder',
    };
    const request = () =>
      app.request('/api/player-stats', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slugs: Object.keys(positions), positions }),
      });

    const first = await request();
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.meta).toMatchObject({ requested: 2, returned: 2, cacheHits: 0, source: 'mock' });
    expect(firstBody.data[0]).toMatchObject({
      slug: 'virgil-van-dijk',
      position: 'Defender',
      goalL10: { sampleSize: 9 },
    });
    expect(firstBody.data[0].nextGame.cleanSheetProbability).toBe(0.47);
    expect(firstBody.data[0].nextGame.matchProbabilities).toEqual({
      win: 0.48,
      draw: 0.27,
      loss: 0.25,
    });

    const second = await request();
    expect((await second.json()).meta.cacheHits).toBe(2);
  });

  it('returns a useful validation error', async () => {
    const response = await testApp().request('/api/player-stats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slugs: [] }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  });

  it('resolves lineup image player names before loading stats', async () => {
    const response = await testApp().request('/api/player-stats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerNames: ['Matt Turner'] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: [{ slug: 'matt-turner', displayName: 'Matt Turner' }],
      meta: { requested: 1, returned: 1, source: 'mock' },
    });
  });
});
