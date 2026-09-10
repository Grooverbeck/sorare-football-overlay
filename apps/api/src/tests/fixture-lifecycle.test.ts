import { describe, expect, it, vi } from 'vitest';
import { fixtureStatusKey } from '@sorare-overlay/shared';
import { FixtureLifecycle, type Fixture, type FixtureLifecycleStore, type GameState } from '../services/fixture-lifecycle.js';
import { SorareFixtureStatusSource } from '../graphql/fixture-status-source.js';

const fixture:Fixture={date:'2032-01-02T19:00:00Z',gameId:'Game:one',homeTeamSlug:'home-team',awayTeamSlug:'away-team',playerTeamSlug:'home-team',cleanSheetProbability:0.4,matchProbabilities:null};
function store(now:()=>number):FixtureLifecycleStore {
  const rows=new Map<string,{value:string;expires:number}>();
  return {
    async get<T>(key:string){const row=rows.get(key);return row&&row.expires>now()?JSON.parse(row.value) as T:null;},
    async put(key,value,options){rows.set(key,{value,expires:now()+options.expirationTtl*1000});},
    async putIfAbsent(key,value,options){const row=rows.get(key);if(row&&row.expires>now())return false;rows.set(key,{value,expires:now()+options.expirationTtl*1000});return true;},
  };
}
describe('demand-driven fixture status',()=>{
  it('does no status work before two hours or just because time passes',async()=>{
    let now=Date.parse(fixture.date)+119*60_000;
    const load=vi.fn(async()=>new Map());const lifecycle=new FixtureLifecycle(store(()=>now),{load},()=>now);
    await lifecycle.check([fixture]);expect(load).not.toHaveBeenCalled();
    now+=60_000;expect(load).not.toHaveBeenCalled();
    await lifecycle.check([fixture]);expect(load).toHaveBeenCalledTimes(1);
  });
  it.each(['playing','suspended','scheduled','cancelled','postponed'] as GameState[])('retains %s and retries no earlier than 15 minutes',async status=>{
    let now=Date.parse(fixture.date)+2*3_600_000;
    const shared=store(()=>now);const load=vi.fn(async()=>new Map([[fixtureStatusKey(fixture)!,{status,gameId:'Game:one'}]]));
    const first=new FixtureLifecycle(shared,{load},()=>now);
    await first.check([fixture,fixture]);expect(await first.isFinished(fixture)).toBe(false);
    now+=899_999;await new FixtureLifecycle(shared,{load},()=>now).check([fixture]);expect(load).toHaveBeenCalledTimes(1);
    now++;await new FixtureLifecycle(shared,{load},()=>now).check([fixture]);expect(load).toHaveBeenCalledTimes(2);
  });
  it('shares concurrent checks and remembers played across independent workers',async()=>{
    const now=Date.parse(fixture.date)+3*3_600_000;const shared=store(()=>now);
    const load=vi.fn(async()=>new Map([[fixtureStatusKey(fixture)!,{status:'played' as const,gameId:'Game:one'}]]));
    await Promise.all(Array.from({length:20},()=>new FixtureLifecycle(shared,{load},()=>now).check([fixture])));
    expect(load).toHaveBeenCalledTimes(1);
    const later=new FixtureLifecycle(shared,{load},()=>now+3_600_000);
    expect(await later.isFinished(fixture)).toBe(true);await later.check([fixture]);expect(load).toHaveBeenCalledTimes(1);
  });
  it('backs off on an error without treating the match as finished',async()=>{
    const now=Date.parse(fixture.date)+3*3_600_000;const shared=store(()=>now);
    const load=vi.fn(async()=>{throw new Error('429');});
    const first=new FixtureLifecycle(shared,{load},()=>now);await first.check([fixture]);
    expect(await first.isFinished(fixture)).toBe(false);
    await new FixtureLifecycle(shared,{load},()=>now+1).check([fixture]);expect(load).toHaveBeenCalledTimes(1);
  });
  it('fails closed when a shared claim is unavailable',async()=>{
    const now=Date.parse(fixture.date)+3*3_600_000;const shared=store(()=>now);delete shared.putIfAbsent;
    const load=vi.fn(async()=>new Map());await new FixtureLifecycle(shared,{load},()=>now).check([fixture]);expect(load).not.toHaveBeenCalled();
  });
});

describe('canonical Sorare status lookup',()=>{
  it('normalizes Sorare global Game IDs for the direct lookup',async()=>{
    const request=vi.fn(async(_query:string,_variables:Record<string,string>)=>({football:{f0:{id:fixture.gameId,date:fixture.date,statusTyped:'played',homeTeam:{slug:'home-team'},awayTeam:{slug:'away-team'}}}}));
    const source=new SorareFixtureStatusSource({request:request as never});
    expect((await source.load([fixture])).get(fixtureStatusKey(fixture)!)).toEqual({status:'played',gameId:'Game:one'});
    expect(request.mock.calls[0]?.[1]).toEqual({id0:'one'});
  });
  it('uses stored game IDs and validates both clubs and kickoff',async()=>{
    const request=vi.fn(async()=>({football:{f0:{id:fixture.gameId,date:fixture.date,statusTyped:'played',homeTeam:{slug:'home-team'},awayTeam:{slug:'wrong-team'}}}}));
    const source=new SorareFixtureStatusSource({request:request as never});
    expect(await source.load([fixture])).toEqual(new Map());
    expect(request.mock.calls[0]).toBeDefined();
  });
  it('resolves old rows through a bounded club lookup and rejects ambiguity',async()=>{
    const {gameId:_,...legacy}=fixture;
    const game={id:'Game:old',date:fixture.date,statusTyped:'played',homeTeam:{slug:'home-team'},awayTeam:{slug:'away-team'}};
    const request=vi.fn(async()=>({football:{f0:{games:{nodes:[game]}}}}));
    const source=new SorareFixtureStatusSource({request:request as never});
    expect((await source.load([legacy])).get(fixtureStatusKey(legacy)!)).toEqual({status:'played',gameId:'Game:old'});
    request.mockResolvedValueOnce({football:{f0:{games:{nodes:[game,game]}}}});
    expect(await source.load([legacy])).toEqual(new Map());
  });
});
