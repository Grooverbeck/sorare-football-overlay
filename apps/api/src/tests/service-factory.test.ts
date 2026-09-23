import type { PlayerStats } from '@sorare-overlay/shared';
import { describe, expect, it, vi } from 'vitest';
import { TtlCache } from '../cache.js';
import { loadConfig } from '../config.js';
import type { AppLogger } from '../logger.js';
import {
  playerMarketFieldDrivesRequest,
  playerMarketFieldSupported,
  playerMarketOddsKey,
} from '../providers/market-odds-provider.js';
import { createStatsRuntime } from '../service-factory.js';

const logger: AppLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function player(competitionSlug: string): PlayerStats {
  return {
    slug: `player-${competitionSlug}`,
    displayName: 'Test Player',
    position: 'Forward',
    aaL10: { value: 10, sampleSize: 10 },
    cleanSheetL10: { value: 0, sampleSize: 0 },
    goalL10: { value: 0.2, sampleSize: 10 },
    nextGame: {
      date: new Date(Date.now() + 12 * 60 * 60 * 1_000).toISOString(),
      competitionSlug,
      homeTeamName: 'Home FC',
      awayTeamName: 'Away FC',
      playerTeamName: 'Home FC',
      opponentTeamName: 'Away FC',
      cleanSheetProbability: null,
      matchProbabilities: null,
    },
    excludedLowCoverage: 0,
  };
}

