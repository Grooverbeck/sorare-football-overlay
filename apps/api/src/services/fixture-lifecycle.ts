import { FIXTURE_STATUS_START_MS, FIXTURE_STATUS_INTERVAL_MS, fixtureStatusKey, fixtureRolloverAtMs, type PlayerStats } from '@sorare-overlay/shared';
import * as z from 'zod';
import type { AppLogger } from '../logger.js';
export interface FixtureLifecycleStore {
  get<T>(key:string,type:'json'): Promise<T|null>;
  getMany?<T>(keys:readonly string[],type:'json'):Promise<Map<string,T>>;
  put(key:string,value:string,options:{expirationTtl:number}):Promise<void>;
  putIfAbsent?(key:string,value:string,options:{expirationTtl:number}):Promise<boolean>;
}

export type Fixture = NonNullable<PlayerStats['nextGame']>;
export const GameStateSchema = z.enum(['scheduled','playing','played','suspended','cancelled','postponed']);
export type GameState = z.infer<typeof GameStateSchema>;
const RecordSchema = z.object({status:z.union([GameStateSchema,z.literal('checking'),z.literal('unavailable')]), checkedAt:z.number(), nextCheckAt:z.number(), gameId:z.string().optional(),previousStatus:GameStateSchema.optional()});
type StatusRecord = z.infer<typeof RecordSchema>;
export interface FixtureStatusSource {
  load(fixtures: readonly Fixture[]): Promise<Map<string, {status:GameState; gameId:string}>>;
}

// Request-local coordinator; persistent records/leases are shared across users
// and isolates. No timer, cron, provider request or client-supplied game ID.
export class FixtureLifecycle {
  private readonly records = new Map<string, StatusRecord | null>();
  private readonly reads = new Map<string, Promise<void>>();
  private healthy = true;
  constructor(private readonly store: FixtureLifecycleStore, private readonly source: FixtureStatusSource, private readonly now:()=>number = Date.now, private readonly logger?: Pick<AppLogger,'warn'>) {}

  async prime(fixtures: readonly (Fixture | null | undefined)[]): Promise<void> {
    const keys = [...new Set(fixtures.flatMap(f => {
      const key = f && fixtureStatusKey(f);
      return key && this.now() >= Date.parse(f!.date) + FIXTURE_STATUS_START_MS ? [key] : [];
    }))];
    const missing = keys.filter(key=>!this.records.has(key) && !this.reads.has(key));
    if (missing.length) {
      const task = (async()=>{
        try {
          const values = this.store.getMany ? await this.store.getMany<unknown>(missing,'json') :
            new Map(await Promise.all(missing.map(async key=>[key,await this.store.get(key,'json')] as const)));
          for (const key of missing) {
            const parsed = RecordSchema.safeParse(values.get(key));
            this.records.set(key, parsed.success ? parsed.data : null);
          }
        } catch { this.healthy = false; for(const key of missing) this.records.set(key,null); }
      })();
      for(const key of missing) this.reads.set(key,task);
    }
    await Promise.all(keys.map(key=>this.reads.get(key)));
  }

  async isFinished(fixture: Fixture): Promise<boolean> {
    await this.prime([fixture]);
    return this.records.get(fixtureStatusKey(fixture) ?? '')?.status === 'played';
  }

  async isActive(fixture:Fixture):Promise<boolean> {
    await this.prime([fixture]);
    const record=this.records.get(fixtureStatusKey(fixture)??'');
    const status=record?.status==='checking'?record.previousStatus:record?.status;
    return status==='playing' || status==='suspended';
  }

  async check(fixtures: readonly Fixture[]): Promise<ReadonlySet<string>> {
    await this.prime(fixtures);
    if (!this.healthy || !this.store.putIfAbsent) return new Set();
    const due = new Map<string,Fixture>();
    const now = this.now();
    for(const f of fixtures) {
      const key = fixtureStatusKey(f);
      if(!key || now < Date.parse(f.date)+FIXTURE_STATUS_START_MS) continue;
      const record = this.records.get(key);
      if(record?.status==='played' || (record && record.nextCheckAt>now)) continue;
      if(due.size<10) due.set(key,record?.gameId ? {...f,gameId:record.gameId} : f);
    }
    const claimed: Fixture[] = [];
    await Promise.all([...due].map(async([key,fixture])=>{
      try {
        const won = await this.store.putIfAbsent!(`${key}:lease`,JSON.stringify({at:now}),{expirationTtl:FIXTURE_STATUS_INTERVAL_MS/1000});
        if(!won) {
          const previous=GameStateSchema.safeParse(this.records.get(key)?.status);
          this.records.set(key,{status:'checking',checkedAt:now,nextCheckAt:now+FIXTURE_STATUS_INTERVAL_MS,...(previous.success?{previousStatus:previous.data}:{})});
          return;
        }
        const previous=GameStateSchema.safeParse(this.records.get(key)?.status);
        const record:StatusRecord = {status:'checking',checkedAt:now,nextCheckAt:now+FIXTURE_STATUS_INTERVAL_MS,...(previous.success?{previousStatus:previous.data}:{})};
        await this.store.put(key,JSON.stringify(record),{expirationTtl:7*86400});
        this.records.set(key,record);
        claimed.push(fixture);
      } catch { this.healthy=false; }
    }));
    if(!claimed.length) return new Set();
    let results: Awaited<ReturnType<FixtureStatusSource['load']>> = new Map();
    try { results = await this.source.load(claimed); } catch (error) {
      this.logger?.warn({games:claimed.length,error:error instanceof Error?error.message:String(error)},'Sorare fixture status unavailable; preserving fixture until retry');
    }
    await Promise.all(claimed.map(async fixture=>{
      const key = fixtureStatusKey(fixture)!;
      const result = results.get(key);
      const record:StatusRecord = {status:result?.status ?? 'unavailable',checkedAt:now,nextCheckAt:now+FIXTURE_STATUS_INTERVAL_MS,...(result ? {gameId:result.gameId}: {})};
      try { await this.store.put(key,JSON.stringify(record),{expirationTtl:7*86400}); this.records.set(key,record); }
      catch { this.healthy=false; }
    }));
    return new Set(claimed.map(f=>fixtureStatusKey(f)!));
  }

  async decorate(players: readonly PlayerStats[]): Promise<PlayerStats[]> {
    await this.prime(players.map(p=>p.nextGame));
    return players.map(player=>{
      const f=player.nextGame;
      const key=f && fixtureStatusKey(f);
      if(!f || !key) return player;
      const record=this.records.get(key);
      const now=this.now();
      const fallback=fixtureRolloverAtMs(f.date)!;
      const active=record?.status==='playing' || record?.status==='suspended' || (record?.status==='checking' && (record.previousStatus==='playing'||record.previousStatus==='suspended'));
      let nextCheckAt=active ? record!.nextCheckAt : Math.min(fallback,record?.nextCheckAt ?? Date.parse(f.date)+FIXTURE_STATUS_START_MS);
      if(record?.status==='checking' && now-record.checkedAt<15_000) nextCheckAt=now+3_000;
      nextCheckAt=Math.max(now+3_000,nextCheckAt);
      if(record?.status==='played') {
        // Never attach a delayed old fixture's markets to the next game.
        return {...player,nextGame:null,pendingRefreshes:[...new Set([...(player.pendingRefreshes ?? []),'fixture' as const])],fixtureRefresh:{key,nextCheckAt:new Date(now+15_000).toISOString()}};
      }
      return {...player,fixtureRefresh:{key,nextCheckAt:new Date(nextCheckAt).toISOString()}};
    });
  }
}
