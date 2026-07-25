import {
  createExecutionContext,
  env,
  fetchMock,
  SELF,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { parse } from 'graphql';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CloudflareMarketSnapshotStore,
  CloudflareNameResolutionCache,
  CloudflarePlayerStatsCache,
} from '../cloudflare/cache.js';
import { SorareGraphqlClient } from '../graphql/client.js';
import type { AppLogger } from '../logger.js';

const silentLogger: AppLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

describe('Cloudflare Worker', () => {
  it('keeps successful market snapshots and expires only temporary misses', async () => {
    const context = createExecutionContext();
    const store = new CloudflareMarketSnapshotStore(
      env.STATS_CACHE,
      1_800,
      context,
    );
    const fixtureKey = '2026-07-25T18:00:00.000Z|home fc|away fc';
    const missExpiration = Math.floor(
      (Date.now() + 24 * 60 * 60 * 1_000) / 1_000,
    );

    await store.set(fixtureKey, {
      status: 'available',
      market: 'player_goal_scorer_anytime',
      eventId: 'fixture-odds-1',
      capturedAt: '2026-07-24T12:00:00.000Z',
      players: {
        'test player': { probability: 0.4, bookmakerCount: 2 },
      },
    });
    await store.set(fixtureKey, {
      status: 'unavailable',
      market: 'player_assists',
      checkedAt: '2026-07-24T12:00:00.000Z',
      attemptCount: 1,
      nextRetryAt: '2026-07-25T00:00:00.000Z',
      expiresAt: new Date(missExpiration * 1_000).toISOString(),
    });

    await expect(
      store.get(fixtureKey, 'player_goal_scorer_anytime'),
    ).resolves.toMatchObject({ status: 'available', eventId: 'fixture-odds-1' });
    const listed = await env.STATS_CACHE.list({
      prefix: `market-odds:v1:${encodeURIComponent(fixtureKey)}`,
    });
    const goalKey = listed.keys.find((key) =>
      key.name.endsWith(':player_goal_scorer_anytime'),
    );
    const assistKey = listed.keys.find((key) =>
      key.name.endsWith(':player_assists'),
    );
    expect(goalKey?.expiration).toBeUndefined();
    expect(assistKey?.expiration).toBe(missExpiration);
  });

  it('serves the readiness endpoint', async () => {
    const response = await SELF.fetch('https://overlay.example/health');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('serves the public privacy policy', async () => {
    const response = await SELF.fetch('https://overlay.example/privacy');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    await expect(response.text()).resolves.toContain('Chrome Web Store User Data Policy');
  });

  it('serves player stats through the Worker runtime and KV binding', async () => {
    const response = await SELF.fetch('https://overlay.example/api/player-stats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slugs: ['virgil-van-dijk'],
        positions: { 'virgil-van-dijk': 'Defender' },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: [
        {
          slug: 'virgil-van-dijk',
          position: 'Defender',
        },
      ],
      meta: {
        requested: 1,
        returned: 1,
        source: 'mock',
      },
    });
  });

  it('stores form, fixture, name hits, and name misses with separate TTLs', async () => {
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const playerContext = createExecutionContext();
    const playerCache = new CloudflarePlayerStatsCache(
      env.STATS_CACHE,
      86_400,
      14_400,
      playerContext,
    );
    await playerCache.set('ttl-probe:Midfielder:no-low', {
      slug: 'ttl-probe',
      displayName: 'TTL Probe',
      position: 'Midfielder',
      aaL10: { value: 10, sampleSize: 10 },
      cleanSheetL10: { value: 0.2, sampleSize: 10 },
      goalL10: { value: 0.3, sampleSize: 10 },
      nextGame: {
        date: '2026-07-25T18:00:00.000Z',
        cleanSheetProbability: 0.4,
        matchProbabilities: { win: 0.5, draw: 0.25, loss: 0.25 },
      },
      excludedLowCoverage: 0,
    });
    await waitOnExecutionContext(playerContext);

    const nameContext = createExecutionContext();
    const nameCache = new CloudflareNameResolutionCache(
      env.STATS_CACHE,
      2_592_000,
      7_200,
      nameContext,
    );
    nameCache.set('TTL Positive Probe', 'Midfielder', {
      slug: 'ttl-positive-probe',
      position: 'Midfielder',
    });
    nameCache.set('TTL Negative Probe', 'Midfielder', null);
    await waitOnExecutionContext(nameContext);

    const [formKeys, fixtureKeys, positiveNameKeys, negativeNameKeys] = await Promise.all([
      env.STATS_CACHE.list({ prefix: 'player-form:v1:ttl-probe:' }),
      env.STATS_CACHE.list({ prefix: 'player-fixture:v1:ttl-probe:' }),
      env.STATS_CACHE.list({ prefix: 'player-name:v2:ttl%20positive%20probe:' }),
      env.STATS_CACHE.list({ prefix: 'player-name:v2:ttl%20negative%20probe:' }),
    ]);

    expect(formKeys.keys).toHaveLength(1);
    expect(fixtureKeys.keys).toHaveLength(1);
    expect(positiveNameKeys.keys).toHaveLength(1);
    expect(negativeNameKeys.keys).toHaveLength(1);
    expect(formKeys.keys[0]?.expiration).toBeGreaterThanOrEqual(nowSeconds + 86_390);
    expect(fixtureKeys.keys[0]?.expiration).toBeGreaterThanOrEqual(nowSeconds + 14_390);
    expect(positiveNameKeys.keys[0]?.expiration).toBeGreaterThanOrEqual(
      nowSeconds + 2_591_990,
    );
    expect(negativeNameKeys.keys[0]?.expiration).toBeGreaterThanOrEqual(
      nowSeconds + 7_190,
    );
  });

  it('lazily refreshes a viewed v1 fixture that predates player-relative team names', async () => {
    const cacheKey = 'team-name-migration-probe:Midfielder:no-low';
    const legacyContext = createExecutionContext();
    const legacyCache = new CloudflarePlayerStatsCache(
      env.STATS_CACHE,
      86_400,
      14_400,
      legacyContext,
    );
    const legacyStats = {
      slug: 'team-name-migration-probe',
      displayName: 'Team Name Migration Probe',
      position: 'Midfielder' as const,
      aaL10: { value: 10, sampleSize: 10 },
      cleanSheetL10: { value: 0.2, sampleSize: 10 },
      goalL10: { value: 0.3, sampleSize: 10 },
      nextGame: {
        date: '2026-07-25T18:00:00.000Z',
        homeTeamName: 'Away FC',
        awayTeamName: 'Home FC',
        cleanSheetProbability: 0.4,
        matchProbabilities: { win: 0.5, draw: 0.25, loss: 0.25 },
      },
      excludedLowCoverage: 0,
    };
    await legacyCache.set(cacheKey, legacyStats);
    await waitOnExecutionContext(legacyContext);
    await expect(legacyCache.get(cacheKey)).resolves.toBeUndefined();

    const refreshContext = createExecutionContext();
    const refreshCache = new CloudflarePlayerStatsCache(
      env.STATS_CACHE,
      86_400,
      14_400,
      refreshContext,
    );
    const refreshed = await refreshCache.fillMissing(cacheKey, {
      ...legacyStats,
      nextGame: {
        ...legacyStats.nextGame,
        playerTeamName: 'Home FC',
        opponentTeamName: 'Away FC',
      },
    });
    await waitOnExecutionContext(refreshContext);

    expect(refreshed.nextGame).toMatchObject({
      homeTeamName: 'Away FC',
      awayTeamName: 'Home FC',
      playerTeamName: 'Home FC',
      opponentTeamName: 'Away FC',
    });
    const readContext = createExecutionContext();
    const readCache = new CloudflarePlayerStatsCache(
      env.STATS_CACHE,
      86_400,
      14_400,
      readContext,
    );
    await expect(readCache.get(cacheKey)).resolves.toMatchObject({
      nextGame: {
        homeTeamName: 'Away FC',
        awayTeamName: 'Home FC',
        playerTeamName: 'Home FC',
        opponentTeamName: 'Away FC',
      },
    });
    const fixtureKeys = await env.STATS_CACHE.list({
      prefix: `player-fixture:v1:${cacheKey}`,
    });
    expect(fixtureKeys.keys).toHaveLength(1);
  });

  it('preserves the Workerd receiver when using the global fetch implementation', async () => {
    fetchMock
      .get('https://api.sorare.com')
      .intercept({ path: '/graphql', method: 'POST' })
      .reply(200, { data: { probe: 'ok' } });
    const client = new SorareGraphqlClient({
      url: 'https://api.sorare.com/graphql',
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      logger: silentLogger,
    });

    await expect(
      client.request<{ probe: string }, Record<string, never>>(
        parse('query WorkerFetchProbe { probe }'),
        {},
      ),
    ).resolves.toEqual({ probe: 'ok' });
  });
});
