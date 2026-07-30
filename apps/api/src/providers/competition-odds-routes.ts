import type { MatchOddsRoute } from './match-odds-provider.js';

/**
 * Sorare 27 Contender pool (Limited/Rare).
 *
 * The external providers do not currently cover all four competitions:
 * The Odds API exposes Austria and Germany's second tier, while neither
 * configured provider exposes Croatia's HNL or France's Ligue 2.
 */
export const CONTENDER_COMPETITION_SLUGS = [
  'austrian-bundesliga',
  '1-hnl',
  '2-bundesliga',
  'ligue-2-fr',
] as const;

export const CONTENDER_THE_ODDS_API_ROUTES = [
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
] as const satisfies readonly MatchOddsRoute[];

export interface OddsApiIoPlayerRoute {
  competitionSlugs: readonly string[];
  leagueSlugs: readonly string[];
}

/**
 * Odds-API.io is the last goalscorer fallback after SportsGameOdds and
 * The Odds API. Multiple provider leagues are listed for UEFA competitions
 * because qualifiers and the main competition use separate feed slugs.
 */
export const ODDS_API_IO_PLAYER_ROUTES = [
  {
    competitionSlugs: ['mlspa'],
    leagueSlugs: ['usa-mls'],
  },
  {
    competitionSlugs: ['uefa-champions-league'],
    leagueSlugs: [
      'international-clubs-uefa-champions-league-qualification',
      'international-clubs-uefa-champions-league',
    ],
  },
  {
    competitionSlugs: ['uefa-europa-league'],
    leagueSlugs: [
      'international-clubs-uefa-europa-league-qualification',
      'international-clubs-uefa-europa-league',
    ],
  },
  {
    competitionSlugs: ['uefa-europa-conference-league'],
    leagueSlugs: [
      'international-clubs-uefa-conference-league-qualification',
      'international-clubs-uefa-conference-league',
    ],
  },
  {
    competitionSlugs: ['austrian-bundesliga'],
    leagueSlugs: ['austria-bundesliga'],
  },
  {
    competitionSlugs: ['2-bundesliga'],
    leagueSlugs: ['germany-2-bundesliga'],
  },
  {
    competitionSlugs: ['1-hnl'],
    leagueSlugs: ['croatia-hnl'],
  },
  {
    competitionSlugs: ['ligue-2-fr'],
    leagueSlugs: ['france-ligue-2'],
  },
] as const satisfies readonly OddsApiIoPlayerRoute[];
