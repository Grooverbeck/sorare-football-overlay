import {
  createExecutionContext,
  env,
  fetchMock,
  SELF,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { parse } from 'graphql';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CloudflareMarketSnapshotStore,
  CloudflareNameResolutionCache,
  CloudflarePlayerStatsCache,
  fixtureOddsRefreshIntervalMs,
  fixtureTeamOddsExpiration,
  fixtureTeamOddsKey,
  nextMondayFormExpiration,
  playerFixtureExpiration,
} from '../cloudflare/cache.js';
import { D1JsonKeyValueStore } from '../cloudflare/d1-cache.js';
import { SorareGraphqlClient } from '../graphql/client.js';
import type { AppLogger } from '../logger.js';
import { normalizeTeamName } from '../providers/market-odds-provider.js';

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
  it('writes new cache values to D1 without reviving stale KV-only entries', async () => {
    const fallbackKey = 'd1-fallback-probe';
    const d1Key = 'd1-primary-probe';
    await env.STATS_CACHE.put(fallbackKey, JSON.stringify({ source: 'kv' }));
    const store = new D1JsonKeyValueStore(env.CACHE_DB, env.STATS_CACHE);

    await expect(store.get(fallbackKey, 'json')).resolves.toBeNull();
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

  it('shares one canonical team resolution across identical teammates in a batch', async () => {
    const values = new Map<string, string>();
    const get = vi.fn(async (key: string) => {
      const value = values.get(key);
      return value === undefined ? null : JSON.parse(value);
    });
    const put = vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    });
    const putEarlierFixture = vi.fn(async (key: string, value: string) => {
      if (!values.has(key)) values.set(key, value);
    });
    const namespace = {
      get,
      put,
      putEarlierFixture,
      delete: vi.fn(async (key: string) => {
        values.delete(key);
      }),
    };
    const context = createExecutionContext();
    const cache = new CloudflarePlayerStatsCache(
      namespace,
      604_800,
      14_400,
      context,
    );
    const fixture = {
      date: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
      competitionSlug: 'bundesliga-de',
      homeTeamName: 'Shared Home',
      awayTeamName: 'Shared Away',
      playerTeamName: 'Shared Home',
      opponentTeamName: 'Shared Away',
      playerTeamSlug: 'shared-home',
      cleanSheetProbability: 0.42,
      matchProbabilities: { win: 0.61, draw: 0.23, loss: 0.16 },
    };
    const stats = (slug: string) => ({
      slug,
      displayName: slug,
      position: 'Defender' as const,
      aaL10: { value: 12, sampleSize: 10 },
      cleanSheetL10: { value: 0.3, sampleSize: 10 },
      goalL10: { value: 0.1, sampleSize: 10 },
      nextGame: fixture,
      excludedLowCoverage: 0,
    });

    await Promise.all([
      cache.set('first:Defender:no-low', stats('first')),
      cache.set('second:Defender:no-low', stats('second')),
    ]);
    await waitOnExecutionContext(context);

    expect(putEarlierFixture).toHaveBeenCalledTimes(1);
    expect(
      get.mock.calls.filter(([key]) =>
        String(key).startsWith('player-team-fixture:v2:shared-home'),
      ),
    // One cold read decides whether a write is needed; the second confirms
    // what the atomic cross-isolate write retained.
    ).toHaveLength(2);
    expect(
      get.mock.calls.filter(([key]) =>
        String(key).startsWith('fixture-team-odds:v1:'),
      ),
    ).toHaveLength(1);

    get.mockClear();
    put.mockClear();
    putEarlierFixture.mockClear();
    const warmContext = createExecutionContext();
    const warmCache = new CloudflarePlayerStatsCache(
      namespace,
      604_800,
      14_400,
      warmContext,
    );

    const warmParts = await warmCache.getPartsMany([
      'first:Defender:no-low',
      'second:Defender:no-low',
    ]);
    await waitOnExecutionContext(warmContext);

    expect(warmParts.get('first:Defender:no-low')?.fixture).toMatchObject(
      fixture,
    );
    expect(warmParts.get('second:Defender:no-low')?.fixture).toMatchObject(
      fixture,
    );
    expect(putEarlierFixture).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
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

  it('refreshes historical metrics cached before player-scoped versions', async () => {
    const nowMs = Date.parse('2026-08-15T12:00:00.000Z');
    const key = `historical-club-scope-${nowMs}:Midfielder:no-low`;
    const cacheKey = `player-form:v3:${key}`;
    const store = new D1JsonKeyValueStore(
      env.CACHE_DB,
      env.STATS_CACHE,
      () => Math.floor(nowMs / 1_000),
    );
    await Promise.all([store.delete(cacheKey), env.STATS_CACHE.delete(cacheKey)]);
    const historical = {
      l10: { value: 0, sampleSize: 10 },
      l15: { value: 0, sampleSize: 15 },
      l40: { value: 1 / 29, sampleSize: 29 },
    };
    const staleForm = {
      slug: 'historical-club-scope',
      displayName: 'Historical Club Scope',
      position: 'Midfielder' as const,
      aaL10: { value: 24.3, sampleSize: 10 },
      aaL10TeamWinRate: { value: 0.4, sampleSize: 10 },
      cleanSheetL10: { value: 0, sampleSize: 10 },
      goalL10: { value: 0, sampleSize: 10 },
      historicalGoals: historical,
      historicalAssists: historical,
      historicalDecisives: historical,
      excludedLowCoverage: 0,
    };
    await store.put(cacheKey, JSON.stringify(staleForm), {
      expirationTtl: 3_600,
    });

    const context = createExecutionContext();
    const cache = new CloudflarePlayerStatsCache(
      store,
      604_800,
      14_400,
      context,
      () => nowMs,
    );

    await expect(cache.getParts(key)).resolves.toEqual({
      form: {
        slug: 'historical-club-scope',
        displayName: 'Historical Club Scope',
        position: 'Midfielder',
        aaL10: { value: 24.3, sampleSize: 10 },
        aaL10TeamWinRate: { value: 0.4, sampleSize: 10 },
        cleanSheetL10: { value: 0, sampleSize: 10 },
        goalL10: { value: 0, sampleSize: 10 },
        excludedLowCoverage: 0,
      },
    });

    await cache.setForm(key, staleForm);
    await waitOnExecutionContext(context);
    await expect(store.get(cacheKey, 'json')).resolves.toMatchObject({
      historicalGoals: historical,
      historicalGoalPlayerScopeVersion: 1,
      historicalAssistPlayerScopeVersion: 1,
      historicalDecisivePlayerScopeVersion: 1,
    });
    await expect(cache.getParts(key)).resolves.toMatchObject({
      form: { historicalGoals: historical },
    });
  });

  it('refreshes stale club-scoped assists without discarding valid goal history', async () => {
    const nowMs = Date.parse('2026-08-15T12:30:00.000Z');
    const key = `historical-assist-player-scope-${nowMs}:Midfielder:no-low`;
    const cacheKey = `player-form:v3:${key}`;
    const store = new D1JsonKeyValueStore(
      env.CACHE_DB,
      env.STATS_CACHE,
      () => Math.floor(nowMs / 1_000),
    );
    await Promise.all([store.delete(cacheKey), env.STATS_CACHE.delete(cacheKey)]);
    const historical = {
      l10: { value: 0.2, sampleSize: 10 },
      l15: { value: 0.2, sampleSize: 15 },
      l40: { value: 0.2, sampleSize: 40 },
    };
    await store.put(
      cacheKey,
      JSON.stringify({
        slug: 'historical-assist-player-scope',
        displayName: 'Historical Assist Player Scope',
        position: 'Midfielder',
        aaL10: { value: 24.3, sampleSize: 10 },
        aaL10TeamWinRate: { value: 0.4, sampleSize: 10 },
        cleanSheetL10: { value: 0, sampleSize: 10 },
        goalL10: { value: 0.2, sampleSize: 10 },
        historicalGoals: historical,
        historicalAssists: historical,
        historicalDecisives: historical,
        historicalClubScopeVersion: 1,
        historicalGoalPlayerScopeVersion: 1,
        excludedLowCoverage: 0,
      }),
      { expirationTtl: 3_600 },
    );

    const context = createExecutionContext();
    const cache = new CloudflarePlayerStatsCache(
      store,
      604_800,
      14_400,
      context,
      () => nowMs,
    );

    const parts = await cache.getParts(key);
    expect(parts.form?.historicalGoals).toEqual(historical);
    expect(parts.form?.historicalAssists).toBeUndefined();
    expect(parts.form?.historicalDecisives).toBeUndefined();
  });

  it('treats aggregate-only form entries as lazy enrichment misses', async () => {
    const key = 'aa-result-enrichment:Midfielder:no-low';
    const cacheKey = `player-form:v3:${key}`;
    const store = new D1JsonKeyValueStore(env.CACHE_DB, env.STATS_CACHE);
    await Promise.all([store.delete(cacheKey), env.STATS_CACHE.delete(cacheKey)]);
    await store.put(
      cacheKey,
      JSON.stringify({
        slug: 'aa-result-enrichment',
        displayName: 'AA Result Enrichment',
        position: 'Midfielder',
        aaL10: { value: 12, sampleSize: 10 },
        cleanSheetL10: { value: 0.2, sampleSize: 10 },
        goalL10: { value: 0.1, sampleSize: 10 },
        excludedLowCoverage: 0,
      }),
      { expirationTtl: 3_600 },
    );
    const context = createExecutionContext();
    const cache = new CloudflarePlayerStatsCache(
      store,
      604_800,
      14_400,
      context,
    );

    await expect(cache.getParts(key)).resolves.toEqual({});
    await waitOnExecutionContext(context);
    await expect(store.get(cacheKey, 'json')).resolves.toBeNull();
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
    expect(
      playerFixtureExpiration(
        '2026-07-25T18:00:00.000Z',
        14_400,
        Date.parse('2026-07-26T07:30:00.000Z'),
      ),
    ).toBe(Date.parse('2026-07-26T08:00:00.000Z') / 1_000);
    expect(fixtureOddsRefreshIntervalMs(20 * 60 * 60 * 1_000)).toBe(
      2 * 60 * 60 * 1_000,
    );
    expect(fixtureOddsRefreshIntervalMs(48 * 60 * 60 * 1_000)).toBe(
      6 * 60 * 60 * 1_000,
    );
    expect(fixtureOddsRefreshIntervalMs(96 * 60 * 60 * 1_000)).toBe(
      12 * 60 * 60 * 1_000,
    );
  });

  it('rechecks missing Sorare team odds only after a viewed fixture becomes due', async () => {
    let nowMs = Date.parse('2026-07-25T12:00:00.000Z');
    const fixture = {
      date: '2026-07-26T00:30:00.000Z',
      homeTeamName: 'Demand Home FC',
      awayTeamName: 'Demand Away FC',
      playerTeamName: 'Demand Home FC',
      opponentTeamName: 'Demand Away FC',
      cleanSheetProbability: null,
      matchProbabilities: { win: null, draw: null, loss: null },
    };
    const playerKey = 'demand-odds-player:Defender:no-low';
    const store = new D1JsonKeyValueStore(
      env.CACHE_DB,
      env.STATS_CACHE,
      () => Math.floor(nowMs / 1_000),
    );
    const context = createExecutionContext();
    const cache = new CloudflarePlayerStatsCache(
      store,
      604_800,
      14_400,
      context,
      () => nowMs,
    );

    await cache.setFixture(playerKey, fixture);
    await waitOnExecutionContext(context);
    await expect(cache.claimFixtureRefresh(fixture)).resolves.toBe(false);

    nowMs += 2 * 60 * 60 * 1_000 + 1_000;
    await expect(cache.claimFixtureRefresh(fixture)).resolves.toBe(true);
    await expect(cache.claimFixtureRefresh(fixture)).resolves.toBe(false);

    await cache.refreshFixture(playerKey, fixture);
    nowMs += 16 * 60 * 1_000;
    await expect(cache.claimFixtureRefresh(fixture)).resolves.toBe(false);

    nowMs = Date.parse(fixture.date) + 1_000;
    await expect(cache.claimFixtureRefresh(fixture)).resolves.toBe(false);
  });

  it('hydrates a missing cached player-team identity from a refreshed fixture', async () => {
    const nowMs = Date.parse('2026-08-19T18:00:00.000Z');
    const playerKey = 'stale-active-club-player:Midfielder:no-low';
    const store = new D1JsonKeyValueStore(
      env.CACHE_DB,
      env.STATS_CACHE,
      () => Math.floor(nowMs / 1_000),
    );
    const context = createExecutionContext();
    const cache = new CloudflarePlayerStatsCache(
      store,
      604_800,
      14_400,
      context,
      () => nowMs,
    );
    const unresolvedFixture = {
      date: '2026-08-19T23:30:00.000Z',
      homeTeamName: 'Philadelphia Union',
      awayTeamName: 'Inter Miami',
      homeTeamSlug: 'philadelphia-union-chester-pennsylvania',
      awayTeamSlug: 'inter-miami',
      playerTeamName: null,
      opponentTeamName: null,
      cleanSheetProbability: null,
      matchProbabilities: null,
    };
    await cache.setFixture(playerKey, unresolvedFixture);
    await waitOnExecutionContext(context);

    const refreshed = await cache.refreshFixture(playerKey, {
      ...unresolvedFixture,
      playerTeamName: 'Inter Miami',
      opponentTeamName: 'Philadelphia Union',
      playerTeamSlug: 'inter-miami',
      cleanSheetProbability: 0.31,
      matchProbabilities: { win: 0.52, draw: 0.24, loss: 0.24 },
    });

    expect(refreshed).toMatchObject({
      playerTeamName: 'Inter Miami',
      opponentTeamName: 'Philadelphia Union',
      playerTeamSlug: 'inter-miami',
      cleanSheetProbability: 0.31,
      matchProbabilities: { win: 0.52, draw: 0.24, loss: 0.24 },
    });
    await expect(cache.getParts(playerKey)).resolves.toMatchObject({
      fixture: {
        playerTeamName: 'Inter Miami',
        playerTeamSlug: 'inter-miami',
      },
    });
  });

  it('restores a held midnight team fixture over a later player fixture', async () => {
    const nowMs = Date.parse('2026-08-20T02:00:00.000Z');
    const store = new D1JsonKeyValueStore(
      env.CACHE_DB,
      env.STATS_CACHE,
      () => Math.floor(nowMs / 1_000),
    );
    const context = createExecutionContext();
    const cache = new CloudflarePlayerStatsCache(
      store,
      604_800,
      14_400,
      context,
      () => nowMs,
    );
    const heldFixture = {
      date: '2026-08-20T00:00:00.000Z',
      competitionSlug: 'uefa-europa-conference-league',
      homeTeamName: 'Motherwell',
      awayTeamName: 'Freiburg',
      playerTeamName: 'Freiburg',
      opponentTeamName: 'Motherwell',
      playerTeamSlug: 'freiburg-freiburg-im-breisgau',
      cleanSheetProbability: null,
      matchProbabilities: null,
    };
    const playerKey = 'midnight-team-player:Defender:no-low';
    await cache.setFixture(
      'midnight-team-source:Defender:no-low',
      heldFixture,
    );
    await cache.setFixture(playerKey, {
      date: '2026-08-30T13:30:00.000Z',
      competitionSlug: 'bundesliga-de',
      homeTeamName: 'Freiburg',
      awayTeamName: 'Werder Bremen',
      playerTeamName: 'Freiburg',
      opponentTeamName: 'Werder Bremen',
      cleanSheetProbability: null,
      matchProbabilities: null,
    });
    await waitOnExecutionContext(context);

    const shared = await cache.getTeamFixture(
      playerKey,
      'freiburg-freiburg-im-breisgau',
    );
    if (!shared) throw new Error('Expected held Freiburg fixture');
    const refreshed = await cache.refreshFixture(playerKey, shared);

    expect(refreshed).toMatchObject({
      date: heldFixture.date,
      homeTeamName: 'Motherwell',
      awayTeamName: 'Freiburg',
      playerTeamSlug: 'freiburg-freiburg-im-breisgau',
    });
    await expect(cache.getParts(playerKey)).resolves.toMatchObject({
      fixture: { date: heldFixture.date },
    });
  });

  it('shares the form-history refresh lease across cache instances', async () => {
    const nowMs = Date.now();
    const key = `form-history-lease-${nowMs}:Midfielder:no-low`;
    const store = new D1JsonKeyValueStore(
      env.CACHE_DB,
      env.STATS_CACHE,
      () => Math.floor(nowMs / 1_000),
    );
    const first = new CloudflarePlayerStatsCache(
      store,
      604_800,
      14_400,
      createExecutionContext(),
      () => nowMs,
    );
    const second = new CloudflarePlayerStatsCache(
      store,
      604_800,
      14_400,
      createExecutionContext(),
      () => nowMs,
    );

    const claims = await Promise.all([
      first.claimFormHistoryRefresh(key),
      second.claimFormHistoryRefresh(key),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('migrates and preserves an active fixture instead of accepting Sorare nextGame', async () => {
    const nowMs = Date.now();
    const currentFixtureDate = new Date(nowMs + 30 * 60 * 1_000).toISOString();
    const followingFixtureDate = new Date(
      nowMs + 7 * 24 * 60 * 60 * 1_000,
    ).toISOString();
    const key = `fixture-rollover-probe-${nowMs}:Defender:no-low`;
    const store = new D1JsonKeyValueStore(
      env.CACHE_DB,
      env.STATS_CACHE,
      () => Math.floor(nowMs / 1_000),
    );
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
      cachePolicyVersion: 3,
      nextGame: { date: currentFixtureDate },
    });
    expect(migratedRow?.expires_at).toBe(
      playerFixtureExpiration(currentFixtureDate, 14_400, duringMatchNowMs),
    );
  });

  it('does not revive a completed fixture after the morning rollover', async () => {
    const afterRolloverMs = Date.parse('2026-07-29T09:00:00.000Z');
    const key = 'expired-rollover-player:Defender:no-low';
    const canonicalKey =
      'player-fixture:v1:expired-rollover-player:auto-v3:no-low';
    const store = new D1JsonKeyValueStore(
      env.CACHE_DB,
      env.STATS_CACHE,
      () => Math.floor(afterRolloverMs / 1_000),
    );
    await Promise.all([
      store.delete(canonicalKey),
      env.STATS_CACHE.delete(canonicalKey),
    ]);
    await store.put(
      canonicalKey,
      JSON.stringify({
        cachePolicyVersion: 3,
        nextGame: {
          date: '2026-07-28T18:45:00.000Z',
          homeTeamName: 'Old Home',
          awayTeamName: 'Old Away',
          playerTeamName: 'Old Home',
          opponentTeamName: 'Old Away',
          cleanSheetProbability: 0.19,
          matchProbabilities: { win: 0.26, draw: 0.22, loss: 0.52 },
        },
      }),
      { expiration: Date.parse('2026-07-30T08:00:00.000Z') / 1_000 },
    );
    const context = createExecutionContext();
    const cache = new CloudflarePlayerStatsCache(
      store,
      604_800,
      14_400,
      context,
      () => afterRolloverMs,
    );
    const nextFixture = {
      date: '2026-08-01T15:00:00.000Z',
      homeTeamName: 'New Home',
      awayTeamName: 'New Away',
      playerTeamName: 'New Home',
      opponentTeamName: 'New Away',
      cleanSheetProbability: 0.35,
      matchProbabilities: { win: 0.49, draw: 0.26, loss: 0.25 },
    };

    await expect(cache.setFixture(key, nextFixture)).resolves.toMatchObject({
      date: nextFixture.date,
      cleanSheetProbability: 0.35,
    });
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
    const store = new D1JsonKeyValueStore(
      env.CACHE_DB,
      env.STATS_CACHE,
      () => Math.floor(nowMs / 1_000),
    );
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
      env.STATS_CACHE.delete(sharedKey),
      env.STATS_CACHE.delete(`player-fixture:v1:${autoKey}`),
      env.STATS_CACHE.delete(`player-fixture:v1:${defenderKey}`),
      env.STATS_CACHE.delete(`player-fixture:v1:${teammateKey}`),
      env.STATS_CACHE.delete(`player-fixture:v1:${awayKey}`),
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
      aaL10TeamWinRate: { value: 0.4, sampleSize: 10 },
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
      .bind(`player-fixture:v1:${autoKey}`)
      .first<{ expires_at: number }>();
    expect(playerFixtureRow?.expires_at).toBe(
      playerFixtureExpiration(fixture.date, 14_400, nowMs),
    );
  });

  it('keeps one held fixture across players using the canonical team slug', async () => {
    const nowMs = Date.parse('2026-07-28T22:30:00.000Z');
    const store = new D1JsonKeyValueStore(
      env.CACHE_DB,
      env.STATS_CACHE,
      () => Math.floor(nowMs / 1_000),
    );
    const teamKey = 'player-team-fixture:v2:shared-team';
    const heldKey = 'held-team-player:Defender:no-low';
    const coldKey = 'cold-team-player:Defender:no-low';
    const storedKeys = [
      teamKey,
      'player-team-fixture:v1:shared%20team',
      `player-form:v3:${heldKey}`,
      `player-form:v3:${coldKey}`,
      'player-fixture:v1:held-team-player:auto-v3:no-low',
      'player-fixture:v1:cold-team-player:auto-v3:no-low',
    ];
    await Promise.all(
      storedKeys.flatMap((key) => [
        store.delete(key),
        env.STATS_CACHE.delete(key),
      ]),
    );
    const coldContext = createExecutionContext();
    const heldContext = createExecutionContext();
    const coldCache = new CloudflarePlayerStatsCache(
      store,
      604_800,
      14_400,
      coldContext,
      () => nowMs,
    );
    const heldCache = new CloudflarePlayerStatsCache(
      store,
      604_800,
      14_400,
      heldContext,
      () => nowMs,
    );
    const form = {
      displayName: 'Team Fixture Player',
      position: 'Defender' as const,
      aaL10: { value: 12, sampleSize: 10 },
      aaL10TeamWinRate: { value: 0.4, sampleSize: 10 },
      cleanSheetL10: { value: 0.3, sampleSize: 10 },
      goalL10: { value: 0.1, sampleSize: 10 },
      excludedLowCoverage: 0,
    };
    const heldFixture = {
      date: '2026-07-28T18:45:00.000Z',
      homeTeamName: 'Previous Opponent',
      awayTeamName: 'Shared Team',
      playerTeamName: 'Shared Team',
      opponentTeamName: 'Previous Opponent',
      playerTeamSlug: 'shared-team',
      cleanSheetProbability: 0.19,
      matchProbabilities: { win: 0.26, draw: 0.22, loss: 0.52 },
      marketOdds: {
        source: 'mock' as const,
        capturedAt: '2026-07-28T12:00:00.000Z',
        goal: { probability: 0.2, bookmakerCount: 1 },
        assist: null,
      },
    };
    const nextFixture = {
      date: '2026-08-01T15:00:00.000Z',
      homeTeamName: 'Next Opponent',
      awayTeamName: 'Shared Team',
      playerTeamName: 'Shared Team',
      opponentTeamName: 'Next Opponent',
      playerTeamSlug: 'shared-team',
      cleanSheetProbability: 0.35,
      matchProbabilities: { win: 0.49, draw: 0.26, loss: 0.25 },
    };

    await Promise.all([
      coldCache.fillMissing(coldKey, {
        ...form,
        slug: 'cold-team-player',
        nextGame: nextFixture,
      }),
      heldCache.fillMissing(heldKey, {
        ...form,
        slug: 'held-team-player',
        nextGame: heldFixture,
      }),
    ]);
    await Promise.all([
      waitOnExecutionContext(coldContext),
      waitOnExecutionContext(heldContext),
    ]);

    const readContext = createExecutionContext();
    const readCache = new CloudflarePlayerStatsCache(
      store,
      604_800,
      14_400,
      readContext,
      () => nowMs,
    );
    await expect(readCache.get(coldKey)).resolves.toMatchObject({
      nextGame: {
        date: '2026-07-28T18:45:00.000Z',
        playerTeamName: 'Shared Team',
        cleanSheetProbability: 0.19,
      },
    });
    await expect(
      readCache.getTeamFixture(
        'isolated-team-player:Forward:no-low',
        'shared-team',
      ),
    ).resolves.toMatchObject({
      date: '2026-07-28T18:45:00.000Z',
      playerTeamSlug: 'shared-team',
      cleanSheetProbability: 0.19,
      matchProbabilities: { win: 0.26, draw: 0.22, loss: 0.52 },
    });
    const teamRow = await env.CACHE_DB.prepare(
      'SELECT value FROM cache_entries WHERE cache_key = ?1',
    )
      .bind(teamKey)
      .first<{ value: string }>();
    expect(JSON.parse(teamRow?.value ?? '{}').nextGame).not.toHaveProperty(
      'marketOdds',
    );
    expect(JSON.parse(teamRow?.value ?? '{}').nextGame).toMatchObject({
      playerTeamSlug: 'shared-team',
    });
    const legacyTeamRow = await env.CACHE_DB.prepare(
      'SELECT value FROM cache_entries WHERE cache_key = ?1',
    )
      .bind('player-team-fixture:v1:shared%20team')
      .first<{ value: string }>();
    expect(legacyTeamRow).toBeNull();
  });

  it('does not revive a delayed old team fixture after the morning rollover', async () => {
    const nowMs = Date.parse('2026-07-29T09:00:00.000Z');
    const store = new D1JsonKeyValueStore(
      env.CACHE_DB,
      env.STATS_CACHE,
      () => Math.floor(nowMs / 1_000),
    );
    const teamKey = 'player-team-fixture:v2:rollover-team';
    const nextKey = 'rollover-next-player:Defender:no-low';
    const delayedKey = 'rollover-delayed-player:Defender:no-low';
    await Promise.all(
      [
        teamKey,
        `player-form:v3:${nextKey}`,
        `player-form:v3:${delayedKey}`,
        'player-fixture:v1:rollover-next-player:auto-v3:no-low',
        'player-fixture:v1:rollover-delayed-player:auto-v3:no-low',
      ].flatMap((key) => [store.delete(key), env.STATS_CACHE.delete(key)]),
    );
    const form = {
      displayName: 'Rollover Player',
      position: 'Defender' as const,
      aaL10: { value: 12, sampleSize: 10 },
      cleanSheetL10: { value: 0.3, sampleSize: 10 },
      goalL10: { value: 0.1, sampleSize: 10 },
      excludedLowCoverage: 0,
    };
    const nextFixture = {
      date: '2026-08-01T15:00:00.000Z',
      homeTeamName: 'Rollover Team',
      awayTeamName: 'Next Opponent',
      playerTeamName: 'Rollover Team',
      opponentTeamName: 'Next Opponent',
      playerTeamSlug: 'rollover-team',
      cleanSheetProbability: 0.35,
      matchProbabilities: { win: 0.49, draw: 0.26, loss: 0.25 },
    };
    const delayedOldFixture = {
      ...nextFixture,
      date: '2026-07-28T18:45:00.000Z',
      awayTeamName: 'Previous Opponent',
      opponentTeamName: 'Previous Opponent',
      cleanSheetProbability: 0.19,
      matchProbabilities: { win: 0.26, draw: 0.22, loss: 0.52 },
    };
    const nextContext = createExecutionContext();
    const nextCache = new CloudflarePlayerStatsCache(
      store,
      604_800,
      14_400,
      nextContext,
      () => nowMs,
    );
    await nextCache.fillMissing(nextKey, {
      ...form,
      slug: 'rollover-next-player',
      nextGame: nextFixture,
    });
    await waitOnExecutionContext(nextContext);

    const delayedContext = createExecutionContext();
    const delayedCache = new CloudflarePlayerStatsCache(
      store,
      604_800,
      14_400,
      delayedContext,
      () => nowMs,
    );
    const delayed = await delayedCache.fillMissing(delayedKey, {
      ...form,
      slug: 'rollover-delayed-player',
      nextGame: delayedOldFixture,
    });
    await waitOnExecutionContext(delayedContext);

    expect(delayed.nextGame?.date).toBe(nextFixture.date);
    const teamRow = await env.CACHE_DB.prepare(
      'SELECT value FROM cache_entries WHERE cache_key = ?1',
    )
      .bind(teamKey)
      .first<{ value: string }>();
    expect(JSON.parse(teamRow?.value ?? '{}').nextGame.date).toBe(
      nextFixture.date,
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

  it('stores replayable provider evidence with an absolute expiration', async () => {
    const store = new CloudflareMarketSnapshotStore(
      env.STATS_CACHE,
      1_800,
      createExecutionContext(),
    );
    const fixtureKey = `${Date.now()}|evidence home|evidence away`;
    const expiration = Math.floor(
      (Date.now() + 24 * 60 * 60 * 1_000) / 1_000,
    );
    const evidence = {
      provider: 'odds-api-io',
      parserVersion: 2,
      markets: ['Player To Score or Assist'],
    };

    await store.setEvidence(
      fixtureKey,
      'odds-api-io',
      evidence,
      new Date(expiration * 1_000).toISOString(),
    );

    await expect(
      store.getEvidence(fixtureKey, 'odds-api-io'),
    ).resolves.toEqual(evidence);
    const listed = await env.STATS_CACHE.list({
      prefix: `market-evidence:v1:odds-api-io:${encodeURIComponent(
        fixtureKey,
      )}`,
    });
    expect(listed.keys).toHaveLength(1);
    expect(listed.keys[0]?.expiration).toBe(expiration);
  });

  it('persists provider team aliases by provider and normalized name', async () => {
    const probe = Date.now();
    const namespace = new D1JsonKeyValueStore(env.CACHE_DB, env.STATS_CACHE);
    const writer = new CloudflareMarketSnapshotStore(
      namespace,
      1_800,
      createExecutionContext(),
    );
    const reader = new CloudflareMarketSnapshotStore(
      namespace,
      1_800,
      createExecutionContext(),
    );
    const providerName = `NEC Nijmegen ${probe}`;

    await writer.setProviderTeamAliases('the-odds-api', [
      {
        providerTeamName: providerName,
        canonicalTeamSlug: 'nec-nijmegen',
      },
    ]);

    await expect(
      reader.getProviderTeamAliases('the-odds-api', [providerName]),
    ).resolves.toEqual(
      new Map([[normalizeTeamName(providerName), 'nec-nijmegen']]),
    );
    await expect(
      reader.getProviderTeamAliases('odds-api-io', [providerName]),
    ).resolves.toEqual(new Map());
  });

  it('reads multiple market snapshots through the D1 batch path', async () => {
    const probe = Date.now();
    const firstFixture = `${probe}|batch home one|batch away one`;
    const secondFixture = `${probe + 1}|batch home two|batch away two`;
    const store = new CloudflareMarketSnapshotStore(
      new D1JsonKeyValueStore(env.CACHE_DB, env.STATS_CACHE),
      1_800,
      createExecutionContext(),
    );
    await store.set(firstFixture, {
      status: 'available',
      market: 'player_goal_scorer_anytime',
      eventId: 'batch-fixture-1',
      capturedAt: '2026-07-24T12:00:00.000Z',
      players: {
        'first player': { probability: 0.4, bookmakerCount: 2 },
      },
    });
    await store.set(secondFixture, {
      status: 'available',
      market: 'player_assists',
      eventId: 'batch-fixture-2',
      capturedAt: '2026-07-24T12:00:00.000Z',
      players: {
        'second player': { probability: 0.3, bookmakerCount: 1 },
      },
    });

    await expect(
      store.getMany([
        { fixtureKey: firstFixture, market: 'player_goal_scorer_anytime' },
        { fixtureKey: secondFixture, market: 'player_assists' },
        { fixtureKey: secondFixture, market: 'player_goal_or_assist' },
      ]),
    ).resolves.toMatchObject([
      { status: 'available', eventId: 'batch-fixture-1' },
      { status: 'available', eventId: 'batch-fixture-2' },
      undefined,
    ]);
  });

  it('coordinates market refreshes and supplement batches through D1', async () => {
    const probe = Date.now();
    const fixtureKey = `${probe}|lease home|lease away`;
    const requestGroup = 'the-odds-api:soccer_usa_mls:us:player-props';
    const namespace = new D1JsonKeyValueStore(env.CACHE_DB, env.STATS_CACHE);
    const first = new CloudflareMarketSnapshotStore(
      namespace,
      1_800,
      createExecutionContext(),
    );
    const second = new CloudflareMarketSnapshotStore(
      namespace,
      1_800,
      createExecutionContext(),
    );

    const claims = await Promise.all([
      first.claimRefreshLease(fixtureKey, requestGroup, 90_000),
      second.claimRefreshLease(fixtureKey, requestGroup, 90_000),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);

    await Promise.all([
      first.enqueueSupplementPlayers(
        fixtureKey,
        requestGroup,
        [
          {
            slug: 'first-player',
            displayName: 'First Player',
            position: 'Forward',
          },
        ],
        1_500,
        15 * 60 * 1_000,
      ),
      second.enqueueSupplementPlayers(
        fixtureKey,
        requestGroup,
        [
          {
            slug: 'second-player',
            displayName: 'Second Player',
            position: 'Midfielder',
          },
        ],
        1_500,
        15 * 60 * 1_000,
      ),
    ]);

    await expect(
      first.getSupplementBatch(fixtureKey, requestGroup),
    ).resolves.toMatchObject({
      players: expect.arrayContaining([
        expect.objectContaining({ slug: 'first-player' }),
        expect.objectContaining({ slug: 'second-player' }),
      ]),
    });
    await first.clearSupplementBatch(fixtureKey, requestGroup);
    await expect(
      second.getSupplementBatch(fixtureKey, requestGroup),
    ).resolves.toBeUndefined();
  });

  it('atomically coordinates Sorare fixture-odds refreshes through D1', async () => {
    const nowMs = Date.now();
    const fixture = {
      date: new Date(nowMs + 24 * 60 * 60 * 1_000).toISOString(),
      homeTeamName: `Lease Home ${nowMs}`,
      awayTeamName: `Lease Away ${nowMs}`,
      playerTeamName: `Lease Home ${nowMs}`,
      opponentTeamName: `Lease Away ${nowMs}`,
      cleanSheetProbability: null,
      matchProbabilities: { win: null, draw: null, loss: null },
    };
    const first = new CloudflarePlayerStatsCache(
      new D1JsonKeyValueStore(
        env.CACHE_DB,
        env.STATS_CACHE,
        () => Math.floor(nowMs / 1_000),
      ),
      604_800,
      14_400,
      createExecutionContext(),
      () => nowMs,
    );
    const second = new CloudflarePlayerStatsCache(
      new D1JsonKeyValueStore(
        env.CACHE_DB,
        env.STATS_CACHE,
        () => Math.floor(nowMs / 1_000),
      ),
      604_800,
      14_400,
      createExecutionContext(),
      () => nowMs,
    );

    const claims = await Promise.all([
      first.claimFixtureRefresh(fixture),
      second.claimFixtureRefresh(fixture),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
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
      env.STATS_CACHE.list({ prefix: 'player-form:v3:ttl-probe:' }),
      env.STATS_CACHE.list({ prefix: 'player-fixture:v1:ttl-probe:' }),
      env.STATS_CACHE.list({ prefix: 'player-name:v5:ttl%20positive%20probe:' }),
      env.STATS_CACHE.list({ prefix: 'player-name:v5:ttl%20negative%20probe:' }),
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

  it('migrates v7 team-name hits but ignores stale v7 misses', async () => {
    const positiveV7 =
      'player-name:v7:legacy%20transfer%20hit:Midfielder:inter-miami';
    const negativeV7 =
      'player-name:v7:legacy%20transfer%20miss:Midfielder:inter-miami';
    await Promise.all([
      env.STATS_CACHE.put(
        positiveV7,
        JSON.stringify({
          found: true,
          value: {
            slug: 'legacy-transfer-hit',
            position: 'Midfielder',
            teamSlug: 'inter-miami',
            nameResolution: 'search',
          },
        }),
      ),
      env.STATS_CACHE.put(negativeV7, JSON.stringify({ found: false })),
    ]);
    const context = createExecutionContext();
    const cache = new CloudflareNameResolutionCache(
      env.STATS_CACHE,
      2_592_000,
      7_200,
      context,
    );

    await expect(
      cache.get('Legacy Transfer Hit', 'Midfielder', 'inter-miami'),
    ).resolves.toMatchObject({
      slug: 'legacy-transfer-hit',
      teamSlug: 'inter-miami',
    });
    await expect(
      cache.get('Legacy Transfer Miss', 'Midfielder', 'inter-miami'),
    ).resolves.toBeUndefined();
    await waitOnExecutionContext(context);

    await expect(
      env.STATS_CACHE.get(
        'player-name:v8:legacy%20transfer%20hit:Midfielder:inter-miami',
      ),
    ).resolves.not.toBeNull();
    await expect(
      env.STATS_CACHE.get(
        'player-name:v8:legacy%20transfer%20miss:Midfielder:inter-miami',
      ),
    ).resolves.toBeNull();
  });

  it('lazily refreshes a viewed v1 fixture that predates player-relative team names', async () => {
    const cacheKey = 'team-name-migration-probe:Midfielder:no-low';
    const fixtureDate = new Date(
      Date.now() + 24 * 60 * 60 * 1_000,
    ).toISOString();
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
      aaL10TeamWinRate: { value: 0.4, sampleSize: 10 },
      cleanSheetL10: { value: 0.2, sampleSize: 10 },
      goalL10: { value: 0.3, sampleSize: 10 },
      nextGame: {
        date: fixtureDate,
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
      prefix:
        'player-fixture:v1:team-name-migration-probe:auto-v3:no-low',
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
