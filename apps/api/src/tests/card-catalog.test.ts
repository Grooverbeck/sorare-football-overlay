import {describe,expect,it,vi} from 'vitest';
import {CardCatalogRefresher,CardCatalogStateSchema,CardIdentityService,SorareCardCatalogSource,emptyCardCatalogState,type CardCatalogState,type CardCatalogStore,type CardCatalogScope} from '../services/card-catalog.js';
import type {CardIdentity} from '@sorare-overlay/shared';
import {SorareGraphqlClient} from '../graphql/client.js';

const id='70f9f242-6638-4505-bf9d-9d8c40fe811a';
const other='f0c4cd43-4ff1-4205-9ed2-01f97961c95d';
const identity:CardIdentity={pictureId:id,playerSlug:'future-player'};
const scope:CardCatalogScope={slug:'future-set',customCardEditionNames:['standard','video'],availableCompetitions:[{slug:'league'}]};
class MemoryStore implements CardCatalogStore {
  value:CardCatalogState|null=null; rows=new Map<string,CardIdentity>();allowed=true;
  acquire=vi.fn(async()=>this.allowed);
  async state(){return this.value?structuredClone(this.value):null;}
  async read(ids:readonly string[]){return ids.flatMap(id=>this.rows.has(id)?[this.rows.get(id)!]:[]);}
  async save(_token:string,state:CardCatalogState,rows:readonly CardIdentity[]){this.value=structuredClone(state);for(const row of rows)this.rows.set(row.pictureId,row);return true;}
}
function source(){return {scope:vi.fn(async()=>scope),players:vi.fn(async()=>({slugs:['future-player'],next:null})),cards:vi.fn(async(_player:string,_scope:CardCatalogScope,edition?:string)=>({identities:[edition?{pictureId:other,playerSlug:'future-player'}:identity],editions:[edition??'standard']}))};}

describe('bounded shared card catalogue',()=>{
  it('builds samples and missing editions without per-name exceptions',async()=>{
    const store=new MemoryStore(),api=source();
    const result=await new CardCatalogRefresher(api,store,()=>200000000).run();
    expect(result).toEqual({queries:4,pictures:2});
    expect(api.cards.mock.calls.map(row=>row[2])).toEqual([undefined,'video']);
    expect((await new CardIdentityService(store).resolve([id,other])).data).toHaveLength(2);
    expect(store.value?.nextRunAt).toBeGreaterThan(200000000);
  });
  it('checkpoints after a slice and resumes instead of repeating earlier requests',async()=>{
    const store=new MemoryStore(),api=source();
    await new CardCatalogRefresher(api,store,()=>200000000).run(3);
    expect(store.value).toMatchObject({sampled:true,missingEditions:['video']});
    await new CardCatalogRefresher(api,store,()=>200300000).run(2);
    expect(api.scope).toHaveBeenCalledTimes(1);expect(api.players).toHaveBeenCalledTimes(1);
    expect(api.cards).toHaveBeenCalledTimes(2);
  });
  it('keeps verified identities and progress if Sorare fails',async()=>{
    const store=new MemoryStore(),api=source();
    await new CardCatalogRefresher(api,store,()=>200000000).run(3);
    api.cards.mockRejectedValueOnce(new Error('429'));
    await expect(new CardCatalogRefresher(api,store,()=>200300000).run()).rejects.toThrow('429');
    expect(store.value?.missingEditions).toEqual(['video']);expect(store.rows.get(id)).toEqual(identity);
  });
  it('does not call Sorare if another cron owns the lease',async()=>{
    const store=new MemoryStore(),api=source();store.allowed=false;
    expect(await new CardCatalogRefresher(api,store).run()).toEqual({queries:0,pictures:0});
    expect(api.scope).not.toHaveBeenCalled();
  });
  it('respects cooldown and resets discovery on a new Set without removing old pictures',async()=>{
    const store=new MemoryStore(),api=source();
    await new CardCatalogRefresher(api,store,()=>200000000).run();
    await new CardCatalogRefresher(api,store,()=>200001000).run();
    expect(api.scope).toHaveBeenCalledTimes(1);
    api.scope.mockResolvedValue({...scope,slug:'new-set'});
    await new CardCatalogRefresher(api,store,()=>300000000).run(2);
    expect(store.value?.scope?.slug).toBe('new-set');expect(store.rows.has(id)).toBe(true);
  });
  it('avoids edition fan-out for players without any current-set card',async()=>{
    const store=new MemoryStore(),api=source();api.cards.mockResolvedValue({identities:[],editions:[]});
    await new CardCatalogRefresher(api,store,()=>200000000).run();
    expect(api.cards).toHaveBeenCalledTimes(1);
  });
  it('only reads the index on extension lookups',async()=>{
    const store=new MemoryStore();store.rows.set(id,identity);
    expect(await new CardIdentityService(store).resolve([id,other])).toEqual({data:[identity],retryAfterSeconds:300});
    expect(store.acquire).not.toHaveBeenCalled();
  });
  it('honors persisted null-scope backoff',async()=>{
    const store=new MemoryStore(),api=source();store.value={...emptyCardCatalogState(),nextRunAt:500};
    await new CardCatalogRefresher(api,store,()=>100).run();expect(api.scope).not.toHaveBeenCalled();
  });
  it('resumes legacy season-scoped checkpoints without resetting discovery or deleting identities',async()=>{
    const store=new MemoryStore(),api=source();
    store.rows.set(id,identity);
    store.value=CardCatalogStateSchema.parse({...emptyCardCatalogState(),
      scope:{...scope,season:{startYear:2030}},scopeCheckedAt:200000000,
      players:['future-player'],sampled:true,missingEditions:['video'],competitionIndex:1,
    });
    expect(store.value.scope).toEqual(scope);
    await new CardCatalogRefresher(api,store,()=>200300000).run(1);
    expect(api.scope).not.toHaveBeenCalled();expect(api.players).not.toHaveBeenCalled();
    expect(api.cards).toHaveBeenCalledExactlyOnceWith('future-player',scope,'video');
    expect(store.rows.get(id)).toEqual(identity);expect(store.rows.get(other)?.playerSlug).toBe('future-player');
  });
});

