import type { MatchOddsRoute } from './match-odds-provider.js';
import type { PlayerMarketField } from './market-odds-provider.js';

// The Odds API consumes monthly credits per returned market. Keep its European
// player-prop fallback close to kickoff, while providers with free or regularly
// resetting allocations can start looking three days before the fixture.
const THE_ODDS_API_PLAYER_FETCH_WINDOW_MS = 24 * 60 * 60 * 1_000;
const EARLY_PLAYER_FETCH_WINDOW_MS = 72 * 60 * 60 * 1_000;

/**
 * Sorare labels the MLS/Liga MX tournament as `leagues-cup-mls`, while
 * The Odds API exposes the same fixtures through its CONCACAF Leagues Cup
 * feed. Keep this separate from the regular MLS feed so a Leagues Cup card
 * never consumes an MLS request that cannot contain its fixture.
 */
export const LEAGUES_CUP_COMPETITION_SLUGS = [
  'leagues-cup-mls',
] as const;

export const LEAGUES_CUP_THE_ODDS_API_ROUTES = [
  {
    sportKeys: ['soccer_concacaf_leagues_cup'],
    competitionSlugs: LEAGUES_CUP_COMPETITION_SLUGS,
    region: 'us',
    fallbackRegion: 'uk',
  },
] as const satisfies readonly MatchOddsRoute[];

export interface TheOddsApiPlayerRoute {
  sportKeys: readonly [string, ...string[]];
  competitionSlugs: readonly string[];
  region: string;
  fallbackRegion: string | null;
  markets: readonly PlayerMarketField[];
  fetchWindowMs: number;
}

export interface OddsApiIoRoute {
  competitionSlugs: readonly string[];
  leagueSlugs: readonly string[];
  playerMarkets?: readonly PlayerMarketField[];
  matchOdds?: boolean;
  playerFetchWindowMs?: number;
}

export interface SportsGameOddsRoute {
  competitionSlugs: readonly string[];
  leagueId: string;
  playerMarkets: readonly PlayerMarketField[];
  matchOdds: boolean;
  playerFetchWindowMs?: number;
  matchOddsFetchWindowMs?: number;
}

interface TheOddsApiCapability {
  sportKeys: readonly [string, ...string[]];
  region: string;
  fallbackRegion: string | null;
}

export interface CompetitionOddsCapability {
  competitionSlug: string;
  sportsGameOdds: {
    leagueId: string;
    playerMarkets: readonly PlayerMarketField[];
    matchOdds: boolean;
  } | null;
  theOddsApiMatch: TheOddsApiCapability | null;
  theOddsApiPlayer: TheOddsApiCapability | null;
  oddsApiIo: {
    leagueSlugs: readonly string[];
    playerMarkets: readonly PlayerMarketField[];
    matchOdds: boolean;
  };
}

/**
 * Market capabilities for the European competitions requested by the user.
 *
 * Match odds and player props deliberately have separate The Odds API routes:
 * European H-D-A comes from EU/UK books, while supported football player props
 * are exposed through US books. Odds-API.io supplies goalscorer markets for all
 * eight competitions, opportunistically keeps assists returned in the same
 * response, and provides the HNL match fallback where The Odds API has no feed.
 */
