import {env,createExecutionContext,waitOnExecutionContext} from 'cloudflare:test';
import {beforeAll,beforeEach,expect,it,vi} from 'vitest';
import type {PlayerStats} from '@sorare-overlay/shared';
import {CloudflarePlayerStatsCache} from '../cloudflare/cache.js';
import {D1JsonKeyValueStore} from '../cloudflare/d1-cache.js';

const now=Date.parse('2026-10-09T12:00:00Z'),key='igor-vekic:Goalkeeper:no-low';
const old:NonNullable<PlayerStats['nextGame']>={gameId:'Game:07af3ee4-ada0-48a1-9021-8969ae54ef32',date:'2026-10-10T00:00:00Z',competitionSlug:'1-hnl',homeTeamSlug:'slaven-koprivnica-koprivnica',awayTeamSlug:'rijeka-rijeka',playerTeamSlug:'rijeka-rijeka',homeTeamName:'Slaven Koprivnica',awayTeamName:'Rijeka',playerTeamName:'Rijeka',opponentTeamName:'Slaven Koprivnica',cleanSheetProbability:null,matchProbabilities:null};
const corrected={...old,date:'2026-10-11T16:00:00Z',sorareObservedAt:now+100,cleanSheetProbability:1/2.25,matchProbabilities:{win:.56,draw:.25,loss:.19}};
const envelope=(nextGame:PlayerStats['nextGame'])=>JSON.stringify({nextGame,teamIdentityVersion:1,cachePolicyVersion:3});
beforeAll(async()=>{await env.CACHE_DB.exec('CREATE TABLE IF NOT EXISTS cache_entries(cache_key TEXT PRIMARY KEY,value TEXT NOT NULL,expires_at INTEGER,updated_at INTEGER NOT NULL)');});
beforeEach(async()=>{await env.CACHE_DB.prepare('DELETE FROM cache_entries').run();});
function instance() {
  const store=new D1JsonKeyValueStore(env.CACHE_DB,undefined,()=>now/1000),context=createExecutionContext();
  return {store,context,cache:new CloudflarePlayerStatsCache(store,604800,14400,context,()=>now)};
}
async function seeded() {
  const item=instance();
  await item.cache.set(key,{slug:'igor-vekic',displayName:'Igor Vekić',position:'Goalkeeper',aaL10:{value:6.7,sampleSize:4},aaL10TeamWinRate:{value:.5,sampleSize:4},goalL10:{value:0,sampleSize:4},cleanSheetL10:{value:.25,sampleSize:4},excludedLowCoverage:0,nextGame:old});
  await waitOnExecutionContext(item.context);
  return item;
}

it('repairs a legacy midnight fixture and shares corrected CS without changing club form or copying player props',async()=>{
  const item=await seeded();
  await item.cache.getParts(key); // populate the old request-local memo too
  expect(await item.cache.refreshFixture(key,{...corrected,marketOdds:{source:'odds-api-io',capturedAt:'2026-10-09T12:00:00Z',goal:{probability:.7,bookmakerCount:1}}})).toMatchObject({date:corrected.date,cleanSheetProbability:corrected.cleanSheetProbability});
  await waitOnExecutionContext(item.context);
  const reader=instance();
  const stats=await reader.cache.get(key);
  expect(stats?.aaL10).toEqual({value:6.7,sampleSize:4});
  expect(stats?.nextGame).toMatchObject({gameId:old.gameId,date:corrected.date,sorareObservedAt:corrected.sorareObservedAt,cleanSheetProbability:1/2.25});
  expect(stats?.nextGame?.marketOdds).toBeUndefined();
  const teammate=await reader.cache.getTeamFixture('teammate:Defender:no-low','rijeka-rijeka');
  expect(teammate).toMatchObject({date:corrected.date,cleanSheetProbability:1/2.25});expect(teammate?.marketOdds).toBeUndefined();
  await waitOnExecutionContext(reader.context);
});

