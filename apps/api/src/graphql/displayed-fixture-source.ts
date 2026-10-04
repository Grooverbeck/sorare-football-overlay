import {displayedMatchKey, type DisplayedMatch, type PlayerStats} from '@sorare-overlay/shared';
import * as z from 'zod';
import type {SorareGraphqlClient} from './client.js';
import type {DisplayedFixtureSource} from '../services/displayed-fixture.js';
import type {AaContextStore} from '../services/aa-context.js';

const TeamSchema=z.object({id:z.string(),slug:z.string(),shortName:z.string(),__typename:z.string().optional(),country:z.object({code:z.string().nullable()}).optional()});
const StatsSchema=z.object({cleanSheetOdds:z.number().nullable(),winOddsBasisPoints:z.number().nullable(),drawOddsBasisPoints:z.number().nullable(),loseOddsBasisPoints:z.number().nullable()});
const GameSchema=z.object({id:z.string(),date:z.string(),statusTyped:z.string(),homeGoals:z.number(),awayGoals:z.number(),competition:z.object({slug:z.string()}),homeTeam:TeamSchema,awayTeam:TeamSchema,homeStats:StatsSchema.nullable(),awayStats:StatsSchema.nullable()});
type Team=z.infer<typeof TeamSchema>;
const teamFields='__typename id slug shortName ... on NationalTeam { country { code } }';
const gameFields=`id date statusTyped homeGoals awayGoals competition { slug } homeTeam { ${teamFields} } awayTeam { ${teamFields} } homeStats { ... on FootballTeamGameStats { cleanSheetOdds winOddsBasisPoints drawOddsBasisPoints loseOddsBasisPoints } } awayStats { ... on FootballTeamGameStats { cleanSheetOdds winOddsBasisPoints drawOddsBasisPoints loseOddsBasisPoints } }`;
const matches=(reference:string,team:Team)=>reference.startsWith('country:')
  ? team.__typename==='NationalTeam' && team.country?.code?.toLowerCase()===reference.slice(8)
  : reference.startsWith('team:')?team.slug===reference.slice(5):reference===`id:${team.id}`;

