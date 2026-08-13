import type { PlayerStats } from '@sorare-overlay/shared';
import { describe, expect, it } from 'vitest';
import { TtlCache } from '../cache.js';
import { loadConfig } from '../config.js';
import type { AppLogger } from '../logger.js';
import { playerMarketFieldSupported } from '../providers/market-odds-provider.js';
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
  it('exposes goal and assist only where the configured providers support them', () => {
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
      })),
    ).toEqual(
      lowerLeagues.map((competitionSlug) => ({
        competitionSlug,
        supportsAssist: false,
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
});
