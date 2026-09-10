import { fixtureStatusKey } from '@sorare-overlay/shared';
import * as z from 'zod';
import type { SorareGraphqlClient } from './client.js';
import { GameStateSchema, type Fixture, type FixtureStatusSource } from '../services/fixture-lifecycle.js';

const GameSchema=z.object({id:z.string(),date:z.string(),statusTyped:GameStateSchema,homeTeam:z.object({slug:z.string()}).nullable(),awayTeam:z.object({slug:z.string()}).nullable()});
const fields='id date statusTyped homeTeam { slug } awayTeam { slug }';
const lookupGameId=(id:string)=>id.replace(/^Game:/,'');

export class SorareFixtureStatusSource implements FixtureStatusSource {
  constructor(private readonly client: Pick<SorareGraphqlClient,'request'>) {}
  async load(fixtures: readonly Fixture[]) {
    const batch=fixtures.slice(0,10);
    const declarations:string[]=[];
    const selections:string[]=[];
    const variables:Record<string,string>={};
    batch.forEach((f,i)=>{
      if(f.gameId) {
        declarations.push(`$id${i}: ID!`);variables[`id${i}`]=lookupGameId(f.gameId);
        selections.push(`f${i}: game(id:$id${i}) { ${fields} }`);
      } else {
        // Legacy fixtures: bounded lookup through the server-confirmed home
        // club, exact kickoff and both canonical team slugs checked below.
        declarations.push(`$club${i}: String!`, `$from${i}: ISO8601DateTime!`, `$to${i}: ISO8601DateTime!`);
        variables[`club${i}`]=f.homeTeamSlug!;
        variables[`from${i}`]=new Date(Date.parse(f.date)-60_000).toISOString();
        variables[`to${i}`]=new Date(Date.parse(f.date)+60_000).toISOString();
        selections.push(`f${i}: club(slug:$club${i}) { games(first:5,startDate:$from${i},endDate:$to${i}) { nodes { ${fields} } } }`);
      }
    });
    if(!batch.length) return new Map();
    const raw=await this.client.request<unknown,Record<string,string>>(`query FixtureStatuses(${declarations.join(',')}) { football { ${selections.join(' ')} } }`,variables);
    const envelope=z.object({football:z.record(z.string(),z.unknown())}).parse(raw);
    const results=new Map<string,{status:z.infer<typeof GameStateSchema>;gameId:string}>();
    batch.forEach((f,i)=>{
      const value=envelope.football[`f${i}`];
      const values=f.gameId?[value]:z.object({games:z.object({nodes:z.array(z.unknown()).max(5)})}).safeParse(value).data?.games.nodes ?? [];
      const matches=values.flatMap(value=>{
        const game=GameSchema.safeParse(value);
        if(!game.success) return [];
        const g=game.data;
        return Date.parse(g.date)===Date.parse(f.date) && g.homeTeam?.slug===f.homeTeamSlug && g.awayTeam?.slug===f.awayTeamSlug && (!f.gameId || lookupGameId(g.id)===lookupGameId(f.gameId)) ? [g] : [];
      });
      if(matches.length===1) results.set(fixtureStatusKey(f)!,{status:matches[0]!.statusTyped,gameId:matches[0]!.id});
    });
    return results;
  }
}
