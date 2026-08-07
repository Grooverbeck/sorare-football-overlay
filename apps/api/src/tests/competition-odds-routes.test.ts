import { describe, expect, it } from 'vitest';
import {
  CONTENDER_COMPETITION_SLUGS,
  CONTENDER_THE_ODDS_API_ROUTES,
  LEAGUES_CUP_COMPETITION_SLUGS,
  LEAGUES_CUP_THE_ODDS_API_ROUTES,
  ODDS_API_IO_PLAYER_ROUTES,
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

describe('Contender external odds routes', () => {
  it('documents every Sorare 27 Contender competition exactly once', () => {
    expect(CONTENDER_COMPETITION_SLUGS).toEqual([
      'austrian-bundesliga',
      '1-hnl',
      '2-bundesliga',
      'ligue-2-fr',
    ]);
    expect(new Set(CONTENDER_COMPETITION_SLUGS).size).toBe(
      CONTENDER_COMPETITION_SLUGS.length,
    );
  });

  it('enables only the Contender competitions currently exposed by The Odds API', () => {
    expect(CONTENDER_THE_ODDS_API_ROUTES).toEqual([
      {
        sportKeys: ['soccer_austria_bundesliga'],
        competitionSlugs: ['austrian-bundesliga'],
        region: 'eu',
        fallbackRegion: 'uk',
      },
      {
        sportKeys: ['soccer_germany_bundesliga2'],
        competitionSlugs: ['2-bundesliga'],
        region: 'eu',
        fallbackRegion: 'uk',
      },
    ]);
    expect(
      CONTENDER_THE_ODDS_API_ROUTES.flatMap(
        ({ competitionSlugs }) => competitionSlugs,
      ),
    ).not.toEqual(expect.arrayContaining(['1-hnl', 'ligue-2-fr']));
  });

  it('uses Odds-API.io as a final goalscorer fallback for every supported pool', () => {
    const competitions = ODDS_API_IO_PLAYER_ROUTES.flatMap(
      ({ competitionSlugs }) => competitionSlugs,
    );

    expect(competitions).toEqual(
      expect.arrayContaining([
        'mlspa',
        'leagues-cup-mls',
        'uefa-champions-league',
        'uefa-europa-league',
        'uefa-europa-conference-league',
        ...CONTENDER_COMPETITION_SLUGS,
      ]),
    );
    expect(new Set(competitions).size).toBe(competitions.length);
    expect(
      ODDS_API_IO_PLAYER_ROUTES.find(({ competitionSlugs }) =>
        competitionSlugs.some((slug) => slug === 'leagues-cup-mls'),
      )?.leagueSlugs,
    ).toEqual(['international-clubs-leagues-cup-group-stage']);
    expect(
      ODDS_API_IO_PLAYER_ROUTES.find(({ competitionSlugs }) =>
        competitionSlugs.some(
          (slug) => slug === 'uefa-champions-league',
        ),
      )?.leagueSlugs,
    ).toEqual([
      'international-clubs-uefa-champions-league-qualification',
      'international-clubs-uefa-champions-league',
    ]);
  });
});
