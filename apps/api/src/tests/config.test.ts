import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

describe('loadConfig cache TTLs', () => {
  it('uses purpose-specific defaults', () => {
    const config = loadConfig({});

    expect(config.playerFormCacheTtlMs).toBe(604_800_000);
    expect(config.fixtureCacheTtlMs).toBe(14_400_000);
    expect(config.nameCacheTtlMs).toBe(2_592_000_000);
    expect(config.nameMissCacheTtlMs).toBe(7_200_000);
    expect(config.oddsFetchWindowMs).toBe(259_200_000);
    expect(config.matchOddsFallbackWindowMs).toBe(259_200_000);
    expect(config.oddsMissCacheTtlMs).toBe(21_600_000);
    expect(config.oddsApiFallbackRegion).toBeUndefined();
    expect(config.sportsGameOddsBaseUrl).toBe(
      'https://api.sportsgameodds.com/v2',
    );
    expect(config.sportsGameOddsLeagueId).toBe('MLS');
    expect(config.oddsApiIoKey).toBeUndefined();
    expect(config.oddsApiIoBaseUrl).toBe('https://api.odds-api.io/v3');
    expect(config.oddsApiIoLeague).toBe('austria-bundesliga');
    expect(config.oddsApiIoBookmakers).toEqual(['Bet365', 'Unibet']);
    expect(config.oddsApiIoDailyRequestLimit).toBe(500);
    expect(config.oddsApiIoHourlyRequestLimit).toBe(100);
  });

  it('accepts the legacy cache TTL as a form-cache fallback', () => {
    const config = loadConfig({ CACHE_TTL_SECONDS: '3600' });

    expect(config.playerFormCacheTtlMs).toBe(3_600_000);
    expect(config.cacheTtlMs).toBe(3_600_000);
    expect(config.fixtureCacheTtlMs).toBe(14_400_000);
  });

  it('allows each cache TTL to be configured independently', () => {
    const config = loadConfig({
      PLAYER_FORM_CACHE_TTL_SECONDS: '43200',
      FIXTURE_CACHE_TTL_SECONDS: '10800',
      NAME_CACHE_TTL_SECONDS: '1209600',
      NAME_MISS_CACHE_TTL_SECONDS: '3600',
      ODDS_FETCH_WINDOW_HOURS: '6',
      MATCH_ODDS_FALLBACK_WINDOW_HOURS: '48',
      ODDS_MISS_CACHE_TTL_SECONDS: '900',
      ODDS_API_FALLBACK_REGION: 'uk',
      THE_ODDS_API_KEY: 'server-only-test-key',
      SPORTS_GAME_ODDS_API_KEY: 'server-only-sgo-key',
      ODDS_API_IO_KEY: 'server-only-odds-api-io-key',
      ODDS_API_IO_BASE_URL: 'https://example.test/v3',
      ODDS_API_IO_LEAGUE: 'custom-league',
      ODDS_API_IO_BOOKMAKERS: 'Bet365, Unibet',
      ODDS_API_IO_DAILY_REQUEST_LIMIT: '450',
      ODDS_API_IO_HOURLY_REQUEST_LIMIT: '90',
    });

    expect(config).toMatchObject({
      playerFormCacheTtlMs: 43_200_000,
      fixtureCacheTtlMs: 10_800_000,
      nameCacheTtlMs: 1_209_600_000,
      nameMissCacheTtlMs: 3_600_000,
      oddsFetchWindowMs: 21_600_000,
      matchOddsFallbackWindowMs: 172_800_000,
      oddsMissCacheTtlMs: 900_000,
      oddsApiFallbackRegion: 'uk',
      oddsApiKey: 'server-only-test-key',
      sportsGameOddsApiKey: 'server-only-sgo-key',
      oddsApiIoKey: 'server-only-odds-api-io-key',
      oddsApiIoBaseUrl: 'https://example.test/v3',
      oddsApiIoLeague: 'custom-league',
      oddsApiIoBookmakers: ['Bet365', 'Unibet'],
      oddsApiIoDailyRequestLimit: 450,
      oddsApiIoHourlyRequestLimit: 90,
    });
  });
});
