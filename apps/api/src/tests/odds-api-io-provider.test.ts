import type { PlayerStats } from '@sorare-overlay/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../logger.js';
import {
  InMemoryMarketSnapshotStore,
  playerMarketFieldDrivesRequest,
  playerMarketOddsKey,
  type MarketSnapshotStore,
  type PlayerMarketOddsProvider,
} from '../providers/market-odds-provider.js';
import {
  InMemoryMatchOddsSnapshotStore,
  type MatchOddsSnapshotStore,
} from '../providers/match-odds-provider.js';
import {
  OddsApiIoFixtureMatchOddsProvider,
  OddsApiIoPlayerMarketOddsProvider,
  oddsApiIoFixtureStoreKey,
  oddsApiIoMatchFixtureStoreKey,
} from '../providers/odds-api-io-provider.js';
import {
  InMemoryProviderQuotaUsageStore,
  quotaUsage,
} from '../providers/odds-usage.js';
import type { OddsApiIoRoute } from '../providers/competition-odds-routes.js';
import { SupplementingPlayerMarketOddsProvider } from '../providers/sports-game-odds-provider.js';

const now = Date.parse('2026-07-30T12:00:00.000Z');
const kickoff = '2026-08-01T15:00:00.000Z';

const logger: AppLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function player(overrides: Partial<PlayerStats> = {}): PlayerStats {
  return {
    slug: 'otar-kiteishvili',
    displayName: 'Otar Kiteishvili',
    position: 'Midfielder',
    aaL10: { value: 12, sampleSize: 10 },
    cleanSheetL10: { value: 0, sampleSize: 0 },
    goalL10: { value: 0.3, sampleSize: 10 },
    nextGame: {
      date: kickoff,
      competitionSlug: 'austrian-bundesliga',
      homeTeamName: 'WSG Tirol',
      awayTeamName: 'Sturm Graz',
      playerTeamName: 'Sturm Graz',
      opponentTeamName: 'WSG Tirol',
      cleanSheetProbability: 0.31,
      matchProbabilities: { win: 0.58, draw: 0.24, loss: 0.18 },
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

function createProvider(
  fetchImpl: typeof fetch,
  usageStore = new InMemoryProviderQuotaUsageStore(() => now),
  routes: readonly OddsApiIoRoute[] = [
    {
      competitionSlugs: ['austrian-bundesliga'],
      leagueSlugs: ['austria-bundesliga'],
    },
  ],
  maxRetries = 0,
  store = new InMemoryMarketSnapshotStore(60_000, () => now),
  matchOddsStore?: MatchOddsSnapshotStore,
  appLogger: AppLogger = logger,
) {
  const provider = new OddsApiIoPlayerMarketOddsProvider({
    apiKey: 'server-only-test-key',
    baseUrl: 'https://api.odds-api.io/v3',
    bookmakers: ['Bet365', 'Unibet'],
    routes,
    fetchWindowMs: 72 * 60 * 60 * 1_000,
    matchOddsFallbackWindowMs: 72 * 60 * 60 * 1_000,
    matchOddsMissTtlMs: 6 * 60 * 60 * 1_000,
    dailyRequestLimit: 500,
    hourlyRequestLimit: 100,
    requestTimeoutMs: 1_000,
    maxRetries,
    store,
    ...(matchOddsStore ? { matchOddsStore } : {}),
    logger: appLogger,
    usageStore,
    fetchImpl,
    now: () => now,
  });
  return {
    provider,
    matchProvider: matchOddsStore
      ? new OddsApiIoFixtureMatchOddsProvider(provider)
      : null,
    usageStore,
  };
}

describe('OddsApiIoPlayerMarketOddsProvider', () => {
  it('advertises opportunistic assists without letting them drive requests', () => {
    const { provider } = createProvider(vi.fn<typeof fetch>());

    expect(provider.supportsMarket(player(), 'goal')).toBe(true);
    expect(provider.supportsMarket(player(), 'assist')).toBe(true);
    expect(playerMarketFieldDrivesRequest(provider, player(), 'goal')).toBe(true);
    expect(playerMarketFieldDrivesRequest(provider, player(), 'assist')).toBe(
      false,
    );
  });

  it('keeps a date-only UEFA fixture eligible throughout its UTC match day', () => {
    const matchStore = new InMemoryMatchOddsSnapshotStore(() => now);
    const { matchProvider } = createProvider(
      vi.fn<typeof fetch>(),
      new InMemoryProviderQuotaUsageStore(() => now),
      [
        {
          competitionSlugs: ['uefa-europa-conference-league'],
          leagueSlugs: [
            'international-clubs-uefa-conference-league-playoff-round',
          ],
          playerMarkets: ['goal'],
          matchOdds: true,
        },
      ],
      0,
      new InMemoryMarketSnapshotStore(60_000, () => now),
      matchStore,
    );
    if (!matchProvider) throw new Error('Expected Conference match provider');
    const dateOnlyPlayer = player({
      nextGame: {
        ...player().nextGame!,
        date: '2026-07-30T00:00:00.000Z',
        competitionSlug: 'uefa-europa-conference-league',
      },
    });

    expect(matchProvider.supports(dateOnlyPlayer)).toBe(true);
  });

  it('honors a league-specific 24-hour player-prop fetch window', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { provider } = createProvider(
      fetchImpl,
      new InMemoryProviderQuotaUsageStore(() => now),
      [
        {
          competitionSlugs: ['austrian-bundesliga'],
          leagueSlugs: ['austria-bundesliga'],
          playerMarkets: ['goal'],
          playerFetchWindowMs: 24 * 60 * 60 * 1_000,
        },
      ],
    );

    const result = await provider.load([player()]);

    expect(result.get(playerMarketOddsKey(player()))).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports labelled player markets that no parser consumed', async () => {
    const warn = vi.fn<AppLogger['warn']>();
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/events')) {
        return json([
          {
            id: 'unknown-player-market-fixture',
            date: kickoff,
            home: 'WSG Tirol',
            away: 'SK Sturm Graz',
          },
        ]);
      }
      return json([
        {
          id: 'unknown-player-market-fixture',
          date: kickoff,
          home: 'WSG Tirol',
          away: 'SK Sturm Graz',
          bookmakers: {
            Bet365: [
              {
                name: 'Player Creative Assist',
                odds: [{ label: 'Otar Kiteishvili', odds: '4.00' }],
              },
            ],
          },
        },
      ]);
    });
    const { provider } = createProvider(
      fetchImpl,
      new InMemoryProviderQuotaUsageStore(() => now),
      undefined,
      0,
      new InMemoryMarketSnapshotStore(60_000, () => now),
      undefined,
      { ...logger, warn },
    );

    await provider.load([player()]);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'player_market_unhandled',
        provider: 'odds-api-io',
        markets: ['Player Creative Assist'],
      }),
      expect.any(String),
    );
  });

  it('maps a Leagues Cup goalscorer quote for Antoine Griezmann', async () => {
    const griezmann = player({
      slug: 'antoine-griezmann',
      displayName: 'Antoine Griezmann',
      position: 'Forward',
      nextGame: {
        ...player().nextGame!,
        date: kickoff,
        competitionSlug: 'leagues-cup-mls',
        homeTeamName: 'Monterrey',
        awayTeamName: 'Orlando City',
        playerTeamName: 'Orlando City',
        opponentTeamName: 'Monterrey',
      },
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/events')) {
        expect(url.searchParams.get('league')).toBe(
          'international-clubs-leagues-cup-group-stage',
        );
        return json([
          {
            id: 'leagues-cup-fixture-1',
            date: kickoff,
            home: 'CF Monterrey',
            away: 'Orlando City SC',
          },
        ]);
      }
      if (url.pathname.endsWith('/odds/multi')) {
        return json([
          {
            id: 'leagues-cup-fixture-1',
            date: kickoff,
            home: 'CF Monterrey',
            away: 'Orlando City SC',
            bookmakers: {
              Bet365: [
                {
                  name: 'ML',
                  odds: [{ label: null, home: '1.70', away: '4.50' }],
                },
                {
                  name: 'Anytime Goalscorer',
                  odds: [
                    { label: 'Antoine Griezmann', hdp: 0.5, over: '2.200' },
                  ],
                },
              ],
              Unibet: [
                {
                  name: 'Anytime Goalscorer',
                  odds: [
                    { label: 'Antoine Griezmann', hdp: 0.5, over: '2.60' },
                  ],
                },
              ],
            },
          },
        ]);
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    const { provider } = createProvider(
      fetchImpl,
      new InMemoryProviderQuotaUsageStore(() => now),
      [
        {
          competitionSlugs: ['leagues-cup-mls'],
          leagueSlugs: ['international-clubs-leagues-cup-group-stage'],
        },
      ],
    );

    const result = await provider.load([griezmann]);

    expect(result.get(playerMarketOddsKey(griezmann))).toMatchObject({
      source: 'odds-api-io',
      goal: {
        probability: (1 / 2.2 + 1 / 2.6) / 2,
        bookmakerCount: 2,
      },
    });
  });

  it('batches Austrian fixtures and maps Bet365 anytime-goalscorer odds', async () => {
    const secondPlayer = player({
      slug: 'seedy-jatta',
      displayName: 'Seedy Jatta',
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/events')) {
        expect(url.searchParams.get('sport')).toBe('football');
        expect(url.searchParams.get('league')).toBe('austria-bundesliga');
        return json([
          {
            id: 'austria-fixture-1',
            date: kickoff,
            home: 'WSG Tirol',
            away: 'SK Sturm Graz',
          },
        ]);
      }
      if (url.pathname.endsWith('/odds/multi')) {
        expect(url.searchParams.get('eventIds')).toBe('austria-fixture-1');
        expect(url.searchParams.get('bookmakers')).toBe('Bet365,Unibet');
        return json([
          {
            id: 'austria-fixture-1',
            date: kickoff,
            home: 'WSG Tirol',
            away: 'SK Sturm Graz',
            bookmakers: {
              Bet365: [
                {
                  name: 'Anytime Goalscorer',
                  odds: [
                    { label: 'Otar Kiteishvili', hdp: 0.5, over: '2.300' },
                    { label: 'Seedy Jatta', hdp: 0.5, over: '3.500' },
                  ],
                },
              ],
              Unibet: [
                {
                  name: 'Full Time Result',
                  odds: [],
                },
              ],
            },
          },
        ]);
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    const { provider, usageStore } = createProvider(fetchImpl);

    const result = await provider.load([player(), secondPlayer]);

    expect(result.get(playerMarketOddsKey(player()))).toMatchObject({
      source: 'odds-api-io',
      goal: {
        probability: 1 / 2.3,
        bookmakerCount: 1,
        bookmakerQuotes: [
          {
            key: 'bet365',
            title: 'Bet365',
            decimalOdds: 2.3,
            probability: 1 / 2.3,
          },
        ],
      },
      assist: null,
    });
    expect(result.get(playerMarketOddsKey(secondPlayer))?.goal?.probability).toBeCloseTo(
      1 / 3.5,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(usageStore.get('odds-api-io')).resolves.toMatchObject({
      provider: 'odds-api-io',
      unit: 'requests',
      used: 2,
      limit: 500,
      remaining: 498,
      interval: { unit: 'day' },
    });
    await expect(
      usageStore.get('odds-api-io-hourly'),
    ).resolves.toMatchObject({
      provider: 'odds-api-io-hourly',
      unit: 'requests',
      used: 2,
      limit: 100,
      remaining: 98,
      interval: { unit: 'hour' },
    });
  });

  it('captures Player To Assist from the same response without another request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/events')) {
        return json([
          {
            id: 'austria-assist-fixture',
            date: kickoff,
            home: 'WSG Tirol',
            away: 'SK Sturm Graz',
          },
        ]);
      }
      if (url.pathname.endsWith('/odds/multi')) {
        return json([
          {
            id: 'austria-assist-fixture',
            date: kickoff,
            home: 'WSG Tirol',
            away: 'SK Sturm Graz',
            bookmakers: {
              Bet365: [
                {
                  name: 'Anytime Goalscorer',
                  odds: [
                    { label: 'Otar Kiteishvili', hdp: 0.5, over: '2.30' },
                  ],
                },
                {
                  name: 'Player To Assist',
                  odds: [
                    { label: 'Otar Kiteishvili', odds: '4.00' },
                  ],
                },
              ],
              Unibet: [
                {
                  name: 'Player To Assist',
                  odds: [
                    { label: 'Otar Kiteishvili', over: '3.50' },
                  ],
                },
              ],
            },
          },
        ]);
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    const { provider } = createProvider(fetchImpl);

    const first = await provider.load([player()]);
    const cached = await provider.load([player()], { cacheOnly: true });

    for (const result of [first, cached]) {
      expect(result.get(playerMarketOddsKey(player()))).toMatchObject({
        source: 'odds-api-io',
        goal: { probability: 1 / 2.3, bookmakerCount: 1 },
        assist: {
          probability: (1 / 4 + 1 / 3.5) / 2,
          bookmakerCount: 2,
          bookmakerQuotes: [
            expect.objectContaining({ title: 'Bet365', decimalOdds: 4 }),
            expect.objectContaining({ title: 'Unibet', decimalOdds: 3.5 }),
          ],
        },
      });
    }
    expect(provider.supportsMarket(player(), 'assist')).toBe(true);
    expect(playerMarketFieldDrivesRequest(provider, player(), 'assist')).toBe(
      false,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("maps Bet365's combined home- and away-side player selections", async () => {
    const dAvilla = player({
      slug: 'tah-ange-innocent-d-avilla-dje',
      displayName: "Tah D'Avilla",
      nextGame: {
        ...player().nextGame!,
        competitionSlug: 'mlspa',
        homeTeamName: 'Chicago Fire',
        awayTeamName: 'Portland Timbers',
        playerTeamName: 'Chicago Fire',
        opponentTeamName: 'Portland Timbers',
      },
    });
    const messi = player({
      slug: 'lionel-andres-messi-cuccittini',
      displayName: 'Lionel Messi',
      position: 'Forward',
      nextGame: {
        ...dAvilla.nextGame!,
        playerTeamName: 'Portland Timbers',
        opponentTeamName: 'Chicago Fire',
      },
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/events')) {
        return json([
          {
            id: 'chicago-portland-fixture',
            date: kickoff,
            home: 'Chicago Fire',
            away: 'Portland Timbers',
          },
        ]);
      }
      if (url.pathname.endsWith('/odds/multi')) {
        return json([
          {
            id: 'chicago-portland-fixture',
            date: kickoff,
            home: 'Chicago Fire',
            away: 'Portland Timbers',
            bookmakers: {
              Bet365: [
                {
                  name: 'Anytime Goalscorer',
                  odds: [{ label: "Djé D'Avilla", over: '6.50' }],
                },
                {
                  name: 'Player To Score or Assist',
                  odds: [
                    { label: "Djé D'Avilla (Score) (1)", over: '6.500' },
                    { label: "Djé D'Avilla (Assist) (1)", over: '7.000' },
                    {
                      label: "Djé D'Avilla (Score or Assist) (1)",
                      over: '3.750',
                    },
                    { label: 'Lionel Messi (Assist) (2)', over: '2.750' },
                  ],
                },
              ],
            },
          },
        ]);
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    const { provider } = createProvider(
      fetchImpl,
      new InMemoryProviderQuotaUsageStore(() => now),
      [
        {
          competitionSlugs: ['mlspa'],
          leagueSlugs: ['usa-mls'],
          playerMarkets: ['goal'],
          matchOdds: false,
        },
      ],
    );

    const result = await provider.load([dAvilla, messi]);

    expect(result.get(playerMarketOddsKey(dAvilla))).toMatchObject({
      goal: {
        probability: 1 / 6.5,
        bookmakerQuotes: [
          expect.objectContaining({
            providerMarketName: 'Anytime Goalscorer',
            providerSelectionLabel: "Djé D'Avilla",
          }),
        ],
      },
      assist: {
        probability: 1 / 7,
        bookmakerQuotes: [
          expect.objectContaining({
            providerMarketName: 'Player To Score or Assist',
            providerSelectionLabel: "Djé D'Avilla (Assist) (1)",
          }),
        ],
      },
      decisive: { probability: 1 / 3.75 },
    });
    expect(result.get(playerMarketOddsKey(messi))).toMatchObject({
      assist: {
        probability: 1 / 2.75,
        bookmakerQuotes: [
          expect.objectContaining({
            providerMarketName: 'Player To Score or Assist',
            providerSelectionLabel: 'Lionel Messi (Assist) (2)',
          }),
        ],
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reads D'Avilla's existing pre-alias snapshot without another request", async () => {
    const dAvilla = player({
      slug: 'tah-ange-innocent-d-avilla-dje',
      displayName: "Tah D'Avilla",
      nextGame: {
        ...player().nextGame!,
        competitionSlug: 'mlspa',
        homeTeamName: 'Chicago Fire',
        awayTeamName: 'Portland Timbers',
        playerTeamName: 'Chicago Fire',
        opponentTeamName: 'Portland Timbers',
      },
    });
    const fixtureKey = oddsApiIoFixtureStoreKey(dAvilla.nextGame!);
    if (!fixtureKey) throw new Error('Expected D’Avilla fixture key');
    const store = new InMemoryMarketSnapshotStore(60_000, () => now);
    await store.set(fixtureKey, {
      status: 'available',
      market: 'player_goal_scorer_anytime',
      eventId: 'chicago-portland-fixture',
      capturedAt: new Date(now).toISOString(),
      players: {
        'dje d avilla': { probability: 1 / 6.5, bookmakerCount: 1 },
      },
    });
    await store.set(fixtureKey, {
      status: 'available',
      market: 'player_assists',
      eventId: 'chicago-portland-fixture',
      capturedAt: new Date(now).toISOString(),
      players: {
        'dje d avilla': { probability: 1 / 8, bookmakerCount: 1 },
      },
    });
    const fetchImpl = vi.fn<typeof fetch>();
    const { provider } = createProvider(
      fetchImpl,
      new InMemoryProviderQuotaUsageStore(() => now),
      [
        {
          competitionSlugs: ['mlspa'],
          leagueSlugs: ['usa-mls'],
          playerMarkets: ['goal'],
          matchOdds: false,
        },
      ],
      0,
      store,
    );

    const result = await provider.load([dAvilla], { cacheOnly: true });

    expect(result.get(playerMarketOddsKey(dAvilla))).toMatchObject({
      goal: { probability: 1 / 6.5 },
      assist: { probability: 1 / 8 },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads Oh Hyeon-gyu's existing bookmaker-name snapshot without another request", async () => {
    const hyeongyuOh = player({
      slug: 'hyun-gyu-oh',
      displayName: 'Hyeongyu Oh',
      position: 'Forward',
      nextGame: {
        ...player().nextGame!,
        competitionSlug: 'uefa-europa-league',
        homeTeamName: 'Beşiktaş',
        awayTeamName: 'Kauno Žalgiris',
        playerTeamName: 'Beşiktaş',
        opponentTeamName: 'Kauno Žalgiris',
      },
    });
    const fixtureKey = oddsApiIoFixtureStoreKey(hyeongyuOh.nextGame!);
    if (!fixtureKey) throw new Error('Expected Oh Hyeon-gyu fixture key');
    const store = new InMemoryMarketSnapshotStore(60_000, () => now);
    await store.set(fixtureKey, {
      status: 'available',
      market: 'player_goal_scorer_anytime',
      eventId: 'besiktas-kauno-fixture',
      capturedAt: new Date(now).toISOString(),
      players: {
        'oh hyeon gyu': { probability: 1 / 1.98, bookmakerCount: 1 },
      },
    });
    const fetchImpl = vi.fn<typeof fetch>();
    const { provider } = createProvider(
      fetchImpl,
      new InMemoryProviderQuotaUsageStore(() => now),
      [
        {
          competitionSlugs: ['uefa-europa-league'],
          leagueSlugs: [
            'international-clubs-uefa-europa-league-playoff-round',
          ],
          playerMarkets: ['goal'],
          matchOdds: false,
        },
      ],
      0,
      store,
    );

    const result = await provider.load([hyeongyuOh], { cacheOnly: true });

    expect(result.get(playerMarketOddsKey(hyeongyuOh))).toMatchObject({
      goal: { probability: 1 / 1.98 },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('replays an away-side assist from v2 evidence without another request', async () => {
    const store = new InMemoryMarketSnapshotStore(60_000, () => now);
    const messi = player({
      slug: 'lionel-andres-messi-cuccittini',
      displayName: 'Lionel Messi',
      position: 'Forward',
      nextGame: {
        ...player().nextGame!,
        competitionSlug: 'mlspa',
        homeTeamName: 'Philadelphia Union',
        awayTeamName: 'Inter Miami',
        playerTeamName: 'Inter Miami',
        opponentTeamName: 'Philadelphia Union',
      },
    });
    const fixtureKey = oddsApiIoFixtureStoreKey(messi.nextGame!);
    if (!fixtureKey) throw new Error('Expected Odds-API.io fixture key');
    await store.set(fixtureKey, {
      status: 'available',
      market: 'player_goal_scorer_anytime',
      eventId: 'evidence-fixture',
      capturedAt: new Date(now).toISOString(),
      parserVersion: 2,
      players: {
        'lionel messi': { probability: 0.55, bookmakerCount: 1 },
      },
    });
    await store.setEvidence(
      fixtureKey,
      'odds-api-io',
      {
        provider: 'odds-api-io',
        parserVersion: 2,
        eventId: 'evidence-fixture',
        capturedAt: new Date(now).toISOString(),
        expiresAt: new Date(
          Date.parse(kickoff) + 48 * 60 * 60 * 1_000,
        ).toISOString(),
        bookmakers: {
          Bet365: [
            {
              name: 'Player To Score or Assist',
              odds: [
                { label: 'Lionel Messi (Assist) (2)', over: '2.75' },
              ],
            },
          ],
        },
      },
      new Date(Date.parse(kickoff) + 48 * 60 * 60 * 1_000).toISOString(),
    );
    const fetchImpl = vi.fn<typeof fetch>();
    const { provider } = createProvider(
      fetchImpl,
      new InMemoryProviderQuotaUsageStore(() => now),
      [
        {
          competitionSlugs: ['mlspa'],
          leagueSlugs: ['usa-mls'],
          playerMarkets: ['goal'],
          matchOdds: false,
        },
      ],
      0,
      store,
    );

    const result = await provider.load([messi], { cacheOnly: true });

    expect(result.get(playerMarketOddsKey(messi))).toMatchObject({
      goal: { probability: 0.55 },
      assist: {
        probability: 1 / 2.75,
        bookmakerQuotes: [
          expect.objectContaining({
            providerSelectionLabel: 'Lionel Messi (Assist) (2)',
          }),
        ],
      },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not request Odds-API.io solely because an assist is missing', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { provider } = createProvider(fetchImpl);
    const primary: PlayerMarketOddsProvider = {
      supports: () => true,
      supportsMarket: (_player, market) => market === 'goal',
      load: async (players) =>
        new Map(
          players.map((candidate) => [
            playerMarketOddsKey(candidate),
            {
              source: 'sports-game-odds' as const,
              capturedAt: new Date(now).toISOString(),
              goal: { probability: 0.4, bookmakerCount: 1 },
              assist: null,
            },
          ]),
        ),
    };
    const combined = new SupplementingPlayerMarketOddsProvider(
      primary,
      provider,
      ['goal'],
    );

    const result = await combined.load([player()]);

    expect(result.get(playerMarketOddsKey(player()))).toMatchObject({
      goal: { probability: 0.4 },
      assist: null,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('shares one HNL fixture refresh between goal, assist, and H-D-A snapshots', async () => {
    const hnlPlayer = player({
      slug: 'marco-pasalic',
      displayName: 'Marco Pasalic',
      position: 'Forward',
      nextGame: {
        ...player().nextGame!,
        competitionSlug: '1-hnl',
        homeTeamName: 'Dinamo Zagreb',
        awayTeamName: 'Rijeka',
        playerTeamName: 'Rijeka',
        opponentTeamName: 'Dinamo Zagreb',
        matchProbabilities: null,
      },
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/events')) {
        expect(url.searchParams.get('league')).toBe('croatia-hnl');
        return json([
          {
            id: 'hnl-fixture-1',
            date: kickoff,
            home: 'GNK Dinamo Zagreb',
            away: 'HNK Rijeka',
          },
        ]);
      }
      if (url.pathname.endsWith('/odds/multi')) {
        return json([
          {
            id: 'hnl-fixture-1',
            date: kickoff,
            home: 'GNK Dinamo Zagreb',
            away: 'HNK Rijeka',
            bookmakers: {
              Bet365: [
                {
                  name: 'ML',
                  odds: [{ home: '2.00', draw: '3.40', away: '4.00' }],
                },
                {
                  name: 'Anytime Goalscorer',
                  odds: [{ label: 'Marco Pasalic', over: '3.20' }],
                },
                {
                  name: 'Player To Assist',
                  odds: [{ label: 'Marco Pasalic', odds: '4.20' }],
                },
              ],
              Unibet: [
                {
                  name: 'ML',
                  odds: [{ home: '2.20', draw: '3.20', away: '3.80' }],
                },
                {
                  name: 'Anytime Goalscorer',
                  odds: [{ label: 'Marco Pasalic', over: '3.40' }],
                },
                {
                  name: 'Player To Assist',
                  odds: [{ label: 'Marco Pasalic', odds: '4.60' }],
                },
              ],
            },
          },
        ]);
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    const marketStore = new InMemoryMarketSnapshotStore(60_000, () => now);
    const matchStore = new InMemoryMatchOddsSnapshotStore(() => now);
    const { provider, matchProvider } = createProvider(
      fetchImpl,
      new InMemoryProviderQuotaUsageStore(() => now),
      [
        {
          competitionSlugs: ['1-hnl'],
          leagueSlugs: ['croatia-hnl'],
          playerMarkets: ['goal'],
          matchOdds: true,
        },
      ],
      0,
      marketStore,
      matchStore,
    );
    if (!matchProvider) throw new Error('Expected HNL match provider');

    await Promise.all([
      provider.load([hnlPlayer]),
      matchProvider.load([hnlPlayer]),
    ]);
    const [cachedPlayer, cachedMatch] = await Promise.all([
      provider.load([hnlPlayer], { cacheOnly: true }),
      matchProvider.load([hnlPlayer], { cacheOnly: true }),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(
      cachedPlayer.get(playerMarketOddsKey(hnlPlayer))?.goal?.probability,
    ).toBeCloseTo((1 / 3.2 + 1 / 3.4) / 2);
    expect(
      cachedPlayer.get(playerMarketOddsKey(hnlPlayer))?.assist?.probability,
    ).toBeCloseTo((1 / 4.2 + 1 / 4.6) / 2);
    const probabilities = cachedMatch.get(playerMarketOddsKey(hnlPlayer));
    expect(probabilities).toMatchObject({
      win: expect.any(Number),
      draw: expect.any(Number),
      loss: expect.any(Number),
    });
    expect(
      (probabilities?.win ?? 0) +
        (probabilities?.draw ?? 0) +
        (probabilities?.loss ?? 0),
    ).toBeCloseTo(1);
    expect(probabilities?.win ?? 1).toBeLessThan(probabilities?.loss ?? 0);
    const fixtureKey = oddsApiIoMatchFixtureStoreKey(hnlPlayer.nextGame!);
    if (!fixtureKey) throw new Error('Expected HNL fixture key');
    await expect(matchStore.get(fixtureKey)).resolves.toMatchObject({
      status: 'available',
      eventId: 'hnl-fixture-1',
      bookmakerCount: 2,
    });
  });

  it('loads Conference League H-D-A despite the Tromsø transliteration', async () => {
    const brightonPlayer = player({
      slug: 'ferdi-erenay-kadioglu',
      displayName: 'Ferdi Kadıoğlu',
      position: 'Defender',
      nextGame: {
        ...player().nextGame!,
        competitionSlug: 'uefa-europa-conference-league',
        homeTeamName: 'Tromsø',
        awayTeamName: 'Brighton & Hove Albion',
        playerTeamName: 'Brighton & Hove Albion',
        opponentTeamName: 'Tromsø',
        matchProbabilities: null,
      },
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/events')) {
        expect(url.searchParams.get('league')).toBe(
          'international-clubs-uefa-conference-league-playoff-round',
        );
        return json([
          {
            id: 'conference-fixture-1',
            date: kickoff,
            home: 'Tromsoe IL',
            away: 'Brighton & Hove Albion',
          },
        ]);
      }
      if (url.pathname.endsWith('/odds/multi')) {
        return json([
          {
            id: 'conference-fixture-1',
            date: kickoff,
            home: 'Tromsoe IL',
            away: 'Brighton & Hove Albion',
            bookmakers: {
              Bet365: [
                {
                  name: 'ML',
                  odds: [{ home: '5.50', draw: '3.80', away: '1.55' }],
                },
                {
                  name: 'Clean Sheet Away',
                  odds: [{ yes: '2.25', no: '1.571' }],
                },
              ],
              Unibet: [
                {
                  name: 'ML',
                  odds: [{ home: '5.20', draw: '3.90', away: '1.56' }],
                },
              ],
            },
          },
        ]);
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    const matchStore = new InMemoryMatchOddsSnapshotStore(() => now);
    const { matchProvider } = createProvider(
      fetchImpl,
      new InMemoryProviderQuotaUsageStore(() => now),
      [
        {
          competitionSlugs: ['uefa-europa-conference-league'],
          leagueSlugs: [
            'international-clubs-uefa-conference-league-playoff-round',
          ],
          playerMarkets: ['goal'],
          matchOdds: true,
        },
      ],
      0,
      new InMemoryMarketSnapshotStore(60_000, () => now),
      matchStore,
    );
    if (!matchProvider) throw new Error('Expected Conference match provider');

    const result = await matchProvider.load([brightonPlayer]);
    const fixtureOdds = result.get(playerMarketOddsKey(brightonPlayer));
    const probabilities = fixtureOdds;

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(probabilities).toMatchObject({
      win: expect.any(Number),
      draw: expect.any(Number),
      loss: expect.any(Number),
    });
    expect(probabilities?.win ?? 0).toBeGreaterThan(
      probabilities?.loss ?? 1,
    );
    expect(fixtureOdds?.cleanSheetProbability).toBeCloseTo(
      (1 / 2.25) / (1 / 2.25 + 1 / 1.571),
    );
  });

  it('serves its frozen fixture snapshot without another provider request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      return url.pathname.endsWith('/events')
        ? json([
            {
              id: 'austria-fixture-1',
              date: kickoff,
              home: 'WSG Tirol',
              away: 'SK Sturm Graz',
            },
          ])
        : json([
            {
              id: 'austria-fixture-1',
              date: kickoff,
              home: 'WSG Tirol',
              away: 'SK Sturm Graz',
              bookmakers: {
                Bet365: [
                  {
                    name: 'Anytime Goalscorer',
                    odds: [
                      {
                        label: 'Otar Kiteishvili',
                        over: 2.3,
                      },
                    ],
                  },
                ],
              },
            },
          ]);
    });
    const { provider } = createProvider(fetchImpl);

    await provider.load([player()]);
    const cached = await provider.load([player()], { cacheOnly: true });

    expect(cached.get(playerMarketOddsKey(player()))?.goal?.probability).toBeCloseTo(
      1 / 2.3,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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
        const key = oddsApiIoFixtureStoreKey(stats.nextGame!);
        if (!key) throw new Error('Expected early fixture key');
        return key;
      }),
    );
    const healthyKey = oddsApiIoFixtureStoreKey(healthyPlayer.nextGame!);
    if (!healthyKey) throw new Error('Expected healthy fixture key');
    const backingStore = new InMemoryMarketSnapshotStore(60_000, () => now);
    backingStore.set(healthyKey, {
      status: 'available',
      market: 'player_goal_scorer_anytime',
      eventId: 'healthy-fixture',
      capturedAt: new Date(now).toISOString(),
      players: {
        'healthy player': { probability: 0.39, bookmakerCount: 1 },
      },
    });
    const store: MarketSnapshotStore = {
      get: (key, market) =>
        earlyKeys.has(key)
          ? new Promise(() => undefined)
          : backingStore.get(key, market),
      set: (key, snapshot) => backingStore.set(key, snapshot),
    };
    const provider = createProvider(
      vi.fn<typeof fetch>(),
      undefined,
      undefined,
      0,
      store,
    ).provider;
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
      goal: { probability: 0.39 },
    });
  });

  it('does not spend requests on goalkeepers or unsupported competitions', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { provider } = createProvider(fetchImpl);
    const goalkeeper = player({
      slug: 'kjell-scherpen',
      displayName: 'Kjell Scherpen',
      position: 'Goalkeeper',
    });
    const mlsPlayer = player({
      slug: 'timo-werner',
      displayName: 'Timo Werner',
      nextGame: {
        ...player().nextGame!,
        competitionSlug: 'mlspa',
      },
    });

    const result = await provider.load([goalkeeper, mlsPlayer]);

    expect(result.get(playerMarketOddsKey(goalkeeper))).toBeNull();
    expect(result.get(playerMarketOddsKey(mlsPlayer))).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falls through from UEFA playoff and qualification feeds to the main competition feed', async () => {
    const uefaPlayer = player({
      slug: 'kerem-akturkoglu',
      displayName: 'Kerem Akturkoglu',
      nextGame: {
        ...player().nextGame!,
        competitionSlug: 'uefa-champions-league',
        homeTeamName: 'Fenerbahce',
        awayTeamName: 'Benfica',
        playerTeamName: 'Fenerbahce',
        opponentTeamName: 'Benfica',
      },
    });
    const queriedLeagues: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/events')) {
        queriedLeagues.push(url.searchParams.get('league') ?? '');
        return queriedLeagues.length < 3
          ? json([])
          : json([
              {
                id: 'uefa-fixture-1',
                date: kickoff,
                home: 'Fenerbahce SK',
                away: 'SL Benfica',
              },
            ]);
      }
      return json([
        {
          id: 'uefa-fixture-1',
          date: kickoff,
          home: 'Fenerbahce SK',
          away: 'SL Benfica',
          bookmakers: {
            Bet365: [
              {
                name: 'Anytime Goalscorer',
                odds: [{ label: 'Kerem Akturkoglu', over: 3 }],
              },
            ],
          },
        },
      ]);
    });
    const { provider } = createProvider(
      fetchImpl,
      new InMemoryProviderQuotaUsageStore(),
      [
        {
          competitionSlugs: ['uefa-champions-league'],
          leagueSlugs: [
            'international-clubs-uefa-champions-league-playoff-round',
            'international-clubs-uefa-champions-league-qualification',
            'international-clubs-uefa-champions-league',
          ],
        },
      ],
    );

    const result = await provider.load([uefaPlayer]);

    expect(queriedLeagues).toEqual([
      'international-clubs-uefa-champions-league-playoff-round',
      'international-clubs-uefa-champions-league-qualification',
      'international-clubs-uefa-champions-league',
    ]);
    expect(
      result.get(playerMarketOddsKey(uefaPlayer))?.goal?.probability,
    ).toBeCloseTo(1 / 3);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('uses only cached values after the hourly safety reserve is reached', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const usageStore = new InMemoryProviderQuotaUsageStore();
    const hourStart = new Date(now);
    hourStart.setUTCMinutes(0, 0, 0);
    const usage = quotaUsage(
      'odds-api-io-hourly',
      'requests',
      90,
      100,
      new Date(now).toISOString(),
      {
        unit: 'hour',
        startsAt: hourStart.toISOString(),
        endsAt: new Date(
          hourStart.getTime() + 60 * 60 * 1_000,
        ).toISOString(),
      },
    );
    expect(usage).not.toBeNull();
    await usageStore.set(usage!);
    const { provider } = createProvider(fetchImpl, usageStore);

    const result = await provider.load([player()]);

    expect(result.get(playerMarketOddsKey(player()))).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not retry a 429 and blocks requests until the provider reset', async () => {
    const resetAt = '2026-07-30T12:47:00.000Z';
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(null, {
        status: 429,
        headers: {
          'retry-after': '60',
          'x-ratelimit-limit': '100',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': resetAt,
        },
      }),
    );
    const usageStore = new InMemoryProviderQuotaUsageStore(() => now);
    const { provider } = createProvider(
      fetchImpl,
      usageStore,
      undefined,
      3,
    );

    const first = await provider.load([player()]);
    const second = await provider.load([player()]);

    expect(first.get(playerMarketOddsKey(player()))).toBeNull();
    expect(second.get(playerMarketOddsKey(player()))).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(
      usageStore.get('odds-api-io-hourly'),
    ).resolves.toMatchObject({
      used: 100,
      limit: 100,
      remaining: 0,
      interval: {
        unit: 'hour',
        endsAt: resetAt,
      },
    });
  });

  it('deduplicates a concurrent same-fixture refresh across provider instances', async () => {
    const usageStore = new InMemoryProviderQuotaUsageStore(() => now);
    const store = new InMemoryMarketSnapshotStore(60_000, () => now);
    let releaseFirstFetch = () => undefined;
    const firstFetchGate = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    const firstFetch = vi.fn<typeof fetch>(async () => {
      await firstFetchGate;
      return new Response(null, { status: 500 });
    });
    const secondFetch = vi.fn<typeof fetch>(async () =>
      json([]),
    );
    const first = createProvider(
      firstFetch,
      usageStore,
      undefined,
      0,
      store,
    ).provider;
    const second = createProvider(
      secondFetch,
      usageStore,
      undefined,
      0,
      store,
    ).provider;

    const firstLoad = first.load([player()]);
    await vi.waitFor(() => expect(firstFetch).toHaveBeenCalledTimes(1));
    try {
      await second.load([player()]);
      expect(secondFetch).not.toHaveBeenCalled();
    } finally {
      releaseFirstFetch();
      await firstLoad;
    }
  });

  it('does not let one fixture lease block a different fixture', async () => {
    const usageStore = new InMemoryProviderQuotaUsageStore(() => now);
    const store = new InMemoryMarketSnapshotStore(60_000, () => now);
    const firstFixture = player();
    const secondFixture = player({
      slug: 'seedy-jatta',
      displayName: 'Seedy Jatta',
      nextGame: {
        ...player().nextGame!,
        date: '2026-08-01T18:00:00.000Z',
        homeTeamName: 'Rapid Wien',
        awayTeamName: 'Sturm Graz',
        playerTeamName: 'Sturm Graz',
        opponentTeamName: 'Rapid Wien',
      },
    });
    let releaseFirstFetch = () => undefined;
    const firstFetchGate = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    const firstFetch = vi.fn<typeof fetch>(async () => {
      await firstFetchGate;
      return new Response(null, { status: 500 });
    });
    const secondFetch = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/events')) {
        return json([
          {
            id: 'austria-fixture-2',
            date: secondFixture.nextGame!.date,
            home: 'Rapid Wien',
            away: 'SK Sturm Graz',
          },
        ]);
      }
      return json([
        {
          id: 'austria-fixture-2',
          date: secondFixture.nextGame!.date,
          home: 'Rapid Wien',
          away: 'SK Sturm Graz',
          bookmakers: {
            Bet365: [
              {
                name: 'Anytime Goalscorer',
                odds: [{ label: 'Seedy Jatta', over: 3.5 }],
              },
            ],
          },
        },
      ]);
    });
    const first = createProvider(
      firstFetch,
      usageStore,
      undefined,
      0,
      store,
    ).provider;
    const second = createProvider(
      secondFetch,
      usageStore,
      undefined,
      0,
      store,
    ).provider;

    const firstLoad = first.load([firstFixture]);
    await vi.waitFor(() => expect(firstFetch).toHaveBeenCalledTimes(1));
    try {
      const result = await second.load([secondFixture]);

      expect(secondFetch).toHaveBeenCalledTimes(2);
      expect(
        result.get(playerMarketOddsKey(secondFixture))?.goal?.probability,
      ).toBeCloseTo(1 / 3.5);
    } finally {
      releaseFirstFetch();
      await firstLoad;
    }
  });
});
