import { CardIdentitySchema, type CardIdentity } from '@sorare-overlay/shared';
import { CardCatalogStateSchema, type CardCatalogState, type CardCatalogStore } from '../services/card-catalog.js';
import { D1JsonKeyValueStore } from './d1-cache.js';

export const cardCatalogPictureKey=(id:string)=>`card-picture:v1:${id}`;
export const cardCatalogStateKey='card-catalog:v1:state';
const leaseKey='card-catalog:v1:lease';

export class D1CardCatalogStore implements CardCatalogStore {
  private readonly cache:D1JsonKeyValueStore;
  constructor(private readonly db:D1Database) {this.cache=new D1JsonKeyValueStore(db);}
  async read(ids:readonly string[]):Promise<CardIdentity[]> {
    const values=await this.cache.getMany<unknown>(ids.map(cardCatalogPictureKey),'json');
    return ids.flatMap(id=>{
      const row=values.get(cardCatalogPictureKey(id));
      if(row && typeof row==='object' && 'conflict' in row && row.conflict) return [];
      const parsed=CardIdentitySchema.safeParse(row);
      return parsed.success && parsed.data.pictureId===id?[parsed.data]:[];
    });
  }
  async acquire(token:string,now:number):Promise<boolean> {
    return this.cache.putIfAbsent(leaseKey,JSON.stringify(token),{expiration:Math.floor(now/1000)+120});
  }
  async state():Promise<CardCatalogState|null> {
    const parsed=CardCatalogStateSchema.safeParse(await this.cache.get(cardCatalogStateKey,'json'));
    return parsed.success?parsed.data:null;
  }
  async save(token:string,state:CardCatalogState,identities:readonly CardIdentity[],now:number):Promise<boolean> {
    const seconds=Math.floor(now/1000);
    // A stale cron cannot publish data/progress after another run takes its lease.
    const lease=`EXISTS(SELECT 1 FROM cache_entries WHERE cache_key=?4 AND value=?5 AND expires_at>?3)`;
    const pictures=[...new Map(identities.map(row=>[row.pictureId,CardIdentitySchema.parse(row)])).values()];
    const statements=pictures.length?[this.db.prepare(`
      INSERT INTO cache_entries(cache_key,value,expires_at,updated_at)
      SELECT 'card-picture:v1:'||json_extract(item.value,'$.pictureId'),item.value,NULL,?3
      FROM json_each(?2) AS item WHERE ${lease}
      ON CONFLICT(cache_key) DO UPDATE SET value=CASE
        WHEN json_extract(cache_entries.value,'$.conflict')=1 OR
             json_extract(cache_entries.value,'$.playerSlug')<>json_extract(excluded.value,'$.playerSlug')
        THEN json_object('pictureId',json_extract(excluded.value,'$.pictureId'),'conflict',json('true'))
        ELSE excluded.value END, expires_at=NULL,updated_at=excluded.updated_at
    `).bind(null,JSON.stringify(pictures),seconds,leaseKey,JSON.stringify(token))]:[];
    statements.push(this.db.prepare(`INSERT INTO cache_entries(cache_key,value,expires_at,updated_at)
      SELECT ?1,?2,NULL,?3 WHERE ${lease}
      ON CONFLICT(cache_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
    `).bind(cardCatalogStateKey,JSON.stringify(CardCatalogStateSchema.parse(state)),seconds,leaseKey,JSON.stringify(token)));
    const results=await this.db.batch(statements);
    return (results.at(-1)?.meta.changes??0)>0;
  }
}
