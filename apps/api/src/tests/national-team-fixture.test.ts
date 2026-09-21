import {describe,expect,it,vi} from 'vitest';
import {SorareGraphqlClient} from '../graphql/client.js';
import {SorareDataSource} from '../graphql/sorare-data-source.js';
import {PLAYER_NEXT_GAMES_QUERY,PLAYER_STATS_BATCH_QUERY} from '../graphql/player-stats.query.js';

function player() {
  return {__typename:'Player',slug:'international-keeper',displayName:'Keeper',position:'Goalkeeper',cardPositions:['Goalkeeper'],anyPositions:['Goalkeeper'],
    activeClub:{id:'Club:one',slug:'club-one'},activeNationalTeam:{id:'NationalTeam:norway',slug:'norway'},playerGameScores:[],
    nextGame:{__typename:'Game',id:'Game:test',date:'2032-09-24T18:45:00Z',competition:{slug:'uefa-nations-league'},
      homeTeam:{id:'NationalTeam:norway',slug:'norway',shortName:'Norway'},awayTeam:{id:'NationalTeam:denmark',slug:'denmark',shortName:'Denmark'},
      homeStats:{__typename:'FootballTeamGameStats',cleanSheetOdds:2.62,winOddsBasisPoints:5300,drawOddsBasisPoints:2400,loseOddsBasisPoints:2300},
      awayStats:{__typename:'FootballTeamGameStats',cleanSheetOdds:5.5,winOddsBasisPoints:2300,drawOddsBasisPoints:2400,loseOddsBasisPoints:5300},
    }};
}
function source(row:ReturnType<typeof player>) {
  const fetchImpl=vi.fn<typeof fetch>(async()=>Response.json({data:{players:[row]}}));
  const client=new SorareGraphqlClient({url:'https://api.sorare.com/graphql',requestTimeoutMs:1000,maxRetries:0,fetchImpl,logger:{debug(){},info(){},warn(){},error(){}}});
  return {api:new SorareDataSource(client,25),fetchImpl};
}
describe('official national-team fixture identity',()=>{
  it.each(['cold','fixture'])('uses national membership on the %s path while preserving activeClub for AA',async path=>{
    const row=player();const {api}=source(row);
    const [result]=path==='cold'?await api.fetchPlayers([{slug:row.slug,position:'Goalkeeper'}]):await api.fetchNextGames([{slug:row.slug}]);
    expect(result?.nextGame).toMatchObject({playerTeamSlug:'norway',playerTeamName:'Norway',opponentTeamName:'Denmark',matchProbabilities:{win:0.53,draw:0.24,loss:0.23}});
    expect(result?.nextGame?.cleanSheetProbability).toBeCloseTo(1/2.62);
    if(result && 'activeClubId' in result)expect(result.activeClubId).toBe('Club:one');
  });
  it('orients away-team odds and CS independently instead of copying the home side',async()=>{
    const row=player();row.activeNationalTeam={id:'NationalTeam:denmark',slug:'denmark'};
    const [result]=await source(row).api.fetchNextGames([{slug:row.slug}]);
    expect(result?.nextGame).toMatchObject({playerTeamSlug:'denmark',matchProbabilities:{win:0.23,draw:0.24,loss:0.53}});
    expect(result?.nextGame?.cleanSheetProbability).toBeCloseTo(1/5.5);
  });
  it('does not let a stale club or opponent hint override confirmed national membership',async()=>{
    const row=player();const [result]=await source(row).api.fetchNextGames([{slug:row.slug,teamSlug:'denmark',resolvedFromName:'Keeper',nameResolution:'search'}]);
    expect(result?.nextGame?.playerTeamSlug).toBe('norway');
  });
  it('still uses the club for a club fixture even when a national membership exists',async()=>{
    const row=player();row.nextGame.homeTeam={id:'Club:one',slug:'club-one',shortName:'Club One'};row.nextGame.awayTeam={id:'Club:two',slug:'club-two',shortName:'Club Two'};
    const [result]=await source(row).api.fetchNextGames([{slug:row.slug}]);
    expect(result?.nextGame?.playerTeamSlug).toBe('club-one');
  });
  it('does not guess a national team that is not part of the fixture',async()=>{
    const row=player();row.activeNationalTeam={id:'NationalTeam:other',slug:'other'};
    const [result]=await source(row).api.fetchNextGames([{slug:row.slug,teamSlug:'norway'}]);
    expect(result?.nextGame).toMatchObject({playerTeamName:null,cleanSheetProbability:null,matchProbabilities:null});
  });
  it('requests only two extra identity fields in the existing Sorare batches',()=>{
    for(const query of [PLAYER_STATS_BATCH_QUERY,PLAYER_NEXT_GAMES_QUERY]) expect(query).toMatch(/activeNationalTeam\s*\{\s*id\s*slug\s*\}/);
  });
});
