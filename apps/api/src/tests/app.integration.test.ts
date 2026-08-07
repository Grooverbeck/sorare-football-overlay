import type { FootballPosition, PlayerStats } from '@sorare-overlay/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { createApp } from '../app.js';
import { TtlCache } from '../cache.js';
import { MockDataSource } from '../mock/mock-data-source.js';
import { HistoricalGoalscorerProvider } from '../providers/goalscorer-provider.js';
import { MockPlayerMarketOddsProvider } from '../providers/market-odds-provider.js';
import type { AppLogger } from '../logger.js';
import { StatsService } from '../services/stats-service.js';

const logger = pino({ level: 'silent' });

function testApp() {
  const service = new StatsService(
    new MockDataSource(),
    new HistoricalGoalscorerProvider(),
    new TtlCache<PlayerStats>(60_000),
    true,
    new MockPlayerMarketOddsProvider(),
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
    expect(firstBody.data[0].nextGame.marketOdds).toMatchObject({
      source: 'mock',
      goal: { bookmakerCount: 3 },
      assist: { bookmakerCount: 3 },
    });
    expect(
      firstBody.data.every(
        (player: Record<string, unknown>) =>
          !Object.hasOwn(player, 'nextGamePrediction'),
      ),
    ).toBe(true);

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

  it('returns selectable historical assist windows only on demand', async () => {
    const app = testApp();
    const baseResponse = await app.request('/api/player-stats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slugs: ['jude-bellingham'] }),
    });
    const baseBody = await baseResponse.json();
    expect(baseBody.data[0].historicalAssists).toBeUndefined();
    expect(baseBody.data[0].historicalGoals).toBeUndefined();
    expect(baseBody.data[0].historicalDecisives).toBeUndefined();

    const historicalResponse = await app.request('/api/player-stats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slugs: ['jude-bellingham'],
        includeHistoricalAssists: true,
      }),
    });
    const historicalBody = await historicalResponse.json();

    expect(historicalResponse.status).toBe(200);
    expect(historicalBody.data[0].historicalAssists).toMatchObject({
      l10: { sampleSize: 10 },
      l15: { sampleSize: 15 },
      l40: { sampleSize: 40 },
    });
    expect(historicalBody.data[0].historicalGoals).toMatchObject({
      l10: { sampleSize: 10 },
      l15: { sampleSize: 15 },
      l40: { sampleSize: 40 },
    });
    expect(historicalBody.data[0].historicalDecisives).toMatchObject({
      l10: { sampleSize: 10 },
      l15: { sampleSize: 15 },
      l40: { sampleSize: 40 },
    });
  });

  it('logs structured phase timings without player identifiers', async () => {
    const info = vi.fn<AppLogger['info']>();
    const phaseLogger: AppLogger = {
      debug: vi.fn(),
      info,
      warn: vi.fn(),
      error: vi.fn(),
    };
    const service = new StatsService(
      new MockDataSource(),
      new HistoricalGoalscorerProvider(),
      new TtlCache<PlayerStats>(60_000),
      true,
      new MockPlayerMarketOddsProvider(),
    );
    const app = createApp({
      statsService: service,
      logger: phaseLogger,
      corsOrigins: [],
    });

    await app.request('/api/player-stats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slugs: ['private-player-slug'] }),
    });

    const phaseCall = info.mock.calls.find(
      ([, message]) => message === 'Player statistics phases completed',
    );
    expect(phaseCall?.[0]).toMatchObject({
      requestedPlayers: 1,
      resolvedPlayers: 1,
      returnedPlayers: 1,
      cacheHits: 0,
      deferredNames: 0,
      partialHistories: 0,
      durationsMs: {
        nameResolution: expect.any(Number),
        cache: expect.any(Number),
        baseAndHistory: expect.any(Number),
        result: expect.any(Number),
        total: expect.any(Number),
      },
    });
    expect(JSON.stringify(phaseCall?.[0])).not.toContain(
      'private-player-slug',
    );
  });
});

describe('public extension pages', () => {
  it.each([
    ['/', 'Football Stats Overlay'],
    ['/privacy', 'Datenschutzerklärung'],
    ['/support', 'Hilfe zum Overlay'],
  ])('serves %s as a hardened HTML page', async (path, expectedText) => {
    const response = await testApp().request(path);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toContain(expectedText);
  });

  it('states the extension data boundary and Limited Use commitment', async () => {
    const response = await testApp().request('/privacy');
    const html = await response.text();

    expect(html).toContain('Chrome Web Store User Data Policy');
    expect(html).toContain('Limited-Use-Anforderungen');
    expect(html).toContain('liest oder überträgt insbesondere nicht');
    expect(html).toContain('Sorare-E-Mail-Adresse, Passwort, JWT, Cookies');
    expect(html).toContain('The Odds API');
    expect(html).toContain('keine Zugangsdaten');
  });
});
