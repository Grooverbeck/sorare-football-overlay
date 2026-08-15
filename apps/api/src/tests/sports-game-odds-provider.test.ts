import type {
  PlayerMarketOdds,
  PlayerStats,
} from '@sorare-overlay/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../logger.js';
import {
  InMemoryMarketSnapshotStore,
  playerMarketOddsKey,
  type MarketSnapshotStore,
  type PlayerMarketOddsProvider,
} from '../providers/market-odds-provider.js';
import {
  InMemoryMatchOddsSnapshotStore,
} from '../providers/match-odds-provider.js';
import {
  InMemoryProviderQuotaUsageStore,
  quotaUsage,
} from '../providers/odds-usage.js';
import {
  SportsGameOddsFixtureMatchOddsProvider,
  SportsGameOddsPlayerMarketOddsProvider,
  SupplementingPlayerMarketOddsProvider,
  sportsGameOddsFixtureStoreKey,
  sportsGameOddsQuotaUsage,
} from '../providers/sports-game-odds-provider.js';

const logger: AppLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const now = Date.parse('2026-07-25T10:00:00.000Z');
const kickoff = '2026-07-25T23:30:00.000Z';

function player(overrides: Partial<PlayerStats> = {}): PlayerStats {
  return {
    slug: 'timo-werner',
    displayName: 'Timo Werner',
    position: 'Forward',
    aaL10: { value: 12, sampleSize: 10 },
    cleanSheetL10: { value: 0, sampleSize: 10 },
    goalL10: { value: 0.2, sampleSize: 10 },
    nextGame: {
      date: kickoff,
      homeTeamName: 'Chicago Fire',
      awayTeamName: 'Atlanta United',
      playerTeamName: 'Chicago Fire',
      opponentTeamName: 'Atlanta United',
      cleanSheetProbability: null,
      matchProbabilities: { win: 0.4, draw: 0.3, loss: 0.3 },
    },
    excludedLowCoverage: 0,
    ...overrides,
  };
}

function market(
  oddID: string,
  opposingOddID: string,
  statID: string,
  sideID: 'yes' | 'no',
  odds: string,
) {
  return {
    oddID,
    opposingOddID,
    statID,
    statEntityID: 'TIMO_WERNER_1_MLS',
    periodID: 'game',
    betTypeID: 'yn',
    sideID,
    playerID: 'TIMO_WERNER_1_MLS',
    byBookmaker: {
      fanduel: { odds, available: true },
    },
  };
}

function matchMarket(
  sideID: 'home' | 'draw' | 'away',
  odds: string,
) {
  return {
    oddID: `points-all-reg-ml3way-${sideID}`,
    statID: 'points',
    statEntityID: 'all',
    periodID: 'reg',
    betTypeID: 'ml3way',
    sideID,
    byBookmaker: {
      fanduel: { odds, available: true },
    },
  };
}

function eventsEnvelope() {
  const pairs = [
    ['points', '+150', '-200'],
    ['assists', '+400', '-600'],
    ['goals+assists', '+120', '-150'],
  ] as const;
  const odds = Object.fromEntries([
    ...pairs.flatMap(([statID, yesOdds, noOdds]) => {
      const yes = `${statID}-TIMO_WERNER_1_MLS-game-yn-yes`;
      const no = `${statID}-TIMO_WERNER_1_MLS-game-yn-no`;
      return [
        [yes, market(yes, no, statID, 'yes', yesOdds)],
        [no, market(no, yes, statID, 'no', noOdds)],
      ];
    }),
    [
      'points-all-reg-ml3way-home',
      matchMarket('home', '+120'),
    ],
    [
      'points-all-reg-ml3way-draw',
      matchMarket('draw', '+240'),
    ],
    [
      'points-all-reg-ml3way-away',
      matchMarket('away', '+230'),
    ],
  ]);
  return {
    success: true,
    data: [
      {
        eventID: 'sgo-fixture-1',
        leagueID: 'MLS',
        teams: {
          home: {
            teamID: 'CHICAGO_FIRE_MLS',
            names: { long: 'Chicago Fire FC' },
          },
          away: {
            teamID: 'ATLANTA_UNITED_MLS',
            names: { long: 'Atlanta United FC' },
          },
        },
        status: { startsAt: kickoff },
        players: {
          TIMO_WERNER_1_MLS: {
            playerID: 'TIMO_WERNER_1_MLS',
            name: 'Timo Werner',
          },
        },
        odds,
      },
    ],
  };
}