describe('createStatsRuntime European market routing', () => {
  it('exposes opportunistic assists without letting them drive lower-league requests', () => {
    const runtime = createStatsRuntime({
      config: loadConfig({
        MOCK_MODE: 'false',
        THE_ODDS_API_KEY: 'server-only-test-key',
        SPORTS_GAME_ODDS_API_KEY: 'server-only-sgo-test-key',
        ODDS_API_IO_KEY: 'server-only-io-test-key',
      }),
      logger,
      statsCache: new TtlCache<PlayerStats>(60_000),
    });

    for (const competitionSlug of [
      'laliga-es',
      'ligue-1-fr',
      'bundesliga-de',
    ]) {
      const stats = player(competitionSlug);
      expect(
        playerMarketFieldSupported(runtime.marketOddsProvider, stats, 'goal'),
      ).toBe(true);
      expect(
        playerMarketFieldSupported(
          runtime.marketOddsProvider,
          stats,
          'assist',
        ),
      ).toBe(true);
    }

    const lowerLeagues = [
      'ligue-2-fr',
      '2-bundesliga',
      '1-hnl',
      'austrian-bundesliga',
    ];
    for (const competitionSlug of lowerLeagues) {
      const stats = player(competitionSlug);
      expect(
        playerMarketFieldSupported(runtime.marketOddsProvider, stats, 'goal'),
      ).toBe(true);
    }
    expect(
      lowerLeagues.map((competitionSlug) => ({
        competitionSlug,
        supportsAssist: playerMarketFieldSupported(
          runtime.marketOddsProvider,
          player(competitionSlug),
          'assist',
        ),
        drivesAssistRequest: playerMarketFieldDrivesRequest(
          runtime.marketOddsProvider,
          player(competitionSlug),
          'assist',
        ),
      })),
    ).toEqual(
      lowerLeagues.map((competitionSlug) => ({
        competitionSlug,
        supportsAssist: true,
        drivesAssistRequest: false,
      })),
    );

    const unsupported = player('eredivisie');
    expect(
      playerMarketFieldSupported(
        runtime.marketOddsProvider,
        unsupported,
        'goal',
      ),
    ).toBe(false);
    expect(
      playerMarketFieldSupported(
        runtime.marketOddsProvider,
        unsupported,
        'assist',
      ),
    ).toBe(false);
    expect(
      playerMarketFieldDrivesRequest(
        runtime.marketOddsProvider,
        player('ligue-2-fr'),
        'assist',
      ),
    ).toBe(false);
  });

  it('uses the same SportsGameOdds league sources for props and H-D-A', () => {
    const runtime = createStatsRuntime({
      config: loadConfig({
        MOCK_MODE: 'false',
        SPORTS_GAME_ODDS_API_KEY: 'server-only-sgo-test-key',
      }),
      logger,
      statsCache: new TtlCache<PlayerStats>(60_000),
    });

    for (const competitionSlug of [
      'mlspa',
      'uefa-champions-league',
      'uefa-europa-league',
      'laliga-es',
      'ligue-2-fr',
      'ligue-1-fr',
      'bundesliga-de',
    ]) {
      const stats = player(competitionSlug);
      expect(
        playerMarketFieldSupported(runtime.marketOddsProvider, stats, 'goal'),
      ).toBe(true);
      expect(runtime.fixtureMatchOddsProvider.supports(stats)).toBe(true);
    }

    expect(
      playerMarketFieldSupported(
        runtime.marketOddsProvider,
        player('ligue-2-fr'),
        'assist',
      ),
    ).toBe(true);
    expect(
      playerMarketFieldDrivesRequest(
        runtime.marketOddsProvider,
        player('ligue-2-fr'),
        'assist',
      ),
    ).toBe(false);
    for (const competitionSlug of [
      '2-bundesliga',
      '1-hnl',
      'austrian-bundesliga',
    ]) {
      const stats = player(competitionSlug);
      expect(
        playerMarketFieldSupported(runtime.marketOddsProvider, stats, 'goal'),
      ).toBe(false);
      expect(runtime.fixtureMatchOddsProvider.supports(stats)).toBe(false);
    }
  });

  it('routes Nations League player markets exclusively to Odds.io and retains match-only The Odds API fallback', () => {
    const stats=player('uefa-nations-league');
    for(const keys of [{THE_ODDS_API_KEY:'test-key'},{SPORTS_GAME_ODDS_API_KEY:'test-key'}]) {
      const runtime=createStatsRuntime({config:loadConfig({MOCK_MODE:'false',...keys}),logger,statsCache:new TtlCache<PlayerStats>(60000)});
      expect(runtime.marketOddsProvider.supports(stats)).toBe(false);
      expect(runtime.fixtureMatchOddsProvider.supports(stats)).toBe('THE_ODDS_API_KEY' in keys);
    }
    const runtime=createStatsRuntime({config:loadConfig({MOCK_MODE:'false',ODDS_API_IO_KEY:'test-key'}),logger,statsCache:new TtlCache<PlayerStats>(60000)});
    expect(playerMarketFieldSupported(runtime.marketOddsProvider,stats,'goal')).toBe(true);
    expect(playerMarketFieldSupported(runtime.marketOddsProvider,stats,'assist')).toBe(true);
    expect(playerMarketFieldDrivesRequest(runtime.marketOddsProvider,stats,'goal')).toBe(true);
    expect(playerMarketFieldDrivesRequest(runtime.marketOddsProvider,stats,'assist')).toBe(false);
  });

  it('loads Nations League props 80 hours ahead through the complete provider chain without paid-provider calls', async () => {
    const stats: PlayerStats = {
      ...player('uefa-nations-league'),
      slug: 'lamine-yamal-nasraoui-ebana',
      displayName: 'Lamine Yamal',
      nextGame: {
        ...player('uefa-nations-league').nextGame!,
        date: new Date(Date.now() + 80 * 60 * 60 * 1_000).toISOString(),
        homeTeamName: 'England',
        awayTeamName: 'Spain',
        playerTeamName: 'Spain',
        opponentTeamName: 'England',
      },
    };
    const event = {
      id: 'nations-event', date: stats.nextGame!.date,
      home: 'England', away: 'Spain',
      sport: { slug: 'football' },
      league: { slug: 'international-uefa-nations-league-league-c-gr-2' },
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe('api.odds-api.io');
      if (url.pathname === '/v3/events/search') return Response.json([event]);
      expect(url.pathname).toBe('/v3/odds/multi');
      return Response.json([{ ...event, bookmakers: { Bet365: [
        { name: 'Anytime Goalscorer', odds: [{ label: 'Lamine Yamal', over: '3.4' }] },
        { name: 'Player To Assist', odds: [{ label: 'Lamine Yamal', over: '4.0' }] },
      ] } }]);
    });
    try {
      const runtime = createStatsRuntime({
        config: loadConfig({
          MOCK_MODE: 'false', THE_ODDS_API_KEY: 'test-key',
          SPORTS_GAME_ODDS_API_KEY: 'test-key', ODDS_API_IO_KEY: 'test-key',
        }),
        logger,
        statsCache: new TtlCache<PlayerStats>(60_000),
      });
      const result = await runtime.marketOddsProvider.load([stats]);
      expect(result.get(playerMarketOddsKey(stats))?.goal?.probability).toBeCloseTo(1 / 3.4);
      expect(result.get(playerMarketOddsKey(stats))?.assist?.probability).toBe(0.25);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const cached = await runtime.marketOddsProvider.load([stats], { cacheOnly: true });
      expect(cached.get(playerMarketOddsKey(stats))?.assist?.probability).toBe(0.25);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
