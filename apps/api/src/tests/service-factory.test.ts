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

  it('uses The Odds API only for Nations League assists and leaves SGO unsupported', () => {
    const stats=player('uefa-nations-league');
    for(const keys of [{THE_ODDS_API_KEY:'test-key'},{SPORTS_GAME_ODDS_API_KEY:'test-key'}]) {
      const runtime=createStatsRuntime({config:loadConfig({MOCK_MODE:'false',...keys}),logger,statsCache:new TtlCache<PlayerStats>(60000)});
      expect(playerMarketFieldSupported(runtime.marketOddsProvider,stats,'goal')).toBe(false);
      expect(playerMarketFieldSupported(runtime.marketOddsProvider,stats,'assist')).toBe('THE_ODDS_API_KEY' in keys);
      expect(runtime.fixtureMatchOddsProvider.supports(stats)).toBe('THE_ODDS_API_KEY' in keys);
    }
    const runtime=createStatsRuntime({config:loadConfig({MOCK_MODE:'false',ODDS_API_IO_KEY:'test-key'}),logger,statsCache:new TtlCache<PlayerStats>(60000)});
    expect(playerMarketFieldSupported(runtime.marketOddsProvider,stats,'goal')).toBe(true);
    expect(playerMarketFieldSupported(runtime.marketOddsProvider,stats,'assist')).toBe(true);
    expect(playerMarketFieldDrivesRequest(runtime.marketOddsProvider,stats,'goal')).toBe(true);
    expect(playerMarketFieldDrivesRequest(runtime.marketOddsProvider,stats,'assist')).toBe(false);
    const combined=createStatsRuntime({config:loadConfig({MOCK_MODE:'false',THE_ODDS_API_KEY:'test-key',ODDS_API_IO_KEY:'test-key'}),logger,statsCache:new TtlCache<PlayerStats>(60000)});
    expect(playerMarketFieldDrivesRequest(combined.marketOddsProvider,stats,'goal')).toBe(true);
    expect(playerMarketFieldDrivesRequest(combined.marketOddsProvider,stats,'assist')).toBe(true);
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

  it.each([false,true])('uses the paid Nations League assist only if Odds-API.io has none (IO assist: %s)', async (ioHasAssist) => {
    const date=new Date(Date.now()+30*60*60*1_000).toISOString();
    const nextGame={...player('uefa-nations-league').nextGame!,date,
      homeTeamName:'Spain',awayTeamName:'Croatia',playerTeamName:'Spain',opponentTeamName:'Croatia'};
    const yamal={...player('uefa-nations-league'),slug:'lamine-yamal-nasraoui-ebana',displayName:'Lamine Yamal',position:'Forward' as const,nextGame};
    const laporte={...player('uefa-nations-league'),slug:'aymeric-laporte',displayName:'Aymeric Laporte',position:'Defender' as const,nextGame};
    const ioEvent={id:'io-spain-croatia',date,home:'Spain',away:'Croatia',sport:{slug:'football'},
      league:{slug:'international-uefa-nations-league-league-c-gr-2'}};
    const fetchSpy=vi.spyOn(globalThis,'fetch').mockImplementation(async input=>{
      const url=new URL(String(input));
      if(url.hostname==='api.odds-api.io') {
        if(url.pathname.endsWith('/events/search')) return Response.json([ioEvent]);
        expect(url.pathname).toBe('/v3/odds/multi');
        return Response.json([{...ioEvent,bookmakers:{Bet365:[
          {name:'Anytime Goalscorer',odds:[{label:'Lamine Yamal',over:'2.5'},{label:'Aymeric Laporte',over:'11'}]},
          ...(ioHasAssist?[{name:'Player To Assist',odds:[{label:'Lamine Yamal',over:'4'},{label:'Aymeric Laporte',over:'10'}]}]:[]),
        ]}}]);
      }
      expect(url.hostname).toBe('api.the-odds-api.com');
      if(url.pathname.endsWith('/events')) return Response.json([{
        id:'odds-spain-croatia',commence_time:date,home_team:'Spain',away_team:'Croatia',
      }]);
      expect(url.searchParams.get('markets')).toBe('player_assists_alternate');
      expect(url.searchParams.get('regions')).toBe('us');
      return Response.json({id:'odds-spain-croatia',commence_time:date,home_team:'Spain',away_team:'Croatia',
        bookmakers:[{key:'betrivers',title:'BetRivers',markets:[{key:'player_assists_alternate',outcomes:[
          {name:'Over',description:'Lamine Yamal',point:0.5,price:2.4},
          {name:'Over',description:'Aymeric Laporte',point:0.5,price:10},
        ]}]}]});
    });
    try {
      const runtime=createStatsRuntime({config:loadConfig({MOCK_MODE:'false',THE_ODDS_API_KEY:'test-key',
        SPORTS_GAME_ODDS_API_KEY:'test-key',ODDS_API_IO_KEY:'test-key'}),logger,statsCache:new TtlCache<PlayerStats>(60000)});
      const values=await runtime.marketOddsProvider.load([yamal,laporte]);
      expect(values.get(playerMarketOddsKey(yamal))?.goal?.probability).toBeCloseTo(0.4);
      expect(values.get(playerMarketOddsKey(yamal))?.assist?.probability).toBeCloseTo(ioHasAssist?0.25:1/2.4);
      expect(values.get(playerMarketOddsKey(laporte))?.assist?.probability).toBeCloseTo(0.1);
      expect(fetchSpy).toHaveBeenCalledTimes(ioHasAssist?2:4);
      const cached=await runtime.marketOddsProvider.load([yamal,laporte],{cacheOnly:true});
      expect(cached.get(playerMarketOddsKey(yamal))?.assist?.probability).toBeCloseTo(ioHasAssist?0.25:1/2.4);
      expect(fetchSpy).toHaveBeenCalledTimes(ioHasAssist?2:4);
    } finally {fetchSpy.mockRestore();}
  });
});
