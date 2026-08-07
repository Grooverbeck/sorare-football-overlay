import type { PlayerStats } from '@sorare-overlay/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../logger.js';
import {
  InMemoryMatchOddsSnapshotStore,
  TheOddsApiFixtureMatchOddsProvider,
} from '../providers/match-odds-provider.js';
import {
  CONTENDER_THE_ODDS_API_ROUTES,
  LEAGUES_CUP_THE_ODDS_API_ROUTES,
} from '../providers/competition-odds-routes.js';
import {
  marketFixtureKey,
  playerMarketOddsKey,
} from '../providers/market-odds-provider.js';

const now = Date.parse('2026-07-29T12:00:00.000Z');
const logger: AppLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function player(
  kickoff: string,
  playerTeamName = 'Atlanta United FC',
): PlayerStats {
  return {
    slug: playerTeamName.startsWith('Atlanta') ? 'atl-player' : 'chi-player',
    displayName: 'Test Player',
    position: 'Defender',
    aaL10: { value: 10, sampleSize: 10 },
    cleanSheetL10: { value: 0.3, sampleSize: 10 },
    goalL10: { value: 0.1, sampleSize: 10 },
    nextGame: {
      date: kickoff,
      competitionSlug: 'mlspa',
      homeTeamName: 'Chicago Fire FC',
      awayTeamName: 'Atlanta United FC',
      playerTeamName,
      opponentTeamName:
        playerTeamName === 'Chicago Fire FC'
          ? 'Atlanta United FC'
          : 'Chicago Fire FC',
      cleanSheetProbability: null,
      matchProbabilities: null,
    },
    excludedLowCoverage: 0,
  };
}

function provider(
  fetchImpl: typeof fetch,
  store = new InMemoryMatchOddsSnapshotStore(() => now),
) {
  return new TheOddsApiFixtureMatchOddsProvider({
    apiKey: 'test-key',
    baseUrl: 'https://api.the-odds-api.test/v4',
    routes: [
      {
        sportKeys: ['soccer_usa_mls'],
        competitionSlugs: ['mlspa'],
        region: 'us',
      },
    ],
    fallbackWindowMs: 72 * 60 * 60 * 1_000,
    missTtlMs: 6 * 60 * 60 * 1_000,
    requestTimeoutMs: 1_000,
    maxRetries: 0,
    store,
    logger,
    fetchImpl,
    now: () => now,
  });
}

function oddsResponse(kickoff: string): Response {
  return new Response(
    JSON.stringify([
      {
        id: 'event-1',
        commence_time: kickoff,
        home_team: 'Chicago Fire',
        away_team: 'Atlanta United',
        bookmakers: [
          {
            key: 'book-one',
            title: 'Book One',
            markets: [
              {
                key: 'h2h',
                outcomes: [
                  { name: 'Chicago Fire', price: 2 },
                  { name: 'Draw', price: 4 },
                  { name: 'Atlanta United', price: 4 },
                ],
              },
            ],
          },
        ],
      },
    ]),
    {
      headers: {
        'content-type': 'application/json',
        'x-requests-used': '4',
        'x-requests-remaining': '496',
      },
    },
  );
}

