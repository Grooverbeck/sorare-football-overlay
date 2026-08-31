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
      headers: {
        'content-type': 'application/json',
        'x-request-id': '00-sampled-phase-log',
      },
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

describe('POST /api/lineup-sort-values', () => {
  it('forces provider cache-only mode regardless of the client payload', async () => {
    const service = new StatsService(
      new MockDataSource(),
      new HistoricalGoalscorerProvider(),
      new TtlCache<PlayerStats>(60_000),
      true,
      new MockPlayerMarketOddsProvider(),
    );
    const getPlayerStats = vi.spyOn(service, 'getPlayerStats');
    const app = createApp({ statsService: service, logger, corsOrigins: [] });

    const response = await app.request('/api/lineup-sort-values', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slugs: ['jude-bellingham'] }),
    });

    expect(response.status).toBe(200);
    expect(getPlayerStats).toHaveBeenCalledWith(
      expect.objectContaining({
        oddsCacheOnly: true,
        supportsPartialFormHistory: true,
        refreshFixtures: false,
      }),
    );
  });

  it('returns only compact sort values and timing metadata', async () => {
    const response = await testApp().request('/api/lineup-sort-values', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slugs: ['jude-bellingham'],
        positions: { 'jude-bellingham': 'Midfielder' },
        historicalGoalWindow: 15,
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('server-timing')).toMatch(
      /^lineup-sort;dur=\d+(?:\.\d)?$/,
    );
    const body = await response.json();
    expect(body).toMatchObject({
      data: [
        {
          slug: 'jude-bellingham',
          position: 'Midfielder',
          goal: { probability: expect.any(Number) },
          aa: expect.any(Number),
          cleanSheet: null,
        },
      ],
      meta: {
        requested: 1,
        returned: 1,
        source: 'mock',
        durationMs: expect.any(Number),
      },
    });
    expect(body.data[0]).not.toHaveProperty('nextGame');
    expect(body.data[0]).not.toHaveProperty('historicalGoals');
  });

  it('returns the team clean-sheet probability for defender sorting', async () => {
    const response = await testApp().request('/api/lineup-sort-values', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slugs: ['virgil-van-dijk'],
        positions: { 'virgil-van-dijk': 'Defender' },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: [
        {
          slug: 'virgil-van-dijk',
          position: 'Defender',
          cleanSheet: expect.any(Number),
        },
      ],
    });
  });

  it('accepts a full fifty-player compact batch', async () => {
    const slugs = Array.from(
      { length: 50 },
      (_, index) => `lineup-sort-player-${index + 1}`,
    );
    const response = await testApp().request('/api/lineup-sort-values', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slugs }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      meta: { requested: 50, returned: 50 },
    });
  });
});

describe('API rate limiting', () => {
  it('rate limits an API route before starting player work', async () => {
    const service = new StatsService(
      new MockDataSource(),
      new HistoricalGoalscorerProvider(),
      new TtlCache<PlayerStats>(60_000),
      true,
      new MockPlayerMarketOddsProvider(),
    );
    const getPlayerStats = vi.spyOn(service, 'getPlayerStats');
    const consumeApiRateLimit = vi.fn(async () => false);
    const app = createApp({
      statsService: service,
      logger,
      corsOrigins: [],
      consumeApiRateLimit,
    });

    const response = await app.request('/api/player-stats', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'origin': 'chrome-extension://overlay-test',
        'cf-connecting-ip': '203.0.113.42',
        'x-request-id': 'rate-limited-request',
      },
      body: JSON.stringify({ slugs: ['jude-bellingham'] }),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(response.headers.get('access-control-allow-origin')).toBe(
      'chrome-extension://overlay-test',
    );
    expect(await response.json()).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests; retry shortly',
        requestId: 'rate-limited-request',
      },
    });
    expect(consumeApiRateLimit).toHaveBeenCalledWith(
      '203.0.113.42:/api/player-stats',
    );
    expect(getPlayerStats).not.toHaveBeenCalled();
  });

  it('fails open when the rate-limit binding is unavailable', async () => {
    const warn = vi.fn<AppLogger['warn']>();
    const rateLimitLogger: AppLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn,
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
      logger: rateLimitLogger,
      corsOrigins: [],
      consumeApiRateLimit: vi.fn().mockRejectedValue(new Error('unavailable')),
    });

    const response = await app.request('/api/player-stats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slugs: ['jude-bellingham'] }),
    });

    expect(response.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/player-stats',
        error: 'unavailable',
      }),
      'API rate limiter unavailable; allowing request',
    );
  });
});

describe('POST /api/player-market-snapshots', () => {
  it('returns a compact cache-only market update for a canonical fixture', async () => {
    const app = testApp();
    const statsResponse = await app.request('/api/player-stats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slugs: ['jude-bellingham'],
        positions: { 'jude-bellingham': 'Midfielder' },
      }),
    });
    const statsBody = await statsResponse.json();
    const stats = statsBody.data[0];

    const response = await app.request('/api/player-market-snapshots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        players: [
          {
            slug: stats.slug,
            displayName: stats.displayName,
            position: stats.position,
            nextGame: stats.nextGame,
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('server-timing')).toMatch(
      /^market-snapshots;dur=\d+(?:\.\d)?$/,
    );
    const body = await response.json();
    expect(body).toMatchObject({
      data: [
        {
          slug: 'jude-bellingham',
          position: 'Midfielder',
          marketOdds: { source: 'mock' },
          refreshState: 'settled',
        },
      ],
      meta: {
        requested: 1,
        returned: 1,
        source: 'mock',
        durationMs: expect.any(Number),
      },
    });
    expect(body.data[0]).not.toHaveProperty('aaL10');
    expect(body.data[0]).not.toHaveProperty('nextGame');
  });

  it('rejects an empty market snapshot batch', async () => {
    const response = await testApp().request('/api/player-market-snapshots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ players: [] }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });
  });
});

describe('public extension pages', () => {
  it('resolves request-local services once per request on a reusable app', async () => {
    const service = new StatsService(
      new MockDataSource(),
      new HistoricalGoalscorerProvider(),
      new TtlCache<PlayerStats>(60_000),
      true,
      new MockPlayerMarketOddsProvider(),
    );
    let statsServiceReads = 0;
    const services = {
      get statsService() {
        statsServiceReads += 1;
        return service;
      },
      logger,
      corsOrigins: [] as const,
    };
    const resolveServices = vi.fn(() => services);
    const app = createApp({ resolveServices });

    await expect(app.request('/health')).resolves.toMatchObject({ status: 200 });
    await expect(app.request('/privacy')).resolves.toMatchObject({ status: 200 });

    expect(resolveServices).toHaveBeenCalledTimes(2);
    expect(statsServiceReads).toBe(0);
  });

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