it('atomically rejects late legacy, older and equal-time reschedule writes to both player and team rows',async()=>{
  const item=await seeded();await item.cache.refreshFixture(key,corrected);await waitOnExecutionContext(item.context);
  for(const stale of [old,{...old,sorareObservedAt:now+50},{...old,sorareObservedAt:now+100}]) {
    await item.store.putEarlierFixture('player-team-fixture:v2:rijeka-rijeka',envelope(stale),{expiration:now/1000+7*86400});
    await item.store.put('player-fixture:v1:igor-vekic:auto-v3:no-low',envelope(stale),{expiration:now/1000+7*86400});
  }
  const reader=instance();
  expect((await reader.cache.getParts(key)).fixture).toMatchObject({date:corrected.date,cleanSheetProbability:1/2.25,sorareObservedAt:now+100});
  const raw=await item.store.get<{nextGame:{date:string}}>('player-fixture:v1:igor-vekic:auto-v3:no-low','json');expect(raw?.nextGame.date).toBe(corrected.date);
  await waitOnExecutionContext(reader.context);
});

it('keeps the newest source observation when another isolate with stale memos finishes later',async()=>{
  await seeded();const stale=instance(),winner=instance();await stale.cache.getParts(key);
  const newest={...corrected,date:'2026-10-11T18:00:00Z',sorareObservedAt:now+200};
  await winner.cache.refreshFixture(key,newest);await waitOnExecutionContext(winner.context);
  await stale.cache.refreshFixture(key,corrected);await waitOnExecutionContext(stale.context);
  const reader=instance();expect((await reader.cache.getParts(key)).fixture).toMatchObject({date:newest.date,sorareObservedAt:now+200});
  await waitOnExecutionContext(reader.context);
});

it('also accepts an earlier kickoff when a newer source observation confirms the same game',async()=>{
  const item=await seeded();await item.cache.refreshFixture(key,corrected);await waitOnExecutionContext(item.context);
  const earlier={...corrected,date:'2026-10-10T20:00:00Z',sorareObservedAt:now+300};
  const fresh=instance();expect(await fresh.cache.refreshFixture(key,earlier)).toMatchObject({date:earlier.date,sorareObservedAt:now+300});
  await waitOnExecutionContext(fresh.context);
});

it.each(['different-game','different-home','different-away','different-side','different-competition','missing-observation'])('does not treat uncertain later fixtures as authoritative reschedules: %s',async kind=>{
  const item=await seeded();const candidate={...corrected};
  if(kind==='different-game')candidate.gameId='Game:00000000-0000-0000-0000-000000000001';
  if(kind==='different-home')candidate.homeTeamSlug='other-home';
  if(kind==='different-away')candidate.awayTeamSlug='other-away';
  if(kind==='different-side')candidate.playerTeamSlug='other-team';
  if(kind==='different-competition')candidate.competitionSlug='other-competition';
  if(kind==='missing-observation')delete (candidate as Partial<typeof candidate>).sorareObservedAt;
  // A real server-confirmed transfer has its existing separate authority path;
  // exercise team CAS here rather than pretending this is transfer evidence.
  await item.store.putEarlierFixture('player-team-fixture:v2:rijeka-rijeka',envelope(candidate),{expiration:now/1000+86400});
  const raw=await item.store.get<{nextGame:{date:string}}>('player-team-fixture:v2:rijeka-rijeka','json');expect(raw?.nextGame.date).toBe(old.date);
});

it('does not renew source freshness or write identity rows on ordinary warm reads',async()=>{
  const item=await seeded();await item.cache.refreshFixture(key,corrected);await waitOnExecutionContext(item.context);
  const before=await env.CACHE_DB.prepare("SELECT value,updated_at FROM cache_entries WHERE cache_key='player-team-fixture:v2:rijeka-rijeka'").first();
  for(let i=0;i<3;i++){
    const reader=instance(),identityWrite=vi.spyOn(reader.store,'putEarlierFixture'),put=vi.spyOn(reader.store,'put');
    expect((await reader.cache.getParts(key)).fixture?.sorareObservedAt).toBe(now+100);await waitOnExecutionContext(reader.context);
    expect(identityWrite).not.toHaveBeenCalled();expect(put.mock.calls.filter(([cacheKey])=>/^player-(team-)?fixture:/.test(cacheKey))).toHaveLength(0);
  }
  const after=await env.CACHE_DB.prepare("SELECT value,updated_at FROM cache_entries WHERE cache_key='player-team-fixture:v2:rijeka-rijeka'").first();expect(after).toEqual(before);
});