function publicSource(response:unknown){
  const fetchImpl=vi.fn<typeof fetch>(async()=>Response.json(response));
  const client=new SorareGraphqlClient({url:'https://api.sorare.com/graphql',requestTimeoutMs:1000,maxRetries:0,logger:{debug(){},info(){},warn(){},error(){}},fetchImpl});
  return {source:new SorareCardCatalogSource(client),fetchImpl};
}
it('reads the explicit current Football Set without deprecated season metadata',async()=>{
  const {source,fetchImpl}=publicSource({data:{cardSet:{currentSet:scope}}});
  expect(await source.scope()).toEqual(scope);
  const body=JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
  expect(body.query).toContain('currentSet(sport: FOOTBALL)');
  expect(body.query).not.toMatch(/\bseason\b/);
  expect(await publicSource({data:{cardSet:{currentSet:null}}}).source.scope()).toBeNull();
});
it('validates official image host, requested player and active edition in upstream responses',async()=>{
  const nodes=[
    {pictureUrl:`https://assets.sorare.com/cardsamplepicture/${id}/picture/a.png`,customCardEditionName:'video',cardSet:{slug:scope.slug},anyPlayer:{slug:'future-player'}},
    {pictureUrl:`https://example.com/cardsamplepicture/${other}/picture/a.png`,customCardEditionName:'video',cardSet:{slug:scope.slug},anyPlayer:{slug:'future-player'}},
    {pictureUrl:`https://assets.sorare.com/cardsamplepicture/${other}/picture/a.png`,customCardEditionName:'old-set',cardSet:{slug:scope.slug},anyPlayer:{slug:'future-player'}},
  ];
  const {source,fetchImpl}=publicSource({data:{cardsWhere:{nodes}}});
  expect(await source.cards('future-player',scope)).toEqual({identities:[identity],editions:['video']});
  const body=JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
  expect(body.variables).toEqual({player:'future-player',edition:null,first:50});
  expect(body.query).toContain('... on Card { customCardEditionName }');
  expect(body.query).toContain('cardSet { slug }');
  expect(body.query).not.toContain('seasonStartYears');
  nodes[0]!.anyPlayer.slug='wrong-player';
  await expect(source.cards('future-player',scope)).rejects.toThrow('different catalog player');
});
it('requires exact Set membership even with matching editions and admits cards across minting seasons',async()=>{
  const card={pictureUrl:`https://assets.sorare.com/cardsamplepicture/${id}/picture/a.png`,customCardEditionName:'video',cardSet:{slug:scope.slug},anyPlayer:{slug:'future-player'}};
  const {source,fetchImpl}=publicSource({data:{cardsWhere:{nodes:[
    {...card,seasonYear:2028},
    {...card,pictureUrl:`https://assets.sorare.com/cardsamplepicture/${other}/picture/a.png`,seasonYear:2030},
    {...card,cardSet:{slug:'previous-set'}},
    {...card,cardSet:null},
  ]}}});
  expect(await source.cards('future-player',scope,'video')).toEqual({identities:[identity,{pictureId:other,playerSlug:'future-player'}],editions:['video']});
  expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)).variables).toEqual({player:'future-player',edition:'video',first:5});
  await expect(source.cards('future-player',scope,'standard')).rejects.toThrow('different card edition');
  const onlyOther=publicSource({data:{cardsWhere:{nodes:[{...card,cardSet:{slug:'previous-set'}},{...card,cardSet:null}]}}});
  expect(await onlyOther.source.cards('future-player',scope)).toEqual({identities:[],editions:[]});
});
it('rejects a non-advancing roster cursor instead of looping forever',async()=>{
  const {source}=publicSource({data:{football:{competition:{orderedPlayers:{nodes:[],pageInfo:{hasNextPage:true,endCursor:'same'}}}}}});
  await expect(source.players('league','same')).rejects.toThrow('Non-advancing');
});
