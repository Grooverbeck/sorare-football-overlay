import type { PlayerStats } from '@sorare-overlay/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../logger.js';
import {
  InMemoryMatchOddsSnapshotStore,
  TheOddsApiFixtureMatchOddsProvider,
} from '../providers/match-odds-provider.js';
import { CONTENDER_THE_ODDS_API_ROUTES } from '../providers/competition-odds-routes.js';
import { playerMarketOddsKey } from '../providers/market-odds-provider.js';

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
    const fetchImpl = vi.fn<typeof fetch>(async () => oddsResponse(kickoff));
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
});