export const EUROPEAN_ODDS_CAPABILITIES = [
  {
    competitionSlug: 'premier-league-gb-eng',
    sportsGameOdds: {
      leagueId: 'EPL',
      playerMarkets: ['goal', 'assist'],
      matchOdds: true,
    },
    theOddsApiMatch: {
      sportKeys: ['soccer_epl'],
      region: 'eu',
      fallbackRegion: 'uk',
    },
    theOddsApiPlayer: {
      sportKeys: ['soccer_epl'],
      region: 'us',
      fallbackRegion: null,
    },
    oddsApiIo: {
      leagueSlugs: ['england-premier-league'],
      playerMarkets: ['goal'],
      matchOdds: false,
    },
  },
  {
    competitionSlug: 'laliga-es',
    sportsGameOdds: {
      leagueId: 'LA_LIGA',
      playerMarkets: ['goal', 'assist'],
      matchOdds: true,
    },
    theOddsApiMatch: {
      sportKeys: ['soccer_spain_la_liga'],
      region: 'eu',
      fallbackRegion: 'uk',
    },
    theOddsApiPlayer: {
      sportKeys: ['soccer_spain_la_liga'],
      region: 'us',
      fallbackRegion: null,
    },
    oddsApiIo: {
      leagueSlugs: ['spain-laliga'],
      playerMarkets: ['goal'],
      matchOdds: false,
    },
  },
  {
    competitionSlug: 'ligue-2-fr',
    sportsGameOdds: {
      leagueId: 'FR_LIGUE_2',
      // Goal markets are the conservative request driver for Ligue 2.
      // Assists are still captured opportunistically when returned in the
      // same event object, but their absence never causes another request.
      playerMarkets: ['goal'],
      matchOdds: true,
    },
    theOddsApiMatch: {
      sportKeys: ['soccer_france_ligue_two'],
      region: 'eu',
      fallbackRegion: 'uk',
    },
    theOddsApiPlayer: null,
    oddsApiIo: {
      leagueSlugs: ['france-ligue-2'],
      playerMarkets: ['goal'],
      matchOdds: false,
    },
  },
  {
    competitionSlug: 'ligue-1-fr',
    sportsGameOdds: {
      leagueId: 'FR_LIGUE_1',
      playerMarkets: ['goal', 'assist'],
      matchOdds: true,
    },
    theOddsApiMatch: {
      sportKeys: ['soccer_france_ligue_one'],
      region: 'eu',
      fallbackRegion: 'uk',
    },
    theOddsApiPlayer: {
      sportKeys: ['soccer_france_ligue_one'],
      region: 'us',
      fallbackRegion: null,
    },
    oddsApiIo: {
      leagueSlugs: ['france-ligue-1'],
      playerMarkets: ['goal'],
      matchOdds: false,
    },
  },
  {
    competitionSlug: 'bundesliga-de',
    sportsGameOdds: {
      leagueId: 'BUNDESLIGA',
      playerMarkets: ['goal', 'assist'],
      matchOdds: true,
    },
    theOddsApiMatch: {
      sportKeys: ['soccer_germany_bundesliga'],
      region: 'eu',
      fallbackRegion: 'uk',
    },
    theOddsApiPlayer: {
      sportKeys: ['soccer_germany_bundesliga'],
      region: 'us',
      fallbackRegion: null,
    },
    oddsApiIo: {
      leagueSlugs: ['germany-bundesliga'],
      playerMarkets: ['goal'],
      matchOdds: false,
    },
  },
  {
    competitionSlug: '2-bundesliga',
    sportsGameOdds: null,
    theOddsApiMatch: {
      sportKeys: ['soccer_germany_bundesliga2'],
      region: 'eu',
      fallbackRegion: 'uk',
    },
    theOddsApiPlayer: null,
    oddsApiIo: {
      leagueSlugs: ['germany-2-bundesliga'],
      playerMarkets: ['goal'],
      matchOdds: false,
    },
  },
  {
    competitionSlug: '1-hnl',
    sportsGameOdds: null,
    theOddsApiMatch: null,
    theOddsApiPlayer: null,
    oddsApiIo: {
      leagueSlugs: ['croatia-hnl'],
      playerMarkets: ['goal'],
      matchOdds: true,
    },
  },
  {
    competitionSlug: 'austrian-bundesliga',
    sportsGameOdds: null,
    theOddsApiMatch: {
      sportKeys: ['soccer_austria_bundesliga'],
      region: 'eu',
      fallbackRegion: 'uk',
    },
    theOddsApiPlayer: null,
    oddsApiIo: {
      leagueSlugs: ['austria-bundesliga'],
      playerMarkets: ['goal'],
      matchOdds: false,
    },
  },
] as const satisfies readonly CompetitionOddsCapability[];

export const EUROPEAN_COMPETITION_SLUGS = EUROPEAN_ODDS_CAPABILITIES.map(
  ({ competitionSlug }) => competitionSlug,
);

export const EUROPEAN_THE_ODDS_API_MATCH_ROUTES: readonly MatchOddsRoute[] =
  EUROPEAN_ODDS_CAPABILITIES.flatMap(
    ({ competitionSlug, theOddsApiMatch }) =>
      theOddsApiMatch
        ? [
            {
              sportKeys: theOddsApiMatch.sportKeys,
              competitionSlugs: [competitionSlug],
              region: theOddsApiMatch.region,
              ...(theOddsApiMatch.fallbackRegion
                ? { fallbackRegion: theOddsApiMatch.fallbackRegion }
                : {}),
            },
          ]
        : [],
  );