export class SorareDisplayedFixtureSource implements DisplayedFixtureSource {
  constructor(private readonly client:Pick<SorareGraphqlClient,'request'>,private readonly now:()=>number=Date.now,private readonly store?:AaContextStore) {}
  async resolve(targets:Array<{slug:string;hint:DisplayedMatch}>) {
    const slugs=[...new Set(targets.map(t=>t.slug))];
    const memberships=z.object({players:z.array(z.object({__typename:z.string(),slug:z.string().optional(),activeClub:TeamSchema.nullable().optional(),activeNationalTeam:TeamSchema.nullable().optional()}))}).parse(
      await this.client.request<unknown,{slugs:string[]}>(`query DisplayedMemberships($slugs:[String!]) {players(slugs:$slugs) {__typename ... on Player {slug activeClub {__typename id slug shortName} activeNationalTeam {__typename id slug shortName country {code}}}}}`,{slugs}));
    const teamsByPlayer=new Map(memberships.players.flatMap(p=>p.slug?[[p.slug,[p.activeClub,p.activeNationalTeam].filter((t):t is Team=>Boolean(t))] as const]:[]));
    const teams=new Map<string,Team>();
    const countryTeamIds=new Set<string>();
    for(const target of targets)for(const team of teamsByPlayer.get(target.slug)??[]) {
      if(matches(target.hint.home,team)||matches(target.hint.away,team)) {
        teams.set(team.id,team);
        if([target.hint.home,target.hint.away].some(ref=>ref.startsWith('country:')&&matches(ref,team)))countryTeamIds.add(team.id);
      }
    }
    const catalogKey=(team:Team)=>`displayed-team-games:v2:${team.id}:${countryTeamIds.has(team.id)?'country':'slug'}`;
    const gamesByTeam=new Map<string,Array<z.infer<typeof GameSchema>>>();
    const all:Team[]=[];
    const catalogSchema=z.object({checkedAt:z.number(),games:z.array(GameSchema).max(12)});
    for(const team of teams.values()) {
      try {
        const cached=catalogSchema.safeParse(await this.store?.get(catalogKey(team),'json'));
        if(cached.success&&this.now()-cached.data.checkedAt<120_000) {gamesByTeam.set(team.id,cached.data.games);continue;}
      } catch { /* no verified cached catalog */ }
      all.push(team);
    }
    for(let offset=0;offset<all.length;offset+=8) {
      const batch=all.slice(offset,offset+8),vars:Record<string,string>={from:new Date(this.now()-21*86_400_000).toISOString(),to:new Date(this.now()+86_400_000).toISOString()};
      const declarations=['$from:ISO8601DateTime!','$to:ISO8601DateTime!'];
      const selections=batch.map((team,i)=>{
        const country=countryTeamIds.has(team.id);
        vars[`slug${i}`]=country?team.country!.code!:team.slug;declarations.push(`$slug${i}:String!`);
        return `t${i}:${team.__typename==='NationalTeam'?'nationalTeam':'club'}(${country?'countryCode':'slug'}:$slug${i}) {id games(first:12,startDate:$from,endDate:$to) {pageInfo {hasNextPage} nodes {${gameFields}}}}`;
      });
      const raw=z.object({football:z.record(z.string(),z.unknown())}).parse(await this.client.request<unknown,Record<string,string>>(`query DisplayedGames(${declarations.join(',')}) {football {${selections.join(' ')}}}`,vars));
      await Promise.all(batch.map(async(team,i)=>{
        const parsed=z.object({id:z.string(),games:z.object({pageInfo:z.object({hasNextPage:z.boolean()}),nodes:z.array(GameSchema).max(12)})}).safeParse(raw.football[`t${i}`]);
        // A country flag cannot identify a youth/women's team. Sorare's own
        // country lookup must resolve to the player's exact membership ID.
        if(parsed.success&&parsed.data.id!==team.id) {gamesByTeam.set(team.id,[]);return;}
        if(parsed.success&&!parsed.data.games.pageInfo.hasNextPage) {
          gamesByTeam.set(team.id,parsed.data.games.nodes);
          try {await this.store?.put(catalogKey(team),JSON.stringify({checkedAt:this.now(),games:parsed.data.games.nodes}),{expirationTtl:120});} catch { /* keep verified response despite cache failure */ }
        }
      }));
    }
    const output=new Map<string,PlayerStats['nextGame']>();
    for(const {slug,hint} of targets) {
      const memberships=teamsByPlayer.get(slug)??[];
      const eligible=memberships.filter(t=>matches(hint.home,t)||matches(hint.away,t));
      if(!eligible.length) {output.set(slug+':'+displayedMatchKey(hint),null);continue;}
      if(eligible.some(t=>!gamesByTeam.has(t.id)))continue;
      const games=new Map(eligible.flatMap(t=>(gamesByTeam.get(t.id)??[]).map(g=>[g.id,g] as const)));
      // A 0-0 placeholder before kickoff is not proof of a completed match.
      // When another fixture for the same pair is active/upcoming, an explicit
      // previously confirmed game ID is required for a historical score hint.
      if(hint.phase==='played'&&!hint.gameId&&[...games.values()].some(g=>
        matches(hint.home,g.homeTeam)&&matches(hint.away,g.awayTeam)&&['playing','scheduled'].includes(g.statusTyped))) {
        output.set(slug+':'+displayedMatchKey(hint),null);continue;
      }
      const candidates=[...games.values()].filter(g=>matches(hint.home,g.homeTeam)&&matches(hint.away,g.awayTeam)&&
        Number.isFinite(Date.parse(g.date))&&Date.parse(g.date)>=this.now()-21*86_400_000&&Date.parse(g.date)<=this.now()+86_400_000&&
        (!hint.gameId||g.id===hint.gameId)&&
        (hint.gameId?['playing','played'].includes(g.statusTyped):hint.phase==='live'
          ? g.statusTyped==='playing'||(g.statusTyped==='played'&&Date.parse(g.date)<=this.now()&&Date.parse(g.date)>=this.now()-3*3_600_000&&g.homeGoals===hint.homeScore&&g.awayGoals===hint.awayScore)
          : g.statusTyped==='played'&&g.homeGoals===hint.homeScore&&g.awayGoals===hint.awayScore));
      // Sorare's score footer can retain its live marker briefly after the API
      // reports full time. Accept only a recent, uniquely matched final score;
      // an old live-looking footer must never select a historic same-team game.
      if(candidates.length!==1) {output.set(slug+':'+displayedMatchKey(hint),null);continue;}
      const game=candidates[0]!;
      const home=memberships.some(t=>t.id===game.homeTeam.id),away=memberships.some(t=>t.id===game.awayTeam.id);
      if(home===away) {output.set(slug+':'+displayedMatchKey(hint),null);continue;}
      const team=home?game.homeTeam:game.awayTeam,opponent=home?game.awayTeam:game.homeTeam,stats=home?game.homeStats:game.awayStats;
      const probability=(value:number|null|undefined)=>value!=null&&value>=0&&value<=10_000?value/10_000:null;
      output.set(slug+':'+displayedMatchKey(hint),{gameId:game.id,date:game.date,competitionSlug:game.competition.slug,
        homeTeamSlug:game.homeTeam.slug,awayTeamSlug:game.awayTeam.slug,homeTeamName:game.homeTeam.shortName,awayTeamName:game.awayTeam.shortName,
        playerTeamSlug:team.slug,playerTeamName:team.shortName,opponentTeamName:opponent.shortName,
        cleanSheetProbability:stats?.cleanSheetOdds&&stats.cleanSheetOdds>1?1/stats.cleanSheetOdds:null,
        matchProbabilities:stats?{win:probability(stats.winOddsBasisPoints),draw:probability(stats.drawOddsBasisPoints),loss:probability(stats.loseOddsBasisPoints)}:null,
        marketOdds:null});
    }
    return output;
  }
}
