import {expect,it,vi} from 'vitest';
import {SorareDataSource} from '../graphql/sorare-data-source.js';
import {SorareGraphqlClient} from '../graphql/client.js';
import {sameSorareGame,sameFixtureIdentity} from '../services/fixture-identity.js';
const fixture={gameId:'Game:07af3ee4-ada0-48a1-9021-8969ae54ef32',date:'2026-10-10T00:00:00Z',homeTeamSlug:'slaven',awayTeamSlug:'rijeka',playerTeamSlug:'rijeka',cleanSheetProbability:null,matchProbabilities:null};
it('separates stable Sorare game identity from date-scoped bookmaker snapshot identity',()=>{
  const later={...fixture,date:'2026-10-11T16:00:00Z'};expect(sameSorareGame(fixture,later)).toBe(true);expect(sameFixtureIdentity(fixture,later)).toBe(false);
  for(const changed of [{...later,gameId:'other'},{...later,awayTeamSlug:'other'},{...later,playerTeamSlug:'other'},{...later,homeTeamSlug:undefined}])expect(sameSorareGame(fixture,changed)).toBe(false);
});
it.each(['fetchNextGames','fetchPlayersBase'] as const)('captures source freshness before %s begins rather than when the delayed response arrives',async method=>{
  const start=Date.parse('2026-10-09T12:00:00Z'),clock=vi.spyOn(Date,'now').mockReturnValue(start);
  const row={__typename:'Player',slug:'igor-vekic',displayName:'Igor Vekić',position:'Goalkeeper',cardPositions:['Goalkeeper'],anyPositions:['Goalkeeper'],playerGameScores:[],activeClub:{id:'club:rijeka',slug:'rijeka'},activeNationalTeam:null,
    nextGame:{__typename:'Game',id:fixture.gameId,date:'2026-10-11T16:00:00Z',competition:{slug:'1-hnl'},homeTeam:{id:'club:slaven',slug:'slaven',shortName:'Slaven'},awayTeam:{id:'club:rijeka',slug:'rijeka',shortName:'Rijeka'},homeStats:null,awayStats:{__typename:'FootballTeamGameStats',cleanSheetOdds:2.25,winOddsBasisPoints:5600,drawOddsBasisPoints:2500,loseOddsBasisPoints:1900}}};
  const client=new SorareGraphqlClient({url:'https://api.sorare.com/graphql',requestTimeoutMs:1000,maxRetries:0,logger:{debug(){},info(){},warn(){},error(){}},fetchImpl:async()=>{clock.mockReturnValue(start+5000);return Response.json({data:{players:[row]}});}});
  try {const [result]=await new SorareDataSource(client,25)[method]([{slug:'igor-vekic',position:'Goalkeeper'}]);expect(result?.nextGame).toMatchObject({gameId:fixture.gameId,date:row.nextGame.date,sorareObservedAt:start,cleanSheetProbability:1/2.25});}
  finally {clock.mockRestore();}
});
