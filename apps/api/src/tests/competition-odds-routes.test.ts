import { describe, expect, it } from 'vitest';
import {
  EUROPEAN_COMPETITION_SLUGS,
  EUROPEAN_ODDS_CAPABILITIES,
  EUROPEAN_THE_ODDS_API_MATCH_ROUTES,
  EUROPEAN_THE_ODDS_API_PLAYER_ROUTES,
  LEAGUES_CUP_COMPETITION_SLUGS,
  LEAGUES_CUP_THE_ODDS_API_ROUTES,
  ODDS_API_IO_ROUTES,
  SPORTS_GAME_ODDS_ROUTES,
} from '../providers/competition-odds-routes.js';

describe('Leagues Cup external odds route', () => {
  it('maps the Sorare competition to the dedicated CONCACAF feed', () => {
    expect(LEAGUES_CUP_COMPETITION_SLUGS).toEqual([
      'leagues-cup-mls',
    ]);
    expect(LEAGUES_CUP_THE_ODDS_API_ROUTES).toEqual([
      {
        sportKeys: ['soccer_concacaf_leagues_cup'],
        competitionSlugs: ['leagues-cup-mls'],
        region: 'us',
        fallbackRegion: 'uk',
      },
    ]);
  });
});

describe('European competition odds capabilities', () => {
  it('documents each requested Sorare competition exactly once', () => {
    expect(EUROPEAN_COMPETITION_SLUGS).toEqual([
      'laliga-es',
      'ligue-2-fr',
      'ligue-1-fr',
      'bundesliga-de',
      '2-bundesliga',
      '1-hnl',
      'austrian-bundesliga',
    ]);
    expect(new Set(EUROPEAN_COMPETITION_SLUGS).size).toBe(
      EUROPEAN_COMPETITION_SLUGS.length,
    );
  });

  it('keeps match routes on EU/UK books and covers every league except HNL', () => {
    expect(EUROPEAN_THE_ODDS_API_MATCH_ROUTES).toEqual([
      {
        sportKeys: ['soccer_spain_la_liga'],
        competitionSlugs: ['laliga-es'],
        region: 'eu',
        fallbackRegion: 'uk',
      },
      {
        sportKeys: ['soccer_france_ligue_two'],
        competitionSlugs: ['ligue-2-fr'],
        region: 'eu',
        fallbackRegion: 'uk',
      },
      {
        sportKeys: ['soccer_france_ligue_one'],
        competitionSlugs: ['ligue-1-fr'],
        region: 'eu',
        fallbackRegion: 'uk',
      },
      {
        sportKeys: ['soccer_germany_bundesliga'],
        competitionSlugs: ['bundesliga-de'],
        region: 'eu',
        fallbackRegion: 'uk',
      },
      {
        sportKeys: ['soccer_germany_bundesliga2'],
        competitionSlugs: ['2-bundesliga'],
        region: 'eu',
        fallbackRegion: 'uk',
      },
      {
        sportKeys: ['soccer_austria_bundesliga'],
        competitionSlugs: ['austrian-bundesliga'],
        region: 'eu',
        fallbackRegion: 'uk',
      },
    ]);
    expect(
      EUROPEAN_THE_ODDS_API_MATCH_ROUTES.flatMap(
        ({ competitionSlugs }) => competitionSlugs,
      ),
    ).not.toContain('1-hnl');
  });

  it('keeps monthly-credit US player props inside the 24-hour window', () => {
    expect(EUROPEAN_THE_ODDS_API_PLAYER_ROUTES).toEqual([
      {
        sportKeys: ['soccer_spain_la_liga'],
        competitionSlugs: ['laliga-es'],
        region: 'us',
        fallbackRegion: null,
        markets: ['goal', 'assist'],
        fetchWindowMs: 24 * 60 * 60 * 1_000,
      },
      {
        sportKeys: ['soccer_france_ligue_one'],
        competitionSlugs: ['ligue-1-fr'],
        region: 'us',
        fallbackRegion: null,
        markets: ['goal', 'assist'],
        fetchWindowMs: 24 * 60 * 60 * 1_000,
      },
      {
        sportKeys: ['soccer_germany_bundesliga'],
        competitionSlugs: ['bundesliga-de'],
        region: 'us',
        fallbackRegion: null,
        markets: ['goal', 'assist'],
        fetchWindowMs: 24 * 60 * 60 * 1_000,
      },
    ]);
  });

  it('uses SportsGameOdds for the four documented European league feeds', () => {
    expect(SPORTS_GAME_ODDS_ROUTES).toEqual([
      {
        competitionSlugs: ['mlspa'],
        leagueId: 'MLS',
        playerMarkets: ['goal', 'assist'],
        matchOdds: true,
      },
      {
        competitionSlugs: ['uefa-champions-league'],
        leagueId: 'UEFA_CHAMPIONS_LEAGUE',
        playerMarkets: ['goal', 'assist'],
        matchOdds: true,
      },
      {
        competitionSlugs: ['uefa-europa-league'],
        leagueId: 'UEFA_EUROPA_LEAGUE',
        playerMarkets: ['goal', 'assist'],
        matchOdds: true,
      },
      {
        competitionSlugs: ['laliga-es'],
        leagueId: 'LA_LIGA',
        playerMarkets: ['goal', 'assist'],
        matchOdds: true,
        playerFetchWindowMs: 72 * 60 * 60 * 1_000,
        matchOddsFetchWindowMs: 72 * 60 * 60 * 1_000,
      },
      {
        competitionSlugs: ['ligue-2-fr'],
        leagueId: 'FR_LIGUE_2',
        playerMarkets: ['goal'],
        matchOdds: true,
        playerFetchWindowMs: 72 * 60 * 60 * 1_000,
        matchOddsFetchWindowMs: 72 * 60 * 60 * 1_000,
      },
      {
        competitionSlugs: ['ligue-1-fr'],
        leagueId: 'FR_LIGUE_1',
        playerMarkets: ['goal', 'assist'],
        matchOdds: true,
        playerFetchWindowMs: 72 * 60 * 60 * 1_000,
        matchOddsFetchWindowMs: 72 * 60 * 60 * 1_000,
      },
      {
        competitionSlugs: ['bundesliga-de'],
        leagueId: 'BUNDESLIGA',
        playerMarkets: ['goal', 'assist'],
        matchOdds: true,
        playerFetchWindowMs: 72 * 60 * 60 * 1_000,
        matchOddsFetchWindowMs: 72 * 60 * 60 * 1_000,
      },
    ]);
    expect(
      SPORTS_GAME_ODDS_ROUTES.flatMap(({ competitionSlugs }) =>
        competitionSlugs,
      ),
    ).not.toEqual(
      expect.arrayContaining([
        '2-bundesliga',
        '1-hnl',
        'austrian-bundesliga',
      ]),
    );
  });

  it('routes goals for all seven leagues through Odds-API.io and marks only HNL for match odds', () => {
    const routes = ODDS_API_IO_ROUTES.filter(({ competitionSlugs }) =>
      competitionSlugs.some((slug) =>
        EUROPEAN_COMPETITION_SLUGS.includes(
          slug as (typeof EUROPEAN_COMPETITION_SLUGS)[number],
        ),
      ),
    );

    expect(routes).toHaveLength(EUROPEAN_COMPETITION_SLUGS.length);
    expect(routes).toEqual(
      expect.arrayContaining(
        EUROPEAN_ODDS_CAPABILITIES.map(
          ({ competitionSlug, oddsApiIo }) => ({
            competitionSlugs: [competitionSlug],
            leagueSlugs: oddsApiIo.leagueSlugs,
            playerMarkets: ['goal'],
            matchOdds: oddsApiIo.matchOdds,
            playerFetchWindowMs: 72 * 60 * 60 * 1_000,
          }),
        ),
      ),
    );
    expect(routes.filter(({ matchOdds }) => matchOdds)).toEqual([
      expect.objectContaining({
        competitionSlugs: ['1-hnl'],
        leagueSlugs: ['croatia-hnl'],
      }),
    ]);
  });

  it('preserves the existing MLS, Leagues Cup and UEFA goalscorer fallbacks', () => {
    const competitions = ODDS_API_IO_ROUTES.flatMap(
      ({ competitionSlugs }) => competitionSlugs,
    );
    expect(competitions).toEqual(
      expect.arrayContaining([
        'mlspa',
        'leagues-cup-mls',
        'uefa-champions-league',
        'uefa-europa-league',
        'uefa-europa-conference-league',
      ]),
    );
    expect(new Set(competitions).size).toBe(competitions.length);
  });

  it('uses the live La Liga slug and checks current UEFA playoff feeds first', () => {
    expect(
      ODDS_API_IO_ROUTES.find(({ competitionSlugs }) =>
        competitionSlugs.includes('laliga-es'),
      )?.leagueSlugs,
    ).toEqual(['spain-laliga']);
    expect(
      ODDS_API_IO_ROUTES.find(({ competitionSlugs }) =>
        competitionSlugs.includes('uefa-champions-league'),
      )?.leagueSlugs,
    ).toEqual([
      'international-clubs-uefa-champions-league-playoff-round',
      'international-clubs-uefa-champions-league-qualification',
      'international-clubs-uefa-champions-league',
    ]);
    expect(
      ODDS_API_IO_ROUTES.find(({ competitionSlugs }) =>
        competitionSlugs.includes('uefa-europa-league'),
      )?.leagueSlugs[0],
    ).toBe('international-clubs-uefa-europa-league-playoff-round');
    expect(
      ODDS_API_IO_ROUTES.find(({ competitionSlugs }) =>
        competitionSlugs.includes('uefa-europa-conference-league'),
      ),
    ).toMatchObject({
      leagueSlugs: [
        'international-clubs-uefa-conference-league-playoff-round',
        'international-clubs-uefa-conference-league-qualification',
        'international-clubs-uefa-conference-league',
      ],
      matchOdds: true,
    });
  });
});
