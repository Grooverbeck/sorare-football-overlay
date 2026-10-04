import {it,expect,vi} from 'vitest';
import {PlayerStatsRequestSchema,displayedMatchKey,type PlayerStats} from '@sorare-overlay/shared';
import {SorareDisplayedFixtureSource} from '../graphql/displayed-fixture-source.js';
import {DisplayedFixtureService} from '../services/displayed-fixture.js';
import {InMemoryAaContextStore} from '../services/aa-context.js';
import {StatsService} from '../services/stats-service.js';
import {HistoricalGoalscorerProvider} from '../providers/goalscorer-provider.js';
import {TtlCache} from '../cache.js';
import {MockDataSource} from '../mock/mock-data-source.js';
import {playerMarketOddsKey,type PlayerMarketOddsProvider} from '../providers/market-odds-provider.js';

const clock=Date.parse('2026-10-04T19:00:00Z');
const hint={home:'country:gr',away:'country:de',phase:'live' as const,homeScore:0,awayScore:1};
const germany={id:'NationalTeam:de',slug:'germany',shortName:'Germany',__typename:'NationalTeam',country:{code:'DE'}};
const greece={id:'NationalTeam:gr',slug:'greece',shortName:'Greece',__typename:'NationalTeam',country:{code:'GR'}};
const stats={cleanSheetOdds:3,winOddsBasisPoints:5200,drawOddsBasisPoints:2500,loseOddsBasisPoints:2300};
const game={id:'Game:00000000-0000-0000-0000-000000000001',date:'2026-10-04T18:45:00Z',statusTyped:'playing',homeGoals:0,awayGoals:1,competition:{slug:'uefa-nations-league'},homeTeam:greece,awayTeam:germany,homeStats:stats,awayStats:stats};
function source(games=[game]) {
  const request=vi.fn(async(query:string)=>query.includes('DisplayedMemberships')
    ? {players:[{__typename:'Player',slug:'lennart-karl',activeClub:null,activeNationalTeam:germany}]}
    : {football:{t0:{id:germany.id,games:{nodes:games,pageInfo:{hasNextPage:false}}}}});
  return {source:new SorareDisplayedFixtureSource({request},()=>clock),request};
}
it('confirms official membership, exact opponents and current game independently of nextGame',async()=>{
  const {source:s,request}=source();const result=await s.resolve([{slug:'lennart-karl',hint}]);
  expect(result.get('lennart-karl:'+displayedMatchKey(hint))).toMatchObject({gameId:game.id,playerTeamSlug:'germany',competitionSlug:'uefa-nations-league'});
  expect(request).toHaveBeenCalledTimes(2);
});
it('rejects conflicting opponents, unconfirmed membership and ambiguous games',async()=>{
  for(const games of [[{...game,awayTeam:{...germany,slug:'france',country:{code:'FR'}}}],[game,{...game,id:'Game:other'}]]) {
    expect((await source(games).source.resolve([{slug:'lennart-karl',hint}])).get('lennart-karl:'+displayedMatchKey(hint))).toBeNull();
  }
  const altered={...hint,away:'country:fr'};expect((await source().source.resolve([{slug:'lennart-karl',hint:altered}])).get('lennart-karl:'+displayedMatchKey(altered))).toBeNull();
});
it('matches completed games by the displayed score rather than silently using another match',async()=>{
  const completed={...hint,phase:'played' as const};
  expect((await source([{...game,statusTyped:'played'}]).source.resolve([{slug:'lennart-karl',hint:completed}])).get('lennart-karl:'+displayedMatchKey(completed))).toMatchObject({gameId:game.id});
  expect((await source([{...game,statusTyped:'played',awayGoals:3}]).source.resolve([{slug:'lennart-karl',hint:completed}])).get('lennart-karl:'+displayedMatchKey(completed))).toBeNull();
});
it('projects cached market quotes for the confirmed match without warming providers or changing the general stats cache',async()=>{
  const cache=new TtlCache<PlayerStats>(60000),base:PlayerStats={slug:'lennart-karl',displayName:'Lennart Karl',position:'Midfielder',aaL10:{value:6.4,sampleSize:10},goalL10:{value:0.2,sampleSize:10},cleanSheetL10:{value:0,sampleSize:0},excludedLowCoverage:0,nextGame:{date:'2026-10-10T13:30:00Z',playerTeamSlug:'bayern',homeTeamName:'Augsburg',awayTeamName:'Bayern',cleanSheetProbability:null,matchProbabilities:null}};
  await cache.set('lennart-karl:Midfielder:no-low',base);
  const contextSource=source().source;const projection=new DisplayedFixtureService(new InMemoryAaContextStore(),contextSource);
  const provider:PlayerMarketOddsProvider={load:vi.fn(async(players,options)=>{
    expect(options?.cacheOnly).toBe(true);return new Map(players.map(p=>[playerMarketOddsKey(p),p.nextGame?.playerTeamSlug==='germany'?{source:'odds-api-io' as const,capturedAt:'2026-10-04T18:30:00Z',goal:{probability:0.30,bookmakerCount:2},assist:{probability:0.20,bookmakerCount:1}}:null]));
  })};
  const service=new StatsService(new MockDataSource(),new HistoricalGoalscorerProvider(),cache,true,provider,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,projection);
  const result=await service.getPlayerStats(PlayerStatsRequestSchema.parse({slugs:['lennart-karl'],positions:{'lennart-karl':'Midfielder'},displayedMatches:{'lennart-karl':hint}}));
  expect(result.data[0]?.nextGame?.marketOdds).toMatchObject({goal:{probability:0.3},assist:{probability:0.2}});
  expect((await cache.get('lennart-karl:Midfielder:no-low'))?.nextGame?.playerTeamSlug).toBe('bayern');
});

