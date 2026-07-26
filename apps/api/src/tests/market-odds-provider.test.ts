import type { PlayerStats } from '@sorare-overlay/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../logger.js';
import {
  InMemoryMarketSnapshotStore,
  TheOddsApiPlayerMarketOddsProvider,
  marketFixtureKey,
  normalizeTeamName,
  playerNameMatchScore,
  playerMarketOddsKey,
} from '../providers/market-odds-provider.js';
import {
  InMemoryProviderQuotaUsageStore,
  quotaUsage,
} from '../providers/odds-usage.js';

const now = Date.parse('2026-07-24T12:00:00.000Z');
const kickoff = '2026-07-24T18:00:00.000Z';

const logger: AppLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function player(overrides: Partial<PlayerStats> = {}): PlayerStats {
  return {
    slug: 'timo-werner',
    displayName: 'Timo Werner',
    position: 'Forward',
    aaL10: { value: 10, sampleSize: 10 },
    cleanSheetL10: { value: 0, sampleSize: 0 },
    goalL10: { value: 0.3, sampleSize: 10 },
    nextGame: {
      date: kickoff,
      homeTeamName: 'Chicago Fire FC',
      awayTeamName: 'Atlanta United FC',
      playerTeamName: 'Atlanta United FC',
      opponentTeamName: 'Chicago Fire FC',
      cleanSheetProbability: 0.2,
      matchProbabilities: { win: 0.34, draw: 0.25, loss: 0.41 },
    },
    excludedLowCoverage: 0,
    ...overrides,
  };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function eventResponse() {
  return [
    {
      id: 'fixture-1',
      commence_time: kickoff,
      home_team: 'Chicago Fire',
      away_team: 'Atlanta United',
    },
  ];
}

function marketResponse(displayName = 'Timo Werner') {
  return {
    id: 'fixture-1',
    commence_time: kickoff,
    home_team: 'Chicago Fire',
    away_team: 'Atlanta United',
    bookmakers: [
      {
        key: 'book-one',
        title: 'Book One',
        markets: [
          {
            key: 'player_goal_scorer_anytime',
            outcomes: [
              { name: 'Yes', description: displayName, price: 2 },
              { name: 'No', description: displayName, price: 1.8 },
            ],
          },
          {
            key: 'player_assists',
            outcomes: [
              {
                name: 'Over',
                description: displayName,
                price: 4,
                point: 0.5,
              },
              {
                name: 'Under',
                description: displayName,
                price: 1.3,
                point: 0.5,
              },
            ],
          },
        ],
      },
      {
        key: 'book-two',
        title: 'Book Two',
        markets: [
          {
            key: 'player_goal_scorer_anytime',
            outcomes: [
              { name: 'Yes', description: displayName, price: 2.5 },
              { name: 'No', description: displayName, price: 1.6 },
            ],
          },
          {
            key: 'player_assists',
            outcomes: [
              {
                name: 'Yes',
                description: displayName,
                price: 5,
                point: 0.5,
              },
              {
                name: 'No',
                description: displayName,
                price: 1.2,
                point: 0.5,
              },
            ],
          },
        ],
      },
    ],
  };
}

function marketResponseForPlayers(displayNames: readonly string[]) {
  const [first = 'Timo Werner', ...remaining] = displayNames;
  const response = marketResponse(first);
  return {
    ...response,
    bookmakers: response.bookmakers.map((bookmaker) => ({
      ...bookmaker,
      markets: bookmaker.markets.map((market) => {
        const template = market.outcomes.filter(
          ({ description }) => description === first,
        );
        return {
          ...market,
          outcomes: [
            ...market.outcomes,
            ...remaining.flatMap((displayName) =>
              template.map((outcome) => ({
                ...outcome,
                description: displayName,
              })),
            ),
          ],
        };
      }),
    })),
  };
}

function singleMarketResponse(
  market: 'player_goal_scorer_anytime' | 'player_assists',
) {
  const response = marketResponse();
  return {
    ...response,
    bookmakers: response.bookmakers.map((bookmaker) => ({
      ...bookmaker,
      markets: bookmaker.markets.filter((candidate) => candidate.key === market),
    })),
  };
}

function unavailableMarketResponse() {
  return {
    id: 'fixture-1',
    commence_time: kickoff,
    home_team: 'Chicago Fire',
    away_team: 'Atlanta United',
    bookmakers: [],
  };
}

describe('TheOddsApiPlayerMarketOddsProvider', () => {
  it('does not call the MLS feed for an explicitly unsupported competition', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fallbackRegion: 'uk',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
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
        competitionSlug: 'k-league-1',
        homeTeamName: 'FC Seoul',
        awayTeamName: 'Ulsan HD',
      },
    });

    const result = await provider.load([unsupported]);

    expect(result.get(playerMarketOddsKey(unsupported))).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('persists exact usage returned by The Odds API response headers', async () => {
    const usageStore = new InMemoryProviderQuotaUsageStore();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      json([], {
        headers: {
          'content-type': 'application/json',
          'x-requests-last': '0',
          'x-requests-used': '211',
          'x-requests-remaining': '289',
        },
      }),
    );
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(60_000, () => now),
      usageStore,
      logger,
      fetchImpl,
      now: () => now,
    });

    const refreshed = await provider.refreshUsage();

    expect(refreshed).toEqual([
      expect.objectContaining({
        provider: 'the-odds-api',
        unit: 'requests',
        used: 211,
        limit: 500,
        remaining: 289,
      }),
    ]);
    expect(await usageStore.get('the-odds-api')).toEqual(refreshed[0]);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('/sports?apiKey=');
  });

  it('disables the UK fallback once provider usage reaches 70 percent', async () => {
    const usageStore = new InMemoryProviderQuotaUsageStore();
    const usage = quotaUsage(
      'the-odds-api',
      'requests',
      70,
      100,
      new Date(now).toISOString(),
    );
    if (!usage) throw new Error('Expected quota usage');
    usageStore.set(usage);
    const griezmann = player({
      slug: 'antoine-griezmann',
      displayName: 'Antoine Griezmann',
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(eventResponse()))
      .mockResolvedValueOnce(json(marketResponse('Timo Werner')));
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fallbackRegion: 'uk',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(60_000, () => now),
      usageStore,
      logger,
      fetchImpl,
      now: () => now,
    });

    await provider.load([griezmann]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(
      fetchImpl.mock.calls.some(([input]) =>
        String(input).includes('regions=uk'),
      ),
    ).toBe(false);
  });

  it('stops new paid lookups at 90 percent while leaving cache reads available', async () => {
    const usageStore = new InMemoryProviderQuotaUsageStore();
    const usage = quotaUsage(
      'the-odds-api',
      'requests',
      90,
      100,
      new Date(now).toISOString(),
    );
    if (!usage) throw new Error('Expected quota usage');
    usageStore.set(usage);
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fallbackRegion: 'uk',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(60_000, () => now),
      usageStore,
      logger,
      fetchImpl,
      now: () => now,
    });

    const result = await provider.load([player()]);

    expect(result.get(playerMarketOddsKey(player()))).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps frozen values but skips missing-player supplement checks at 85 percent', async () => {
    const usageStore = new InMemoryProviderQuotaUsageStore();
    const snapshotStore = new InMemoryMarketSnapshotStore(
      60_000,
      () => now,
    );
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(eventResponse()))
      .mockResolvedValueOnce(json(marketResponse('Timo Werner')));
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fallbackRegion: 'uk',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: snapshotStore,
      usageStore,
      logger,
      fetchImpl,
      now: () => now,
    });
    const werner = player();
    await provider.load([werner]);
    const usage = quotaUsage(
      'the-odds-api',
      'requests',
      85,
      100,
      new Date(now).toISOString(),
    );
    if (!usage) throw new Error('Expected quota usage');
    usageStore.set(usage);
    const griezmann = player({
      slug: 'antoine-griezmann',
      displayName: 'Antoine Griezmann',
    });

    const result = await provider.load([griezmann]);

    expect(result.get(playerMarketOddsKey(griezmann))).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('normalizes Sorare short team names and bookmaker team names identically', () => {
    expect(normalizeTeamName('Montreal Impact')).toBe(
      normalizeTeamName('CF Montreal'),
    );
    expect(normalizeTeamName('New York RB')).toBe(
      normalizeTeamName('New York Red Bulls'),
    );
    expect(normalizeTeamName('SJ Earthquakes')).toBe(
      normalizeTeamName('San Jose Earthquakes'),
    );
  });

  it('freezes real goal and assist market consensus after the first capture', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(eventResponse()))
      .mockResolvedValueOnce(
        json(marketResponse(), {
          headers: {
            'content-type': 'application/json',
            'x-requests-last': '2',
            'x-requests-used': '2',
            'x-requests-remaining': '498',
          },
        }),
      );
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fallbackRegion: 'uk',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 1,
      store: new InMemoryMarketSnapshotStore(30 * 60 * 1_000, () => now),
      logger,
      fetchImpl,
      now: () => now,
    });
    const stats = player();

    const first = await provider.load([stats]);
    const odds = first.get(playerMarketOddsKey(stats));
    expect(odds).toMatchObject({
      source: 'the-odds-api',
      capturedAt: '2026-07-24T12:00:00.000Z',
      goal: { bookmakerCount: 2 },
      assist: { bookmakerCount: 2 },
    });
    expect(odds?.goal?.probability).toBeCloseTo(0.43196, 4);
    expect(odds?.assist?.probability).toBeCloseTo(0.21942, 4);
    expect(odds?.goal?.bookmakerQuotes).toEqual([
      {
        key: 'book-one',
        title: 'Book One',
        decimalOdds: 2,
        probability: expect.closeTo(0.47368, 4),
      },
      {
        key: 'book-two',
        title: 'Book Two',
        decimalOdds: 2.5,
        probability: expect.closeTo(0.39024, 4),
      },
    ]);
    expect(odds?.assist?.bookmakerQuotes).toEqual([
      {
        key: 'book-one',
        title: 'Book One',
        decimalOdds: 4,
        probability: expect.closeTo(0.24528, 4),
      },
      {
        key: 'book-two',
        title: 'Book Two',
        decimalOdds: 5,
        probability: expect.closeTo(0.19355, 4),
      },
    ]);

    const second = await provider.load([stats]);
    expect(second.get(playerMarketOddsKey(stats))).toEqual(odds);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
      '/sports/soccer_usa_mls/events?apiKey=test-key',
    );
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain(
      'markets=player_goal_scorer_anytime%2Cplayer_assists',
    );
  });

  it('uses the UK fallback only when the US markets miss the requested player', async () => {
    const griezmann = player({
      slug: 'antoine-griezmann',
      displayName: 'Antoine Griezmann',
      position: 'Forward',
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(eventResponse()))
      .mockResolvedValueOnce(json(marketResponse('Timo Werner')))
      .mockResolvedValueOnce(json(marketResponse('Antoine Griezmann')));
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fallbackRegion: 'uk',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(30 * 60 * 1_000, () => now),
      logger,
      fetchImpl,
      now: () => now,
    });

    const result = await provider.load([griezmann]);

    expect(result.get(playerMarketOddsKey(griezmann))).toMatchObject({
      goal: { bookmakerCount: 2 },
      assist: { bookmakerCount: 2 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain('regions=us');
    expect(String(fetchImpl.mock.calls[2]?.[0])).toContain('regions=uk');
    expect(String(fetchImpl.mock.calls[2]?.[0])).toContain(
      'markets=player_goal_scorer_anytime%2Cplayer_assists',
    );
  });

  it('keeps useful UK outcomes even when the requested player is still missing', async () => {
    const griezmann = player({
      slug: 'antoine-griezmann',
      displayName: 'Antoine Griezmann',
      position: 'Forward',
    });
    const werner = player({
      slug: 'timo-werner',
      displayName: 'Timo Werner',
      position: 'Forward',
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(eventResponse()))
      .mockResolvedValueOnce(json(marketResponse('US-only Player')))
      .mockResolvedValueOnce(json(marketResponse('Timo Werner')));
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fallbackRegion: 'uk',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(30 * 60 * 1_000, () => now),
      logger,
      fetchImpl,
      now: () => now,
    });

    const missing = await provider.load([griezmann]);
    expect(missing.get(playerMarketOddsKey(griezmann))).toBeNull();

    const supplemented = await provider.load([werner]);
    expect(supplemented.get(playerMarketOddsKey(werner))).toMatchObject({
      goal: { bookmakerCount: 2 },
      assist: { bookmakerCount: 2 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('enriches legacy frozen snapshots once with individual bookmaker quotes', async () => {
    const store = new InMemoryMarketSnapshotStore(
      30 * 60 * 1_000,
      () => now,
    );
    const stats = player();
    const fixtureKey = marketFixtureKey(stats.nextGame!);
    if (!fixtureKey) throw new Error('Expected fixture key');
    store.set(fixtureKey, {
      status: 'available',
      market: 'player_goal_scorer_anytime',
      eventId: 'fixture-1',
      capturedAt: '2026-07-24T10:00:00.000Z',
      players: {
        'timo werner': { probability: 0.4, bookmakerCount: 2 },
      },
    });
    store.set(fixtureKey, {
      status: 'available',
      market: 'player_assists',
      eventId: 'fixture-1',
      capturedAt: '2026-07-24T10:00:00.000Z',
      players: {
        'timo werner': { probability: 0.2, bookmakerCount: 2 },
      },
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(eventResponse()))
      .mockResolvedValueOnce(json(marketResponse()));
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store,
      logger,
      fetchImpl,
      now: () => now,
    });

    const enriched = await provider.load([stats]);
    expect(
      enriched.get(playerMarketOddsKey(stats))?.goal?.bookmakerQuotes,
    ).toHaveLength(2);
    expect(
      enriched.get(playerMarketOddsKey(stats))?.assist?.bookmakerQuotes,
    ).toHaveLength(2);

    await provider.load([stats]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rechecks a missing player at the adaptive pre-kickoff checkpoint without changing frozen odds', async () => {
    let clock = now;
    const store = new InMemoryMarketSnapshotStore(
      30 * 60 * 1_000,
      () => clock,
    );
    const timo = player();
    const griezmann = player({
      slug: 'antoine-griezmann',
      displayName: 'Antoine Griezmann',
      position: 'Forward',
    });
    const fixtureKey = marketFixtureKey(timo.nextGame!);
    if (!fixtureKey) throw new Error('Expected fixture key');
    store.set(fixtureKey, {
      status: 'available',
      market: 'player_goal_scorer_anytime',
      eventId: 'fixture-1',
      capturedAt: '2026-07-24T10:00:00.000Z',
      players: {
        'timo werner': {
          probability: 0.4,
          bookmakerCount: 2,
          bookmakerQuotes: [
            {
              key: 'frozen-book',
              title: 'Frozen Book',
              decimalOdds: 2.5,
              probability: 0.4,
            },
          ],
        },
      },
    });
    store.set(fixtureKey, {
      status: 'available',
      market: 'player_assists',
      eventId: 'fixture-1',
      capturedAt: '2026-07-24T10:00:00.000Z',
      players: {
        'timo werner': {
          probability: 0.2,
          bookmakerCount: 2,
          bookmakerQuotes: [
            {
              key: 'frozen-book',
              title: 'Frozen Book',
              decimalOdds: 5,
              probability: 0.2,
            },
          ],
        },
      },
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(eventResponse()))
      .mockResolvedValueOnce(json(marketResponseForPlayers(['Timo Werner'])))
      .mockResolvedValueOnce(json(eventResponse()))
      .mockResolvedValueOnce(
        json(marketResponseForPlayers(['Timo Werner', 'Antoine Griezmann'])),
      );
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store,
      logger,
      fetchImpl,
      now: () => clock,
    });

    const missing = await provider.load([griezmann]);
    expect(missing.get(playerMarketOddsKey(griezmann))).toBeNull();
    await provider.load([griezmann]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    clock += 2 * 60 * 60 * 1_000;
    const supplemented = await provider.load([griezmann]);
    expect(
      supplemented.get(playerMarketOddsKey(griezmann))?.goal,
    ).toBeTruthy();
    expect(
      supplemented.get(playerMarketOddsKey(griezmann))?.assist,
    ).toBeTruthy();

    const frozen = await provider.load([timo]);
    expect(frozen.get(playerMarketOddsKey(timo))).toMatchObject({
      capturedAt: '2026-07-24T10:00:00.000Z',
      goal: {
        probability: 0.4,
        bookmakerQuotes: [
          {
            key: 'frozen-book',
            probability: 0.4,
          },
        ],
      },
      assist: {
        probability: 0.2,
        bookmakerQuotes: [
          {
            key: 'frozen-book',
            probability: 0.2,
          },
        ],
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('backs off a missing player even when the refreshed market is completely unavailable', async () => {
    const store = new InMemoryMarketSnapshotStore(
      30 * 60 * 1_000,
      () => now,
    );
    const griezmann = player({
      slug: 'antoine-griezmann',
      displayName: 'Antoine Griezmann',
      position: 'Forward',
    });
    const fixtureKey = marketFixtureKey(griezmann.nextGame!);
    if (!fixtureKey) throw new Error('Expected fixture key');
    for (const market of [
      'player_goal_scorer_anytime',
      'player_assists',
    ] as const) {
      store.set(fixtureKey, {
        status: 'available',
        market,
        eventId: 'fixture-1',
        capturedAt: '2026-07-24T10:00:00.000Z',
        players: {
          'timo werner': {
            probability:
              market === 'player_goal_scorer_anytime' ? 0.4 : 0.2,
            bookmakerCount: 2,
            bookmakerQuotes: [
              {
                key: 'frozen-book',
                title: 'Frozen Book',
                decimalOdds:
                  market === 'player_goal_scorer_anytime' ? 2.5 : 5,
                probability:
                  market === 'player_goal_scorer_anytime' ? 0.4 : 0.2,
              },
            ],
          },
        },
      });
    }
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(eventResponse()))
      .mockResolvedValueOnce(json(unavailableMarketResponse()));
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store,
      logger,
      fetchImpl,
      now: () => now,
    });

    await provider.load([griezmann]);
    await provider.load([griezmann]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(
      store.get(fixtureKey, 'player_assists'),
    ).resolves.toMatchObject({
      status: 'available',
      missingPlayerChecks: {
        [playerMarketOddsKey(griezmann)]: {
          attemptCount: 1,
          nextRetryAt: new Date(
            Date.parse(kickoff) - 4 * 60 * 60 * 1_000,
          ).toISOString(),
        },
      },
    });
  });

  it('requests goal and assist separately when the combined market is unsupported', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (!url.includes('/events/fixture-1/odds')) {
        return json(eventResponse());
      }
      if (url.includes('player_goal_scorer_anytime%2Cplayer_assists')) {
        return json({}, { status: 422 });
      }
      if (url.includes('markets=player_goal_scorer_anytime')) {
        return json(singleMarketResponse('player_goal_scorer_anytime'));
      }
      return json(singleMarketResponse('player_assists'));
    });
    const stats = player();
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(30 * 60 * 1_000, () => now),
      logger,
      fetchImpl,
      now: () => now,
    });

    const result = await provider.load([stats]);
    const odds = result.get(playerMarketOddsKey(stats));

    expect(odds?.goal).toBeTruthy();
    expect(odds?.assist).toBeTruthy();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(
      fetchImpl.mock.calls.some(([input]) =>
        String(input).includes('markets=player_goal_scorer_anytime&'),
      ),
    ).toBe(true);
    expect(
      fetchImpl.mock.calls.some(([input]) =>
        String(input).includes('markets=player_assists&'),
      ),
    ).toBe(true);
  });

  it('backs off unavailable markets and stops after the final pre-kickoff check', async () => {
    const adaptiveKickoff = Date.parse('2026-07-26T12:00:00.000Z');
    let clock = adaptiveKickoff - 24 * 60 * 60 * 1_000;
    const store = new InMemoryMarketSnapshotStore(
      30 * 60 * 1_000,
      () => clock,
    );
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      return url.includes('/events?')
        ? json([
            {
              id: 'fixture-1',
              commence_time: new Date(adaptiveKickoff).toISOString(),
              home_team: 'Chicago Fire',
              away_team: 'Atlanta United',
            },
          ])
        : json({
            ...unavailableMarketResponse(),
            commence_time: new Date(adaptiveKickoff).toISOString(),
          });
    });
    const stats = player({
      nextGame: {
        ...player().nextGame!,
        date: new Date(adaptiveKickoff).toISOString(),
      },
    });
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fetchWindowMs: 24 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store,
      logger,
      fetchImpl,
      now: () => clock,
    });
    const fixtureKey = marketFixtureKey(stats.nextGame!);
    if (!fixtureKey) throw new Error('Expected a fixture key');

    await provider.load([stats]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(
      store.get(fixtureKey, 'player_assists'),
    ).resolves.toMatchObject({
      status: 'unavailable',
      attemptCount: 1,
      nextRetryAt: new Date(
        adaptiveKickoff - 12 * 60 * 60 * 1_000,
      ).toISOString(),
    });

    clock = adaptiveKickoff - 13 * 60 * 60 * 1_000;
    await provider.load([stats]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    clock = adaptiveKickoff - 12 * 60 * 60 * 1_000;
    await provider.load([stats]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    await expect(
      store.get(fixtureKey, 'player_assists'),
    ).resolves.toMatchObject({
      status: 'unavailable',
      attemptCount: 2,
      nextRetryAt: new Date(
        adaptiveKickoff - 4 * 60 * 60 * 1_000,
      ).toISOString(),
    });

    clock = adaptiveKickoff - 5 * 60 * 60 * 1_000;
    await provider.load([stats]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);

    clock = adaptiveKickoff - 4 * 60 * 60 * 1_000;
    await provider.load([stats]);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    await expect(
      store.get(fixtureKey, 'player_assists'),
    ).resolves.toMatchObject({
      status: 'unavailable',
      attemptCount: 3,
      nextRetryAt: null,
    });

    clock = adaptiveKickoff - 60 * 60 * 1_000;
    await provider.load([stats]);
    clock = adaptiveKickoff + 60 * 60 * 1_000;
    await provider.load([stats]);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('does not spend quota outside the configured pre-kickoff window', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fetchWindowMs: 2 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(30 * 60 * 1_000, () => now),
      logger,
      fetchImpl,
      now: () => now,
    });

    const result = await provider.load([player()]);

    expect(result.get(playerMarketOddsKey(player()))).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('retries HTTP 429 without exposing or replacing the API key', async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(json(eventResponse()))
      .mockResolvedValueOnce(json(marketResponse()));
    const stats = player();
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 1,
      store: new InMemoryMarketSnapshotStore(30 * 60 * 1_000, () => now),
      logger,
      fetchImpl,
      sleep,
      now: () => now,
    });

    await expect(provider.load([stats])).resolves.toBeInstanceOf(Map);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(0);
  });

  it('matches a bookmaker nickname to a longer Sorare family name', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(eventResponse()))
      .mockResolvedValueOnce(json(marketResponse('Nick Fernandez')));
    const stats = player({
      slug: 'nicolas-fernandez-mercau',
      displayName: 'Nicolás Fernández-Mercau',
      position: 'Midfielder',
    });
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(30 * 60 * 1_000, () => now),
      logger,
      fetchImpl,
      now: () => now,
    });

    const result = await provider.load([stats]);

    expect(result.get(playerMarketOddsKey(stats))?.goal).toBeTruthy();
    expect(playerNameMatchScore(stats.displayName, 'Nick Fernandez')).toBe(81);
  });

  it('matches Korean names when the feed uses family-name-first order', () => {
    expect(playerNameMatchScore('Heung-min Son', 'Son Heung Min')).toBe(95);
    expect(playerNameMatchScore('Heung-min Son', 'Son Heung-Woo')).toBe(0);
  });

  it('rejects an abbreviated market name that fits two fixture players', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(eventResponse()))
      .mockResolvedValueOnce(json(marketResponse('J Smith')));
    const john = player({ slug: 'john-smith', displayName: 'John Smith' });
    const jack = player({ slug: 'jack-smith', displayName: 'Jack Smith' });
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(30 * 60 * 1_000, () => now),
      logger,
      fetchImpl,
      now: () => now,
    });

    const result = await provider.load([john, jack]);

    expect(result.get(playerMarketOddsKey(john))).toBeNull();
    expect(result.get(playerMarketOddsKey(jack))).toBeNull();
  });

  it('does not request odds for a player whose team is not in the fixture', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const stats = player({
      nextGame: {
        ...player().nextGame!,
        playerTeamName: 'New York City FC',
      },
    });
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(30 * 60 * 1_000, () => now),
      logger,
      fetchImpl,
      now: () => now,
    });

    const result = await provider.load([stats]);

    expect(result.get(playerMarketOddsKey(stats))).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('InMemoryMarketSnapshotStore', () => {
  it('expires misses but retains successful snapshots', async () => {
    let clock = now;
    const store = new InMemoryMarketSnapshotStore(1_000, () => clock);
    const fixtureKey = marketFixtureKey(player().nextGame!);
    if (!fixtureKey) throw new Error('Expected a fixture key');

    store.set(fixtureKey, {
      status: 'unavailable',
      market: 'player_assists',
      checkedAt: new Date(clock).toISOString(),
    });
    store.set(fixtureKey, {
      status: 'available',
      market: 'player_goal_scorer_anytime',
      eventId: 'fixture-1',
      capturedAt: new Date(clock).toISOString(),
      players: {
        'timo werner': { probability: 0.4, bookmakerCount: 2 },
      },
    });

    clock += 1_001;
    await expect(store.get(fixtureKey, 'player_assists')).resolves.toBeUndefined();
    await expect(
      store.get(fixtureKey, 'player_goal_scorer_anytime'),
    ).resolves.toMatchObject({ status: 'available' });
  });
});
