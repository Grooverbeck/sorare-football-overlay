import type { PlayerStats } from '@sorare-overlay/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../logger.js';
import { InMemoryMarketSnapshotStore, playerMarketOddsKey } from '../providers/market-odds-provider.js';
import { OddsApiIoPlayerMarketOddsProvider } from '../providers/odds-api-io-provider.js';
import {
  InMemoryProviderQuotaUsageStore,
  quotaUsage,
} from '../providers/odds-usage.js';
import type { OddsApiIoPlayerRoute } from '../providers/competition-odds-routes.js';

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
  usageStore = new InMemoryProviderQuotaUsageStore(),
  routes: readonly OddsApiIoPlayerRoute[] = [
    {
      competitionSlugs: ['austrian-bundesliga'],
      leagueSlugs: ['austria-bundesliga'],
    },
  ],
) {
  return {
    provider: new OddsApiIoPlayerMarketOddsProvider({
      apiKey: 'server-only-test-key',
      baseUrl: 'https://api.odds-api.io/v3',
      bookmakers: ['Bet365', 'Unibet'],
      routes,
      fetchWindowMs: 72 * 60 * 60 * 1_000,
      dailyRequestLimit: 500,
      hourlyRequestLimit: 100,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(60_000, () => now),
      logger,
      usageStore,
      fetchImpl,
      now: () => now,
    }),
    usageStore,
  };
}

describe('OddsApiIoPlayerMarketOddsProvider', () => {
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

  it('falls through from a UEFA qualification feed to the main competition feed', async () => {
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
        return queriedLeagues.length === 1
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
            'international-clubs-uefa-champions-league-qualification',
            'international-clubs-uefa-champions-league',
          ],
        },
      ],
    );

    const result = await provider.load([uefaPlayer]);

    expect(queriedLeagues).toEqual([
      'international-clubs-uefa-champions-league-qualification',
      'international-clubs-uefa-champions-league',
    ]);
    expect(
      result.get(playerMarketOddsKey(uefaPlayer))?.goal?.probability,
    ).toBeCloseTo(1 / 3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
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
});