it('does not mistake a youth membership for the senior team represented by the country flag',async()=>{
  const youth={...germany,id:'NationalTeam:youth',slug:'germany-under-21'};
  const request=vi.fn(async(query:string)=>query.includes('DisplayedMemberships')
    ? {players:[{__typename:'Player',slug:'lennart-karl',activeClub:null,activeNationalTeam:youth}]}
    : {football:{t0:{id:germany.id,games:{nodes:[game],pageInfo:{hasNextPage:false}}}}});
  const s=new SorareDisplayedFixtureSource({request},()=>clock);
  expect((await s.resolve([{slug:'lennart-karl',hint}])).get('lennart-karl:'+displayedMatchKey(hint))).toBeNull();
});
it('keeps the last confirmed game during source failure and expires display records after one day',async()=>{
  let now=clock;const store=new InMemoryAaContextStore(()=>now),s=source().source;
  const projection=new DisplayedFixtureService(store,s,undefined,()=>now);
  const base:PlayerStats={slug:'lennart-karl',displayName:'Lennart Karl',position:'Midfielder',aaL10:{value:6.4,sampleSize:10},goalL10:{value:0.2,sampleSize:10},cleanSheetL10:{value:0,sampleSize:0},excludedLowCoverage:0,nextGame:null};
  const hints=new Map([['lennart-karl:Midfielder',hint]]);
  expect((await projection.decorate([base],hints))[0]?.nextGame?.gameId).toBe(game.id);
  now+=6*60_000;vi.spyOn(s,'resolve').mockRejectedValue(new Error('temporary outage'));
  expect((await projection.decorate([base],hints))[0]?.nextGame?.gameId).toBe(game.id);
  now+=25*3_600_000;
  expect((await projection.decorate([base],hints))[0]?.displayedFixture?.state).toBe('loading');
});
it('reuses one verified team catalog across requests without removing official per-player membership checks',async()=>{
  const store=new InMemoryAaContextStore(),mock=source();const s=new SorareDisplayedFixtureSource({request:mock.request},()=>clock,store);
  await s.resolve([{slug:'lennart-karl',hint}]);await s.resolve([{slug:'lennart-karl',hint}]);
  expect(mock.request).toHaveBeenCalledTimes(3);
});
