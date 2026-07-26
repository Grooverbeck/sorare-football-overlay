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
  fixtureTeamOddsExpiration,
  fixtureTeamOddsKey,
  nextMondayFormExpiration,
  playerFixtureExpiration,
} from '../cloudflare/cache.js';
import { D1JsonKeyValueStore } from '../cloudflare/d1-cache.js';
import { SorareGraphqlClient } from '../graphql/client.js';
import type { AppLogger } from '../logger.js';

const silentLogger: AppLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

beforeAll(async () => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  await env.CACHE_DB.prepare(
    `CREATE TABLE IF NOT EXISTS cache_entries (
      cache_key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER,
      updated_at INTEGER NOT NULL
    )`,
  ).run();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

describe('Cloudflare Worker', () => {
  it('writes new cache values to D1 and retains KV as a read fallback', async () => {
    const fallbackKey = 'd1-fallback-probe';
    const d1Key = 'd1-primary-probe';
    await env.STATS_CACHE.put(fallbackKey, JSON.stringify({ source: 'kv' }));
    const store = new D1JsonKeyValueStore(env.CACHE_DB, env.STATS_CACHE);

    await expect(store.get(fallbackKey, 'json')).resolves.toEqual({
      source: 'kv',
    });
    await store.put(d1Key, JSON.stringify({ source: 'd1' }), {
      expirationTtl: 3_600,
    });
    await expect(store.get(d1Key, 'json')).resolves.toEqual({ source: 'd1' });

    const row = await env.CACHE_DB.prepare(
      'SELECT value, expires_at FROM cache_entries WHERE cache_key = ?1',
    )
      .bind(d1Key)
      .first<{ value: string; expires_at: number }>();
    expect(row?.value).toBe(JSON.stringify({ source: 'd1' }));
    expect(row?.expires_at).toBeGreaterThan(
      Math.floor(Date.now() / 1_000) + 3_590,
    );
  });

  it('aligns weekly form expiry to Monday at 10:00 UTC', () => {
    const weeklyTtl = 7 * 24 * 60 * 60;
    expect(
      nextMondayFormExpiration(
        Date.parse('2026-07-25T08:00:00.000Z'),
        weeklyTtl,
      ),
    ).toBe(Date.parse('2026-07-27T10:00:00.000Z') / 1_000);
    expect(
      nextMondayFormExpiration(
        Date.parse('2026-07-27T10:00:00.000Z'),
        weeklyTtl,
      ),
    ).toBe(Date.parse('2026-08-03T10:00:00.000Z') / 1_000);
  });

  it('keeps the current fixture and its team odds until the following morning', () => {
    const nowMs = Date.parse('2026-07-25T12:00:00.000Z');
    const fixtureDate = '2026-07-26T00:30:00.000Z';
    const expectedRollover =
      Date.parse('2026-07-27T08:00:00.000Z') / 1_000;

    expect(playerFixtureExpiration(fixtureDate, 14_400, nowMs)).toBe(
      expectedRollover,
    );
    expect(fixtureTeamOddsExpiration(fixtureDate, 14_400, nowMs)).toBe(
      expectedRollover,
    );
    expect(playerFixtureExpiration(null, 14_400, nowMs)).toBe(
      Date.parse('2026-07-25T16:00:00.000Z') / 1_000,
    );
  });

  it('migrates and preserves an active fixture instead of accepting Sorare nextGame', async () => {
    const nowMs = Date.now();
    const currentFixtureDate = new Date(nowMs + 30 * 60 * 1_000).toISOString();
    const followingFixtureDate = new Date(
      nowMs + 7 * 24 * 60 * 60 * 1_000,
    ).toISOString();
    const key = `fixture-rollover-probe-${nowMs}:Defender:no-low`;
    const store = new D1JsonKeyValueStore(env.CACHE_DB, env.STATS_CACHE);
    const currentFixture = {
      date: currentFixtureDate,
      homeTeamName: 'Current Home FC',
      awayTeamName: 'Current Away FC',
      playerTeamName: 'Current Home FC',
      opponentTeamName: 'Current Away FC',
      cleanSheetProbability: 0.38,
      matchProbabilities: { win: 0.52, draw: 0.26, loss: 0.22 },
    };
    await store.put(
      `player-fixture:v1:${key}`,
      JSON.stringify({ nextGame: currentFixture }),
      { expirationTtl: 14_400 },
    );

    const duringMatchContext = createExecutionContext();
    const duringMatchNowMs = nowMs + 3 * 60 * 60 * 1_000;
    const duringMatchCache = new CloudflarePlayerStatsCache(
      store,
      604_800,
      14_400,
      duringMatchContext,
      () => duringMatchNowMs,
    );
    const resolved = await duringMatchCache.setFixture(key, {
      date: followingFixtureDate,
      homeTeamName: 'Following Home FC',
      awayTeamName: 'Following Away FC',
      playerTeamName: 'Following Home FC',
      opponentTeamName: 'Following Away FC',
      cleanSheetProbability: 0.19,
      matchProbabilities: { win: 0.31, draw: 0.29, loss: 0.4 },
    });
    await waitOnExecutionContext(duringMatchContext);

    expect(resolved).toMatchObject({
      date: currentFixtureDate,
      cleanSheetProbability: 0.38,
      matchProbabilities: { win: 0.52, draw: 0.26, loss: 0.22 },
    });
    const migratedRow = await env.CACHE_DB.prepare(
      'SELECT value, expires_at FROM cache_entries WHERE cache_key = ?1',
    )
      .bind(`player-fixture:v1:${key}`)
      .first<{ value: string; expires_at: number }>();
    expect(JSON.parse(migratedRow?.value ?? '{}')).toMatchObject({
      cachePolicyVersion: 2,
      nextGame: { date: currentFixtureDate },
    });
    expect(migratedRow?.expires_at).toBe(
      playerFixtureExpiration(currentFixtureDate, 14_400, duringMatchNowMs),
    );
  });

  it('keeps fixture-level team odds available across player positions and empty refreshes', async () => {
    const nowMs = Date.parse('2026-07-25T12:00:00.000Z');
    const fixture = {
      date: '2026-07-26T00:30:00.000Z',
      homeTeamName: 'New England Revolution',
      awayTeamName: 'Atlanta United FC',
      playerTeamName: 'New England Revolution',
      opponentTeamName: 'Atlanta United FC',
      cleanSheetProbability: null,
      matchProbabilities: { win: null, draw: null, loss: null },
    };
    const legacyFixture = {
      ...fixture,
      cleanSheetProbability: 0.302779468238922,
      matchProbabilities: {
        win: 0.447130641067978,
        draw: 0.26827243613922,
        loss: 0.284596922792802,
      },
    };
    const store = new D1JsonKeyValueStore(env.CACHE_DB, env.STATS_CACHE);
    const sharedKey = fixtureTeamOddsKey(fixture);
    if (!sharedKey) throw new Error('Expected a fixture team odds key');
    const autoKey = 'fixture-odds-migration:auto-v3:no-low';
    const defenderKey = 'fixture-odds-migration:Defender:no-low';
    const teammateKey = 'fixture-odds-teammate:Defender:no-low';
    const awayKey = 'fixture-odds-opponent:Defender:no-low';
    await Promise.all([
      store.delete(sharedKey),
      store.delete(`player-fixture:v1:${autoKey}`),
      store.delete(`player-fixture:v1:${defenderKey}`),
      store.delete(`player-fixture:v1:${teammateKey}`),
      store.delete(`player-fixture:v1:${awayKey}`),
    ]);
    // Simulate the old per-player backfill without passing through the new
    // cache, so this exercises the lazy auto-v3 migration path.
    await store.put(
      `player-fixture:v1:${autoKey}`,
      JSON.stringify({ nextGame: legacyFixture }),
      { expirationTtl: 14_400 },
    );

    const context = createExecutionContext();
    const cache = new CloudflarePlayerStatsCache(
      store,
      604_800,
      14_400,
      context,
      () => nowMs,
    );
    const baseStats = {
      slug: 'fixture-odds-migration',
      displayName: 'Fixture Odds Migration',
      position: 'Defender' as const,
      aaL10: { value: 10, sampleSize: 10 },
      cleanSheetL10: { value: 0.2, sampleSize: 10 },
      goalL10: { value: 0.1, sampleSize: 10 },
      nextGame: fixture,
      excludedLowCoverage: 0,
    };

    const migrated = await cache.fillMissing(defenderKey, baseStats);
    expect(migrated.nextGame).toMatchObject({
      cleanSheetProbability: 0.302779468238922,
      matchProbabilities: {
        win: 0.447130641067978,
        draw: 0.26827243613922,
        loss: 0.284596922792802,
      },
    });
    await waitOnExecutionContext(context);

    const teammateContext = createExecutionContext();
    const teammateCache = new CloudflarePlayerStatsCache(
      store,
      604_800,
      14_400,
      teammateContext,
      () => nowMs,
    );
    const teammate = await teammateCache.fillMissing(teammateKey, {
      ...baseStats,
      slug: 'fixture-odds-teammate',
      displayName: 'Fixture Odds Teammate',
    });
    expect(teammate.nextGame).toMatchObject({
      cleanSheetProbability: 0.302779468238922,
      matchProbabilities: {
        win: 0.447130641067978,
        draw: 0.26827243613922,
        loss: 0.284596922792802,
      },
    });
    await waitOnExecutionContext(teammateContext);

    const emptyRefreshContext = createExecutionContext();
    const emptyRefreshCache = new CloudflarePlayerStatsCache(
      store,
      604_800,
      14_400,
      emptyRefreshContext,
      () => nowMs,
    );
    await emptyRefreshCache.set(defenderKey, baseStats);
    await waitOnExecutionContext(emptyRefreshContext);
    await expect(emptyRefreshCache.get(defenderKey)).resolves.toMatchObject({
      nextGame: {
        cleanSheetProbability: 0.302779468238922,
        matchProbabilities: {
          win: 0.447130641067978,
          draw: 0.26827243613922,
          loss: 0.284596922792802,
        },
      },
    });

    const opponentContext = createExecutionContext();
    const opponentCache = new CloudflarePlayerStatsCache(
      store,
      604_800,
      14_400,
      opponentContext,
      () => nowMs,
    );
    const opponent = await opponentCache.fillMissing(awayKey, {
      ...baseStats,
      slug: 'fixture-odds-opponent',
      displayName: 'Fixture Odds Opponent',
      nextGame: {
        ...fixture,
        playerTeamName: 'Atlanta United FC',
        opponentTeamName: 'New England Revolution',
      },
    });
    expect(opponent.nextGame).toMatchObject({
      cleanSheetProbability: null,
      matchProbabilities: { win: null, draw: null, loss: null },
    });
    await waitOnExecutionContext(opponentContext);

    const row = await env.CACHE_DB.prepare(
      'SELECT expires_at FROM cache_entries WHERE cache_key = ?1',
    )
      .bind(sharedKey)
      .first<{ expires_at: number }>();
    expect(row?.expires_at).toBe(
      fixtureTeamOddsExpiration(fixture.date, 14_400, nowMs),
    );

    const playerFixtureRow = await env.CACHE_DB.prepare(
      'SELECT expires_at FROM cache_entries WHERE cache_key = ?1',
    )
      .bind(`player-fixture:v1:${defenderKey}`)
      .first<{ expires_at: number }>();
    expect(playerFixtureRow?.expires_at).toBe(
      playerFixtureExpiration(fixture.date, 14_400, nowMs),
    );
  });

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
    const nowMs = Date.now();
    const nowSeconds = Math.floor(nowMs / 1_000);
    const weeklyFormTtlSeconds = 7 * 24 * 60 * 60;
    const playerContext = createExecutionContext();
    const playerCache = new CloudflarePlayerStatsCache(
      env.STATS_CACHE,
      weeklyFormTtlSeconds,
      14_400,
      playerContext,
      () => nowMs,
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
    expect(formKeys.keys[0]?.expiration).toBe(
      nextMondayFormExpiration(nowMs, weeklyFormTtlSeconds),
    );
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