describe('TheOddsApiFixtureMatchOddsProvider', () => {
  it('does not contact the external API earlier than 72 hours before kickoff', async () => {
    const kickoff = new Date(now + 73 * 60 * 60 * 1_000).toISOString();
    const fetchImpl = vi.fn<typeof fetch>();
    const testPlayer = player(kickoff);

    const result = await provider(fetchImpl).load([testPlayer]);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.get(playerMarketOddsKey(testPlayer))).toBeNull();
  });

  it('removes the bookmaker margin and returns player-relative H-D-A values', async () => {
    const kickoff = new Date(now + 48 * 60 * 60 * 1_000).toISOString();
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.searchParams.get('commenceTimeFrom')).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
      );
      expect(url.searchParams.get('commenceTimeTo')).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
      );
      return oddsResponse(kickoff);
    });
    const awayPlayer = player(kickoff);
    const homePlayer = player(kickoff, 'Chicago Fire FC');

    const result = await provider(fetchImpl).load([awayPlayer, homePlayer]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.get(playerMarketOddsKey(awayPlayer))).toEqual({
      win: 0.25,
      draw: 0.25,
      loss: 0.5,
    });
    expect(result.get(playerMarketOddsKey(homePlayer))).toEqual({
      win: 0.5,
      draw: 0.25,
      loss: 0.25,
    });
  });

  it('reuses the frozen fixture snapshot without another paid request', async () => {
    const kickoff = new Date(now + 48 * 60 * 60 * 1_000).toISOString();
    const fetchImpl = vi.fn<typeof fetch>(async () => oddsResponse(kickoff));
    const store = new InMemoryMatchOddsSnapshotStore(() => now);
    const oddsProvider = provider(fetchImpl, store);
    const testPlayer = player(kickoff);

    await oddsProvider.load([testPlayer]);
    const cached = await oddsProvider.load([testPlayer], { cacheOnly: true });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cached.get(playerMarketOddsKey(testPlayer))).toEqual({
      win: 0.25,
      draw: 0.25,
      loss: 0.5,
    });
  });

  it('deduplicates a concurrent H-D-A refresh across provider instances sharing a store', async () => {
    const kickoff = new Date(now + 48 * 60 * 60 * 1_000).toISOString();
    const fetchImpl = vi.fn<typeof fetch>(async () => oddsResponse(kickoff));
    const store = new InMemoryMatchOddsSnapshotStore(() => now);
    const testPlayer = player(kickoff);

    const results = await Promise.all([
      provider(fetchImpl, store).load([testPlayer]),
      provider(fetchImpl, store).load([testPlayer]),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(
      results.some(
        (result) =>
          result.get(playerMarketOddsKey(testPlayer))?.win === 0.25,
      ),
    ).toBe(true);
  });

  it('refreshes an old miss using the dedicated match-odds TTL', async () => {
    const kickoff = new Date(now + 48 * 60 * 60 * 1_000).toISOString();
    const testPlayer = player(kickoff);
    const fixtureKey = marketFixtureKey(testPlayer.nextGame!);
    expect(fixtureKey).not.toBeNull();
    const store = new InMemoryMatchOddsSnapshotStore(() => now);
    await store.set(fixtureKey!, {
      status: 'unavailable',
      checkedAt: new Date(now - 2 * 60 * 60 * 1_000).toISOString(),
      expiresAt: new Date(now + 4 * 60 * 60 * 1_000).toISOString(),
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => oddsResponse(kickoff));
    const oddsProvider = new TheOddsApiFixtureMatchOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.test/v4',
      routes: [
        {
          sportKeys: ['soccer_usa_mls'],
          competitionSlugs: ['mlspa'],
          region: 'us',
        },
      ],
      fallbackWindowMs: 72 * 60 * 60 * 1_000,
      missTtlMs: 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store,
      logger,
      fetchImpl,
      now: () => now,
    });

    const result = await oddsProvider.load([testPlayer]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.get(playerMarketOddsKey(testPlayer))).toEqual({
      win: 0.25,
      draw: 0.25,
      loss: 0.5,
    });
  });

  it('does not negative-cache a temporary provider failure', async () => {
    const kickoff = new Date(now + 48 * 60 * 60 * 1_000).toISOString();
    const testPlayer = player(kickoff);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(oddsResponse(kickoff));
    const store = new InMemoryMatchOddsSnapshotStore(() => now);
    const oddsProvider = provider(fetchImpl, store);

    const failed = await oddsProvider.load([testPlayer]);
    const recovered = await oddsProvider.load([testPlayer]);

    expect(failed.get(playerMarketOddsKey(testPlayer))).toBeNull();
    expect(recovered.get(playerMarketOddsKey(testPlayer))).toEqual({
      win: 0.25,
      draw: 0.25,
      loss: 0.5,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('prefetches all returned MLS fixtures and matches Montreal-New England aliases', async () => {
    const chicagoKickoff = new Date(
      now + 46 * 60 * 60 * 1_000,
    ).toISOString();
    const newEnglandKickoff = new Date(
      now + 48 * 60 * 60 * 1_000,
    ).toISOString();
    const chicagoPlayer = player(chicagoKickoff);
    const newEnglandPlayer: PlayerStats = {
      ...player(newEnglandKickoff, 'New England'),
      slug: 'matt-turner',
      position: 'Goalkeeper',
      nextGame: {
        date: newEnglandKickoff,
        competitionSlug: 'mlspa',
        homeTeamName: 'Montreal Impact',
        awayTeamName: 'New England',
        playerTeamName: 'New England',
        opponentTeamName: 'Montreal Impact',
        cleanSheetProbability: null,
        matchProbabilities: null,
      },
    };
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify([
          JSON.parse(await oddsResponse(chicagoKickoff).text())[0],
          {
            id: 'montreal-new-england',
            commence_time: newEnglandKickoff,
            home_team: 'CF Montreal',
            away_team: 'New England Revolution',
            bookmakers: [
              {
                key: 'book-one',
                title: 'Book One',
                markets: [
                  {
                    key: 'h2h',
                    outcomes: [
                      { name: 'CF Montreal', price: 2 },
                      { name: 'Draw', price: 4 },
                      { name: 'New England Revolution', price: 4 },
                    ],
                  },
                ],
              },
            ],
          },
        ]),
        {
          headers: {
            'content-type': 'application/json',
            'x-requests-used': '5',
            'x-requests-remaining': '495',
          },
        },
      ),
    );
    const store = new InMemoryMatchOddsSnapshotStore(() => now);
    const oddsProvider = provider(fetchImpl, store);

    await oddsProvider.load([chicagoPlayer]);
    const cached = await oddsProvider.load([newEnglandPlayer], {
      cacheOnly: true,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cached.get(playerMarketOddsKey(newEnglandPlayer))).toEqual({
      win: 0.25,
      draw: 0.25,
      loss: 0.5,
    });
  });

  it('matches an Austrian Contender fixture despite provider team-name differences', async () => {
    const kickoff = '2026-07-31T17:30:00.000Z';
    const contenderPlayer: PlayerStats = {
      ...player(kickoff, 'Wattens'),
      slug: 'wattens-defender',
      nextGame: {
        date: kickoff,
        competitionSlug: 'austrian-bundesliga',
        homeTeamName: 'Wattens',
        awayTeamName: 'Sturm Graz',
        playerTeamName: 'Wattens',
        opponentTeamName: 'Sturm Graz',
        cleanSheetProbability: null,
        matchProbabilities: null,
      },
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toContain(
        '/sports/soccer_austria_bundesliga/odds?',
      );
      return new Response(
        JSON.stringify([
          {
            id: 'austria-event',
            commence_time: kickoff,
            home_team: 'WSG Tirol',
            away_team: 'Sturm Graz',
            bookmakers: [
              {
                key: 'book-one',
                title: 'Book One',
                markets: [
                  {
                    key: 'h2h',
                    outcomes: [
                      { name: 'WSG Tirol', price: 3 },
                      { name: 'Draw', price: 3.4 },
                      { name: 'Sturm Graz', price: 2.2 },
                    ],
                  },
                ],
              },
            ],
          },
        ]),
        {
          headers: {
            'content-type': 'application/json',
            'x-requests-used': '5',
            'x-requests-remaining': '495',
          },
        },
      );
    });
    const oddsProvider = new TheOddsApiFixtureMatchOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.test/v4',
      routes: CONTENDER_THE_ODDS_API_ROUTES,
      fallbackWindowMs: 72 * 60 * 60 * 1_000,
      missTtlMs: 6 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMatchOddsSnapshotStore(() => now),
      logger,
      fetchImpl,
      now: () => now,
    });

    const result = await oddsProvider.load([contenderPlayer]);

    expect(result.get(playerMarketOddsKey(contenderPlayer))).toEqual({
      win: expect.any(Number),
      draw: expect.any(Number),
      loss: expect.any(Number),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('loads Leagues Cup odds and matches Liga MX team aliases', async () => {
    const kickoff = new Date(now + 48 * 60 * 60 * 1_000).toISOString();
    const leaguesCupPlayer: PlayerStats = {
      ...player(kickoff, 'Inter Miami CF'),
      slug: 'lionel-messi',
      position: 'Forward',
      nextGame: {
        date: kickoff,
        competitionSlug: 'leagues-cup-mls',
        homeTeamName: 'Inter Miami CF',
        awayTeamName: 'Atlético San Luis',
        playerTeamName: 'Inter Miami CF',
        opponentTeamName: 'Atlético San Luis',
        cleanSheetProbability: null,
        matchProbabilities: null,
      },
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toContain(
        '/sports/soccer_concacaf_leagues_cup/odds?',
      );
      return new Response(
        JSON.stringify([
          {
            id: 'leagues-cup-event',
            commence_time: kickoff,
            home_team: 'Inter Miami',
            away_team: 'Atlético de San Luis',
            bookmakers: [
              {
                key: 'book-one',
                title: 'Book One',
                markets: [
                  {
                    key: 'h2h',
                    outcomes: [
                      { name: 'Inter Miami', price: 1.8 },
                      { name: 'Draw', price: 4 },
                      { name: 'Atlético de San Luis', price: 4.5 },
                    ],
                  },
                ],
              },
            ],
          },
        ]),
        {
          headers: {
            'content-type': 'application/json',
            'x-requests-used': '5',
            'x-requests-remaining': '495',
          },
        },
      );
    });
    const oddsProvider = new TheOddsApiFixtureMatchOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.test/v4',
      routes: LEAGUES_CUP_THE_ODDS_API_ROUTES,
      fallbackWindowMs: 72 * 60 * 60 * 1_000,
      missTtlMs: 6 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMatchOddsSnapshotStore(() => now),
      logger,
      fetchImpl,
      now: () => now,
    });

    const result = await oddsProvider.load([leaguesCupPlayer]);

    expect(result.get(playerMarketOddsKey(leaguesCupPlayer))).toEqual({
      win: expect.any(Number),
      draw: expect.any(Number),
      loss: expect.any(Number),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
