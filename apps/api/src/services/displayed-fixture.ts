import {displayedMatchKey, PlayerStatsSchema, type DisplayedMatch, type PlayerStats} from '@sorare-overlay/shared';
import * as z from 'zod';
import type {AaContextStore} from './aa-context.js';
import {mapSettledWithConcurrency} from './concurrency.js';
import type {AppLogger} from '../logger.js';

export interface DisplayedFixtureSource {
  resolve(targets: Array<{slug:string;hint:DisplayedMatch}>): Promise<Map<string, PlayerStats['nextGame']>>;
}
const RecordSchema = z.object({fixture:PlayerStatsSchema.shape.nextGame,checkedAt:z.number()});
const RETENTION_SECONDS=24*60*60;

// This is a response-only projection. It must never write club form, global
// next-game keys or unverified client fixture identities into provider caches.
export class DisplayedFixtureService {
  constructor(private readonly store:AaContextStore,private readonly source:DisplayedFixtureSource,
    private readonly schedule?: (task:Promise<void>)=>void,private readonly now:()=>number=Date.now,
    private readonly logger?:Pick<AppLogger,'warn'>) {}

  async decorate(players:PlayerStats[],hints:ReadonlyMap<string,DisplayedMatch>):Promise<PlayerStats[]> {
    const targets=new Map(players.flatMap(p=>{
      const hint=hints.get(`${p.slug}:${p.position}`);return hint?[[this.key(p.slug,hint),{slug:p.slug,hint}] as const]:[];
    }));
    const fixtures=new Map<string,PlayerStats['nextGame']>();
    const cold:Array<[string,{slug:string;hint:DisplayedMatch}]>=[];
    let stored=new Map<string,unknown>();
    try {
      const keys=[...targets.keys()];
      stored=this.store.getMany?await this.store.getMany<unknown>(keys,'json')
        :new Map(await Promise.all(keys.map(async key=>[key,await this.store.get(key,'json')] as const)));
    } catch { /* storage unavailable; validate through the source */ }
    for(const [key,target] of targets) {
      try {
        const raw=RecordSchema.safeParse(stored.get(key));
        if(raw.success && this.now()-raw.data.checkedAt<(raw.data.fixture?5*60_000:30_000)) {
          fixtures.set(key,raw.data.fixture);continue;
        }
        if(raw.success&&raw.data.fixture)fixtures.set(key,raw.data.fixture);
      } catch { /* storage outage: bounded source retry, no cross-context fallback */ }
      cold.push([key,target]);
    }
    if(cold.length) {
      const work=this.refresh(cold.slice(0,16),fixtures).catch(()=>{
        this.logger?.warn({event:'displayed_fixture_refresh_failed'},'Keeping confirmed displayed match after a context lookup failed');
      });
      if(this.schedule) {
        this.schedule(work);
        let timer:ReturnType<typeof setTimeout>|undefined;
        try {await Promise.race([work,new Promise<void>(resolve=>{timer=setTimeout(resolve,300);})]);}
        finally {if(timer)clearTimeout(timer);}
      } else await work;
    }
    return players.map(p=>{
      const hint=hints.get(`${p.slug}:${p.position}`);if(!hint)return p;
      const recordKey=this.key(p.slug,hint),known=fixtures.has(recordKey),fixture=fixtures.get(recordKey)??null;
      const pending=new Set(p.pendingRefreshes??[]);pending.delete('fixture');pending.delete('marketOdds');
      if(!known)pending.add('fixture');
      return {...p,nextGame:fixture,fixtureRefresh:known&&!fixture&&hint.phase==='live'
        ? {key:`displayed-match-check:${encodeURIComponent(displayedMatchKey(hint))}`,nextCheckAt:new Date(this.now()+60_000).toISOString()}:undefined,marketRefresh:undefined,
        displayedFixture:{key:displayedMatchKey(hint),state:!known?'loading':fixture?'confirmed':'unavailable',...(fixture?.gameId?{gameId:fixture.gameId}:{})},
        pendingRefreshes:pending.size?[...pending]:undefined};
    });
  }
  private key(slug:string,hint:DisplayedMatch):string {
    return `displayed-fixture:v1:${slug}:${encodeURIComponent(displayedMatchKey(hint))}:${hint.gameId??'auto'}`;
  }
  private async refresh(targets:Array<[string,{slug:string;hint:DisplayedMatch}]>,fixtures:Map<string,PlayerStats['nextGame']>):Promise<void> {
    const claimed=await mapSettledWithConcurrency(targets,4,async entry=>
      await this.store.putIfAbsent(`${entry[0]}:lease`,'{}',{expirationTtl:30})?entry:null);
    const entries=claimed.flatMap(r=>r.status==='fulfilled'&&r.value?[r.value]:[]);
    if(!entries.length)return;
    const resolved=await this.source.resolve(entries.map(([key,target])=>({slug:target.slug,hint:
      fixtures.get(key)?.gameId?{...target.hint,gameId:fixtures.get(key)!.gameId}:target.hint})));
    await Promise.all(entries.map(async([key,target])=>{
      const fixture=resolved.get(target.slug+':'+displayedMatchKey(target.hint));
      if(fixture===undefined)return; // failure is not an authoritative absence
      if(fixture===null&&fixtures.get(key))return; // transient scope changes cannot erase a confirmed game
      await this.store.put(key,JSON.stringify({fixture,checkedAt:this.now()}),{expirationTtl:RETENTION_SECONDS});
      fixtures.set(key,fixture);
    }));
  }
}