describe('SportsGameOddsPlayerMarketOddsProvider', () => {
  it('parses the monthly object allowance from the documented usage response', () => {
    expect(
      sportsGameOddsQuotaUsage(
        {
          success: true,
          data: {
            rateLimits: {
              'per-month': {
                'max-entities': 2_500,
                'current-entities': 914,
                currentIntervalStartTime: '2026-07-01T00:00:00.000Z',
                currentIntervalEndTime: '2026-08-01T00:00:00.000Z',
              },
            },
          },
        },
        '2026-07-25T10:00:00.000Z',
      ),
    ).toEqual({
      provider: 'sports-game-odds',
      unit: 'objects',
      used: 914,
      limit: 2_500,
      remaining: 1_586,
      interval: {
        unit: 'month',
        startsAt: '2026-07-01T00:00:00.000Z',
        endsAt: '2026-08-01T00:00:00.000Z',
      },
      checkedAt: '2026-07-25T10:00:00.000Z',
    });
  });

  it('refreshes and persists provider usage through the free account endpoint', async () => {
    const usageStore = new InMemoryProviderQuotaUsageStore();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            rateLimits: {
              'per-month': {
                maxEntitiesPerInterval: 2_500,
                currentIntervalEntities: 1_250,
              },
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const provider = new SportsGameOddsPlayerMarketOddsProvider({
      apiKey: 'secret-test-key',
      baseUrl: 'https://api.sportsgameodds.com/v2',
      leagueId: 'MLS',
      fetchWindowMs: 24 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(60_000, () => now),
      usageStore,
      logger,
      fetchImpl,
      now: () => now,
    });

    const refreshed = await provider.refreshUsage();

    expect(refreshed[0]).toMatchObject({
      provider: 'sports-game-odds',
      used: 1_250,
      limit: 2_500,
    });
    expect(await usageStore.get('sports-game-odds')).toEqual(refreshed[0]);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('/account/usage');
  });

  it('does not duplicate the account usage request for secondary league providers', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new SportsGameOddsPlayerMarketOddsProvider({
      apiKey: 'secret-test-key',
      baseUrl: 'https://api.sportsgameodds.com/v2',
      leagueId: 'UEFA_CHAMPIONS_LEAGUE',
      fetchWindowMs: 24 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(60_000, () => now),
      logger,
      refreshUsage: false,
      fetchImpl,
      now: () => now,
    });

    await expect(provider.refreshUsage()).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not request MLS objects for a different Sorare competition', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new SportsGameOddsPlayerMarketOddsProvider({
      apiKey: 'secret-test-key',
      baseUrl: 'https://api.sportsgameodds.com/v2',
      leagueId: 'MLS',
      fetchWindowMs: 24 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(60_000, () => now),
      logger,
      fetchImpl,
      now: () => now,
    });
    const unsupported = player({
      nextGame: {
        ...player().nextGame!,
        competitionSlug: 'super-lig',
        homeTeamName: 'Fenerbahce',
        awayTeamName: 'Galatasaray',
      },
    });

    const result = await provider.load([unsupported]);

    expect(result.get(playerMarketOddsKey(unsupported))).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('continues refreshing fixtures above the former 85 percent threshold', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(eventsEnvelope()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const usageStore = new InMemoryProviderQuotaUsageStore();
    const usage = quotaUsage(
      'sports-game-odds',
      'objects',
      2_125,
      2_500,
      new Date(now).toISOString(),
    );
    if (!usage) throw new Error('Expected finite SportsGameOdds usage');
    usageStore.set(usage);
    const stats = player();
    const provider = new SportsGameOddsPlayerMarketOddsProvider({
      apiKey: 'secret-test-key',
      baseUrl: 'https://api.sportsgameodds.com/v2',
      leagueId: 'MLS',
      fetchWindowMs: 24 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(60_000, () => now),
      usageStore,
      logger,
      fetchImpl,
      now: () => now,
    });

    const result = await provider.load([stats]);

    expect(result.get(playerMarketOddsKey(stats))).toMatchObject({
      source: 'sports-game-odds',
      goal: { probability: expect.any(Number) },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('still honors a real HTTP 429 response and its retry delay', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 429,
          headers: { 'retry-after': '0' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(eventsEnvelope()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const sleep = vi.fn(async () => undefined);
    const stats = player();
    const provider = new SportsGameOddsPlayerMarketOddsProvider({
      apiKey: 'secret-test-key',
      baseUrl: 'https://api.sportsgameodds.com/v2',
      leagueId: 'MLS',
      fetchWindowMs: 24 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 1,
      store: new InMemoryMarketSnapshotStore(60_000, () => now),
      logger,
      fetchImpl,
      sleep,
      now: () => now,
    });

    const result = await provider.load([stats]);

    expect(result.get(playerMarketOddsKey(stats))?.goal).not.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(0);
  });

  it('loads direct goal, assist and goals-or-assists markets with no-vig bookmaker probabilities', async () => {
    const usageStore = new InMemoryProviderQuotaUsageStore();
    const usage = quotaUsage(
      'sports-game-odds',
      'objects',
      100,
      2_500,
      new Date(now).toISOString(),
    );
    if (!usage) throw new Error('Expected finite SportsGameOdds usage');
    usageStore.set(usage);
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('x-api-key')).toBe('secret-test-key');
      return new Response(JSON.stringify(eventsEnvelope()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const stats = player();
    const provider = new SportsGameOddsPlayerMarketOddsProvider({
      apiKey: 'secret-test-key',
      baseUrl: 'https://api.sportsgameodds.com/v2',
      leagueId: 'MLS',
      fetchWindowMs: 24 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(60_000, () => now),
      usageStore,
      logger,
      fetchImpl,
      now: () => now,
    });

    const result = await provider.load([stats]);
    const odds = result.get(playerMarketOddsKey(stats));

    expect(odds).toMatchObject({
      source: 'sports-game-odds',
      goal: {
        probability: 0.375,
        bookmakerCount: 1,
        bookmakerQuotes: [{ key: 'fanduel', title: 'FanDuel' }],
      },
      assist: {
        bookmakerCount: 1,
      },
      decisive: {
        bookmakerCount: 1,
      },
    });
    expect(odds?.assist?.probability).toBeCloseTo(0.1895, 3);
    expect(odds?.decisive?.probability).toBeCloseTo(0.431, 3);
    const requestUrl = String(fetchImpl.mock.calls[0]?.[0]);
    expect(requestUrl).toContain('leagueID=MLS');
    expect(requestUrl).toContain('limit=25');
    expect(requestUrl).not.toContain('apiKey');
    expect(await usageStore.get('sports-game-odds')).toMatchObject({
      used: 101,
      remaining: 2_399,
    });
  });

  it('fills player props and H-D-A from one concurrent event request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(eventsEnvelope()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const stats = player();
    const source = new SportsGameOddsPlayerMarketOddsProvider({
      apiKey: 'secret-test-key',
      baseUrl: 'https://api.sportsgameodds.com/v2',
      leagueId: 'MLS',
      fetchWindowMs: 24 * 60 * 60 * 1_000,
      matchOddsFetchWindowMs: 24 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(60_000, () => now),
      matchOddsStore: new InMemoryMatchOddsSnapshotStore(() => now),
      logger,
      fetchImpl,
      now: () => now,
    });
    const matchProvider = new SportsGameOddsFixtureMatchOddsProvider(source);

    const [playerValues, matchValues] = await Promise.all([
      source.load([stats]),
      matchProvider.load([stats]),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(playerValues.get(playerMarketOddsKey(stats))).toMatchObject({
      goal: { probability: expect.any(Number) },
      assist: { probability: expect.any(Number) },
    });
    const match = matchValues.get(playerMarketOddsKey(stats));
    expect(match).toMatchObject({
      win: expect.any(Number),
      draw: expect.any(Number),
      loss: expect.any(Number),
    });
    expect((match?.win ?? 0) + (match?.draw ?? 0) + (match?.loss ?? 0)).toBeCloseTo(
      1,
      8,
    );
    expect(match?.win).toBeGreaterThan(match?.loss ?? 1);
  });

  it('targets a known fixture by event ID on a later market check', async () => {
    const store = new InMemoryMarketSnapshotStore(60_000, () => now);
    const stats = player();
    const fixtureKey = sportsGameOddsFixtureStoreKey(stats.nextGame!);
    if (!fixtureKey) throw new Error('Expected fixture key');
    store.set(fixtureKey, {
      status: 'unavailable',
      market: 'player_goal_scorer_anytime',
      eventId: 'sgo-fixture-1',
      checkedAt: new Date(now - 13 * 60 * 60 * 1_000).toISOString(),
      attemptCount: 1,
      nextRetryAt: new Date(now - 1).toISOString(),
      expiresAt: new Date(Date.parse(kickoff) + 24 * 60 * 60 * 1_000).toISOString(),
    });
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(eventsEnvelope()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const provider = new SportsGameOddsPlayerMarketOddsProvider({
      apiKey: 'secret-test-key',
      baseUrl: 'https://api.sportsgameodds.com/v2',
      leagueId: 'MLS',
      fetchWindowMs: 24 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store,
      logger,
      supportedMarkets: ['goal'],
      fetchImpl,
      now: () => now,
    });

    const result = await provider.load([stats]);

    expect(result.get(playerMarketOddsKey(stats))?.goal).not.toBeNull();
    const requestUrl = String(fetchImpl.mock.calls[0]?.[0]);
    expect(requestUrl).toContain('eventIDs=sgo-fixture-1');
    expect(requestUrl).not.toContain('leagueID=');
  });

  it('uses configured markets as request drivers without claiming assist support', () => {
    const stats = player({
      nextGame: {
        ...player().nextGame!,
        competitionSlug: 'ligue-2-fr',
      },
    });
    const provider = new SportsGameOddsPlayerMarketOddsProvider({
      apiKey: 'secret-test-key',
      baseUrl: 'https://api.sportsgameodds.com/v2',
      leagueId: 'FR_LIGUE_2',
      fetchWindowMs: 24 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(60_000, () => now),
      logger,
      supportedCompetitionSlugs: ['ligue-2-fr'],
      supportedMarkets: ['goal'],
      fetchImpl: vi.fn<typeof fetch>(),
      now: () => now,
    });

    expect(provider.supportsMarket(stats, 'goal')).toBe(true);
    expect(provider.supportsMarket(stats, 'assist')).toBe(false);
  });

  it('routes an explicitly supported Champions League fixture to its league feed', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(eventsEnvelope()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const stats = player({
      nextGame: {
        ...player().nextGame!,
        competitionSlug: 'uefa-champions-league',
      },
    });
    const provider = new SportsGameOddsPlayerMarketOddsProvider({
      apiKey: 'secret-test-key',
      baseUrl: 'https://api.sportsgameodds.com/v2',
      leagueId: 'UEFA_CHAMPIONS_LEAGUE',
      fetchWindowMs: 24 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(60_000, () => now),
      logger,
      supportedCompetitionSlugs: ['uefa-champions-league'],
      fetchImpl,
      now: () => now,
    });

    const result = await provider.load([stats]);

    expect(result.get(playerMarketOddsKey(stats))).toMatchObject({
      source: 'sports-game-odds',
      goal: { probability: expect.any(Number) },
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
      'leagueID=UEFA_CHAMPIONS_LEAGUE',
    );
  });

  it('freezes a successful event snapshot instead of spending another object', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(eventsEnvelope()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const stats = player();
    const provider = new SportsGameOddsPlayerMarketOddsProvider({
      apiKey: 'secret-test-key',
      baseUrl: 'https://api.sportsgameodds.com/v2',
      leagueId: 'MLS',
      fetchWindowMs: 24 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(60_000, () => now),
      logger,
      fetchImpl,
      now: () => now,
    });

    await provider.load([stats]);
    await provider.load([stats]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not requery a frozen fixture immediately for another missing player', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(eventsEnvelope()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const store = new InMemoryMarketSnapshotStore(60_000, () => now);
    const provider = new SportsGameOddsPlayerMarketOddsProvider({
      apiKey: 'secret-test-key',
      baseUrl: 'https://api.sportsgameodds.com/v2',
      leagueId: 'MLS',
      fetchWindowMs: 24 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store,
      logger,
      fetchImpl,
      now: () => now,
    });
    const listed = player();
    const missing = player({
      slug: 'antoine-griezmann',
      displayName: 'Antoine Griezmann',
    });

    await provider.load([listed]);
    const result = await provider.load([missing]);

    expect(result.get(playerMarketOddsKey(missing))).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('deduplicates a concurrent fixture refresh across provider instances sharing a store', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(eventsEnvelope()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const store = new InMemoryMarketSnapshotStore(60_000, () => now);
    const createProvider = () =>
      new SportsGameOddsPlayerMarketOddsProvider({
        apiKey: 'secret-test-key',
        baseUrl: 'https://api.sportsgameodds.com/v2',
        leagueId: 'MLS',
        fetchWindowMs: 24 * 60 * 60 * 1_000,
        requestTimeoutMs: 1_000,
        maxRetries: 0,
        store,
        logger,
        fetchImpl,
        now: () => now,
      });
    const stats = player();

    const results = await Promise.all([
      createProvider().load([stats]),
      createProvider().load([stats]),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(
      results.some((result) =>
        Boolean(result.get(playerMarketOddsKey(stats))?.goal),
      ),
    ).toBe(true);
  });

  it('keeps a cached market when another market key fails to read', async () => {
    const stats = player();
    const fixtureKey = sportsGameOddsFixtureStoreKey(stats.nextGame!);
    if (!fixtureKey) throw new Error('Expected fixture key');
    const backingStore = new InMemoryMarketSnapshotStore(60_000, () => now);
    backingStore.set(fixtureKey, {
      status: 'available',
      market: 'player_goal_scorer_anytime',
      eventId: 'fixture-1',
      capturedAt: new Date(now).toISOString(),
      players: {
        'timo werner': { probability: 0.4, bookmakerCount: 1 },
      },
    });
    const store: MarketSnapshotStore = {
      get: async (key, market) => {
        if (market === 'player_assists') {
          throw new Error('isolated assist cache read failure');
        }
        return backingStore.get(key, market);
      },
      set: (key, snapshot) => backingStore.set(key, snapshot),
    };
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new SportsGameOddsPlayerMarketOddsProvider({
      apiKey: 'secret-test-key',
      baseUrl: 'https://api.sportsgameodds.com/v2',
      leagueId: 'MLS',
      fetchWindowMs: 24 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store,
      logger,
      fetchImpl,
      now: () => now,
    });

    const cached = await provider.load([stats], { cacheOnly: true });

    expect(cached.get(playerMarketOddsKey(stats))).toMatchObject({
      goal: { probability: 0.4 },
      assist: null,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps an existing cached market when its D1 read exceeds the legacy per-read budget', async () => {
    const stats = player();
    const fixtureKey = sportsGameOddsFixtureStoreKey(stats.nextGame!);
    if (!fixtureKey) throw new Error('Expected fixture key');
    const backingStore = new InMemoryMarketSnapshotStore(60_000, () => now);
    backingStore.set(fixtureKey, {
      status: 'available',
      market: 'player_assists',
      eventId: 'fixture-1',
      capturedAt: new Date(now).toISOString(),
      players: {
        'timo werner': { probability: 0.31, bookmakerCount: 1 },
      },
    });
    const store: MarketSnapshotStore = {
      get: async (key, market) => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return backingStore.get(key, market);
      },
      set: (key, snapshot) => backingStore.set(key, snapshot),
    };
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new SportsGameOddsPlayerMarketOddsProvider({
      apiKey: 'secret-test-key',
      baseUrl: 'https://api.sportsgameodds.com/v2',
      leagueId: 'MLS',
      fetchWindowMs: 24 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store,
      logger,
      fetchImpl,
      now: () => now,
    });

    const cached = await provider.load([stats], {
      cacheOnly: true,
      cacheOnlyDeadlineMs: Date.now() + 250,
    });

    expect(cached.get(playerMarketOddsKey(stats))).toMatchObject({
      goal: null,
      assist: { probability: 0.31 },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('loads all fixture markets through one cache batch read', async () => {
    const first = player();
    const second = player({
      slug: 'second-player',
      displayName: 'Second Player',
      nextGame: {
        ...player().nextGame!,
        date: '2026-07-26T00:30:00.000Z',
        competitionSlug: 'mlspa',
        awayTeamName: 'Second Away FC',
        opponentTeamName: 'Second Away FC',
      },
    });
    const firstKey = sportsGameOddsFixtureStoreKey(first.nextGame!);
    const secondKey = sportsGameOddsFixtureStoreKey(second.nextGame!);
    if (!firstKey || !secondKey) throw new Error('Expected fixture keys');
    const backingStore = new InMemoryMarketSnapshotStore(60_000, () => now);
    backingStore.set(firstKey, {
      status: 'available',
      market: 'player_assists',
      eventId: 'fixture-1',
      capturedAt: new Date(now).toISOString(),
      players: {
        'timo werner': { probability: 0.31, bookmakerCount: 1 },
      },
    });
    backingStore.set(secondKey, {
      status: 'available',
      market: 'player_assists',
      eventId: 'fixture-2',
      capturedAt: new Date(now).toISOString(),
      players: {
        'second player': { probability: 0.27, bookmakerCount: 1 },
      },
    });
    const get = vi.fn<MarketSnapshotStore['get']>(async () => {
      throw new Error('Individual cache reads must not be used');
    });
    const getMany = vi.fn<NonNullable<MarketSnapshotStore['getMany']>>(
      async (requests) =>
        Promise.all(
          requests.map(({ fixtureKey, market }) =>
            backingStore.get(fixtureKey, market),
          ),
        ),
    );
    const store: MarketSnapshotStore = {
      get,
      getMany,
      set: (key, snapshot) => backingStore.set(key, snapshot),
    };
    const provider = new SportsGameOddsPlayerMarketOddsProvider({
      apiKey: 'secret-test-key',
      baseUrl: 'https://api.sportsgameodds.com/v2',
      leagueId: 'MLS',
      fetchWindowMs: 24 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store,
      logger,
      fetchImpl: vi.fn<typeof fetch>(),
      now: () => now,
    });

    const cached = await provider.load([first, second], {
      cacheOnly: true,
      cacheOnlyDeadlineMs: Date.now() + 250,
    });

    expect(getMany).toHaveBeenCalledTimes(1);
    expect(getMany.mock.calls[0]?.[0]).toHaveLength(6);
    expect(get).not.toHaveBeenCalled();
    expect(cached.get(playerMarketOddsKey(first))?.assist?.probability).toBe(0.31);
    expect(cached.get(playerMarketOddsKey(second))?.assist?.probability).toBe(0.27);
  });

  it('propagates a normal-path cache read failure before contacting the external API', async () => {
    const stats = player();
    const failure = new Error('normal SportsGameOdds cache read failure');
    const store: MarketSnapshotStore = {
      get: async (_key, market) => {
        if (market === 'player_assists') throw failure;
        return undefined;
      },
      set: () => undefined,
    };
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new SportsGameOddsPlayerMarketOddsProvider({
      apiKey: 'secret-test-key',
      baseUrl: 'https://api.sportsgameodds.com/v2',
      leagueId: 'MLS',
      fetchWindowMs: 24 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store,
      logger,
      fetchImpl,
      now: () => now,
    });

    await expect(provider.load([stats])).rejects.toBe(failure);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps a later cached fixture when earlier fixture reads hang', async () => {
    const earlyPlayers = [0, 1].map((offset) =>
      player({
        slug: `early-player-${offset}`,
        displayName: `Early Player ${offset}`,
        nextGame: {
          ...player().nextGame!,
          date: new Date(Date.parse(kickoff) + offset * 60_000).toISOString(),
        },
      }),
    );
    const healthyPlayer = player({
      slug: 'healthy-player',
      displayName: 'Healthy Player',
      nextGame: {
        ...player().nextGame!,
        date: new Date(Date.parse(kickoff) + 2 * 60_000).toISOString(),
      },
    });
    const earlyKeys = new Set(
      earlyPlayers.map((stats) => {
        const key = sportsGameOddsFixtureStoreKey(stats.nextGame!);
        if (!key) throw new Error('Expected early fixture key');
        return key;
      }),
    );
    const healthyKey = sportsGameOddsFixtureStoreKey(healthyPlayer.nextGame!);
    if (!healthyKey) throw new Error('Expected healthy fixture key');
    const backingStore = new InMemoryMarketSnapshotStore(60_000, () => now);
    backingStore.set(healthyKey, {
      status: 'available',
      market: 'player_goal_scorer_anytime',
      eventId: 'healthy-fixture',
      capturedAt: new Date(now).toISOString(),
      players: {
        'healthy player': { probability: 0.41, bookmakerCount: 1 },
      },
    });
    const store: MarketSnapshotStore = {
      get: (key, market) =>
        earlyKeys.has(key)
          ? new Promise(() => undefined)
          : backingStore.get(key, market),
      set: (key, snapshot) => backingStore.set(key, snapshot),
    };
    const provider = new SportsGameOddsPlayerMarketOddsProvider({
      apiKey: 'secret-test-key',
      baseUrl: 'https://api.sportsgameodds.com/v2',
      leagueId: 'MLS',
      fetchWindowMs: 24 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store,
      logger,
      fetchImpl: vi.fn<typeof fetch>(),
      now: () => now,
    });
    const emptyFallback: PlayerMarketOddsProvider = {
      load: async () => new Map(),
      supportsMarket: () => false,
    };
    const bounded = new SupplementingPlayerMarketOddsProvider(
      provider,
      emptyFallback,
      ['goal'],
      180,
    );

    const cached = await bounded.load(
      [...earlyPlayers, healthyPlayer],
      { cacheOnly: true },
    );

    expect(cached.get(playerMarketOddsKey(healthyPlayer))).toMatchObject({
      goal: { probability: 0.41 },
    });
  });
});

describe('SupplementingPlayerMarketOddsProvider', () => {
  it('keeps the direct decisive market and fills missing split markets from the fallback', async () => {
    const stats = player();
    const primaryOdds: PlayerMarketOdds = {
      source: 'sports-game-odds',
      capturedAt: '2026-07-25T10:00:00.000Z',
      goal: null,
      assist: { probability: 0.2, bookmakerCount: 1 },
      decisive: { probability: 0.43, bookmakerCount: 1 },
    };
    const fallbackOdds: PlayerMarketOdds = {
      source: 'the-odds-api',
      capturedAt: '2026-07-25T10:05:00.000Z',
      goal: { probability: 0.35, bookmakerCount: 2 },
      assist: null,
      decisive: null,
    };
    const provider = (
      values: PlayerMarketOdds | null,
    ): PlayerMarketOddsProvider => ({
      load: vi.fn(async (players) =>
        new Map(
          players.map((candidate) => [
            playerMarketOddsKey(candidate),
            values,
          ]),
        ),
      ),
    });
    const combined = new SupplementingPlayerMarketOddsProvider(
      provider(primaryOdds),
      provider(fallbackOdds),
    );

    const result = await combined.load([stats]);

    expect(result.get(playerMarketOddsKey(stats))).toMatchObject({
      source: 'mixed',
      capturedAt: '2026-07-25T10:05:00.000Z',
      goal: { probability: 0.35 },
      assist: { probability: 0.2 },
      decisive: { probability: 0.43 },
    });
  });

  it('keeps the primary source when the fallback adds no missing market', async () => {
    const stats = player();
    const primaryOdds: PlayerMarketOdds = {
      source: 'sports-game-odds',
      capturedAt: '2026-07-25T10:00:00.000Z',
      goal: { probability: 0.35, bookmakerCount: 1 },
      assist: null,
      decisive: null,
    };
    const fallbackOdds: PlayerMarketOdds = {
      source: 'the-odds-api',
      capturedAt: '2026-07-25T10:05:00.000Z',
      goal: { probability: 0.34, bookmakerCount: 2 },
      assist: null,
      decisive: null,
    };
    const provider = (
      values: PlayerMarketOdds | null,
    ): PlayerMarketOddsProvider => ({
      load: vi.fn(async (players) =>
        new Map(
          players.map((candidate) => [
            playerMarketOddsKey(candidate),
            values,
          ]),
        ),
      ),
    });
    const combined = new SupplementingPlayerMarketOddsProvider(
      provider(primaryOdds),
      provider(fallbackOdds),
    );

    const result = await combined.load([stats]);

    expect(result.get(playerMarketOddsKey(stats))).toEqual(primaryOdds);
  });

  it('does not call a goal-only fallback when only the assist market is missing', async () => {
    const stats = player();
    const primaryOdds: PlayerMarketOdds = {
      source: 'the-odds-api',
      capturedAt: '2026-07-25T10:00:00.000Z',
      goal: { probability: 0.35, bookmakerCount: 1 },
      assist: null,
      decisive: null,
    };
    const primary: PlayerMarketOddsProvider = {
      load: vi.fn(async () =>
        new Map([[playerMarketOddsKey(stats), primaryOdds]]),
      ),
    };
    const fallback: PlayerMarketOddsProvider = {
      load: vi.fn(async () => new Map()),
    };
    const combined = new SupplementingPlayerMarketOddsProvider(
      primary,
      fallback,
      ['goal'],
    );

    const result = await combined.load([stats]);

    expect(result.get(playerMarketOddsKey(stats))).toEqual(primaryOdds);
    expect(fallback.load).not.toHaveBeenCalled();
  });

  it('reads independent cache layers concurrently and returns the lower cached quote', async () => {
    const stats = player();
    const events: string[] = [];
    const primaryOdds: PlayerMarketOdds = {
      source: 'sports-game-odds',
      capturedAt: '2026-07-25T10:00:00.000Z',
      goal: null,
      assist: { probability: 0.2, bookmakerCount: 1 },
      decisive: null,
    };
    const fallbackOdds: PlayerMarketOdds = {
      source: 'odds-api-io',
      capturedAt: '2026-07-25T10:01:00.000Z',
      goal: { probability: 0.35, bookmakerCount: 1 },
      assist: null,
      decisive: null,
    };
    const primary: PlayerMarketOddsProvider = {
      load: vi.fn(async () => {
        events.push('primary:start');
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push('primary:end');
        return new Map([[playerMarketOddsKey(stats), primaryOdds]]);
      }),
    };
    const fallback: PlayerMarketOddsProvider = {
      load: vi.fn(async () => {
        events.push('fallback:start');
        events.push('fallback:end');
        return new Map([[playerMarketOddsKey(stats), fallbackOdds]]);
      }),
      supportsMarket: (_player, market) => market === 'goal',
    };
    const combined = new SupplementingPlayerMarketOddsProvider(
      primary,
      fallback,
      ['goal'],
    );

    const result = await combined.load([stats], { cacheOnly: true });

    expect(events.indexOf('fallback:start')).toBeLessThan(
      events.indexOf('primary:end'),
    );
    expect(result.get(playerMarketOddsKey(stats))).toMatchObject({
      source: 'mixed',
      goal: { probability: 0.35 },
      assist: { probability: 0.2 },
    });
  });

  it('returns cached fallback data when the primary cache read hangs', async () => {
    const stats = player();
    const fallbackOdds: PlayerMarketOdds = {
      source: 'odds-api-io',
      capturedAt: '2026-07-25T10:01:00.000Z',
      goal: { probability: 0.35, bookmakerCount: 1 },
      assist: null,
      decisive: null,
    };
    const primary: PlayerMarketOddsProvider = {
      load: vi.fn(
        () =>
          new Promise<Map<string, PlayerMarketOdds | null>>(() => undefined),
      ),
    };
    const fallback: PlayerMarketOddsProvider = {
      load: vi.fn(async () =>
        new Map([[playerMarketOddsKey(stats), fallbackOdds]]),
      ),
      supportsMarket: (_player, market) => market === 'goal',
    };
    const combined = new SupplementingPlayerMarketOddsProvider(
      primary,
      fallback,
      ['goal'],
      5,
    );

    const result = await combined.load([stats], { cacheOnly: true });

    expect(result.get(playerMarketOddsKey(stats))).toEqual(fallbackOdds);
  });

  it('preserves an inner cached result through a nested cache-only deadline', async () => {
    const stats = player();
    const goalOdds: PlayerMarketOdds = {
      source: 'odds-api-io',
      capturedAt: '2026-07-25T10:01:00.000Z',
      goal: { probability: 0.35, bookmakerCount: 1 },
      assist: null,
      decisive: null,
    };
    const assistOdds: PlayerMarketOdds = {
      source: 'sports-game-odds',
      capturedAt: '2026-07-25T10:02:00.000Z',
      goal: null,
      assist: { probability: 0.22, bookmakerCount: 1 },
      decisive: null,
    };
    const hanging: PlayerMarketOddsProvider = {
      load: () =>
        new Promise<Map<string, PlayerMarketOdds | null>>(() => undefined),
    };
    const goalProvider: PlayerMarketOddsProvider = {
      load: async () => new Map([[playerMarketOddsKey(stats), goalOdds]]),
      supportsMarket: (_player, market) => market === 'goal',
    };
    const assistProvider: PlayerMarketOddsProvider = {
      load: async () => new Map([[playerMarketOddsKey(stats), assistOdds]]),
      supportsMarket: (_player, market) => market === 'assist',
    };
    const inner = new SupplementingPlayerMarketOddsProvider(
      hanging,
      goalProvider,
      ['goal'],
      50,
    );
    const outer = new SupplementingPlayerMarketOddsProvider(
      inner,
      assistProvider,
      ['assist'],
      50,
    );

    const result = await outer.load([stats], { cacheOnly: true });

    expect(result.get(playerMarketOddsKey(stats))).toMatchObject({
      source: 'mixed',
      goal: { probability: 0.35 },
      assist: { probability: 0.22 },
    });
  });

  it('keeps using the fallback when the primary provider fails', async () => {
    const stats = player();
    const fallbackOdds: PlayerMarketOdds = {
      source: 'odds-api-io',
      capturedAt: '2026-07-25T10:01:00.000Z',
      goal: { probability: 0.35, bookmakerCount: 1 },
      assist: null,
      decisive: null,
    };
    const primary: PlayerMarketOddsProvider = {
      load: vi.fn(async () => {
        throw new Error('temporary primary outage');
      }),
    };
    const fallback: PlayerMarketOddsProvider = {
      load: vi.fn(async () =>
        new Map([[playerMarketOddsKey(stats), fallbackOdds]]),
      ),
      supportsMarket: (_player, market) => market === 'goal',
    };
    const combined = new SupplementingPlayerMarketOddsProvider(
      primary,
      fallback,
      ['goal'],
    );

    const result = await combined.load([stats]);

    expect(result.get(playerMarketOddsKey(stats))).toEqual(fallbackOdds);
    expect(fallback.load).toHaveBeenCalledTimes(1);
  });

  it('reports goal-only fallback capability without claiming assist support', () => {
    const stats = player();
    const unavailable: PlayerMarketOddsProvider = {
      supports: () => false,
      supportsMarket: () => false,
      load: vi.fn(async () => new Map()),
    };
    const goalOnly: PlayerMarketOddsProvider = {
      supports: () => true,
      supportsMarket: (_player, market) => market === 'goal',
      load: vi.fn(async () => new Map()),
    };
    const combined = new SupplementingPlayerMarketOddsProvider(
      unavailable,
      goalOnly,
      ['goal'],
    );

    expect(combined.supportsMarket(stats, 'goal')).toBe(true);
    expect(combined.supportsMarket(stats, 'assist')).toBe(false);
  });
});