export const EUROPEAN_THE_ODDS_API_PLAYER_ROUTES: readonly TheOddsApiPlayerRoute[] =
  EUROPEAN_ODDS_CAPABILITIES.flatMap(
    ({ competitionSlug, theOddsApiPlayer }) =>
      theOddsApiPlayer
        ? [
            {
              sportKeys: theOddsApiPlayer.sportKeys,
              competitionSlugs: [competitionSlug],
              region: theOddsApiPlayer.region,
              fallbackRegion: theOddsApiPlayer.fallbackRegion,
              markets: ['goal', 'assist'],
              fetchWindowMs: THE_ODDS_API_PLAYER_FETCH_WINDOW_MS,
            },
          ]
        : [],
  );

const BASE_SPORTS_GAME_ODDS_ROUTES = [
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
] as const satisfies readonly SportsGameOddsRoute[];

/**
 * SportsGameOdds bills returned event objects rather than individual markets.
 * Align the new European H-D-A and player-prop windows so one event response
 * can populate both snapshots. Existing MLS/UEFA windows remain configurable.
 */
export const SPORTS_GAME_ODDS_ROUTES: readonly SportsGameOddsRoute[] = [
  ...BASE_SPORTS_GAME_ODDS_ROUTES,
  ...EUROPEAN_ODDS_CAPABILITIES.flatMap(
    ({ competitionSlug, sportsGameOdds }) =>
      sportsGameOdds
        ? [
            {
              competitionSlugs: [competitionSlug],
              leagueId: sportsGameOdds.leagueId,
              playerMarkets: sportsGameOdds.playerMarkets,
              matchOdds: sportsGameOdds.matchOdds,
              playerFetchWindowMs: EARLY_PLAYER_FETCH_WINDOW_MS,
              matchOddsFetchWindowMs: EARLY_PLAYER_FETCH_WINDOW_MS,
            },
          ]
        : [],
  ),
];

const BASE_ODDS_API_IO_ROUTES = [
  {
    competitionSlugs: ['mlspa'],
    leagueSlugs: ['usa-mls'],
  },
  {
    competitionSlugs: LEAGUES_CUP_COMPETITION_SLUGS,
    leagueSlugs: [
      'international-clubs-leagues-cup',
      'international-clubs-leagues-cup-group-stage',
    ],
  },
  {
    competitionSlugs: ['uefa-champions-league'],
    leagueSlugs: [
      'international-clubs-uefa-champions-league-playoff-round',
      'international-clubs-uefa-champions-league-qualification',
      'international-clubs-uefa-champions-league',
    ],
  },
  {
    competitionSlugs: ['uefa-europa-league'],
    leagueSlugs: [
      'international-clubs-uefa-europa-league-playoff-round',
      'international-clubs-uefa-europa-league-qualification',
      'international-clubs-uefa-europa-league',
    ],
  },
  {
    competitionSlugs: ['uefa-europa-conference-league'],
    leagueSlugs: [
      'international-clubs-uefa-conference-league-playoff-round',
      'international-clubs-uefa-conference-league-qualification',
      'international-clubs-uefa-conference-league',
    ],
    matchOdds: true,
  },
] as const satisfies readonly OddsApiIoRoute[];

/**
 * Odds-API.io is a goalscorer fallback for the existing pools and the direct
 * goalscorer source for European leagues without supported The Odds API props.
 * Assist and goals-or-assists selections are captured from the same response,
 * but never drive routing or a provider request of their own.
 */
export const ODDS_API_IO_ROUTES: readonly OddsApiIoRoute[] = [
  ...BASE_ODDS_API_IO_ROUTES,
  ...EUROPEAN_ODDS_CAPABILITIES.map(
    ({ competitionSlug, oddsApiIo }) => ({
      competitionSlugs: [competitionSlug],
      leagueSlugs: oddsApiIo.leagueSlugs,
      playerMarkets: oddsApiIo.playerMarkets,
      matchOdds: oddsApiIo.matchOdds,
      playerFetchWindowMs: EARLY_PLAYER_FETCH_WINDOW_MS,
    }),
  ),
];
