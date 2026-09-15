import { afterEach, describe, expect, it, vi } from 'vitest';
import { LineupSortValuesRequestSchema, type LineupSortValue, type LineupSortValuesRequest, type LineupSortValuesSuccessResponse } from '@sorare-overlay/shared';
import { LineupSortHydrator } from '../lineup-sort-hydrator.js';
import type { CardTarget } from '../dom.js';
import { readSortReadiness, sortFinalCheckAttribute } from '../lineup-sort-readiness.js';
import { fixtureIdentityAttribute } from '../fixture-refresh.js';
import { setLineupGoalSortValue } from '../lineup-sort.js';

let hydrator: LineupSortHydrator;
afterEach(()=>{hydrator?.stop();document.body.replaceChildren();vi.useRealTimers();});
function pool(count: number) {
  document.body.innerHTML=`<section>${'<article></article>'.repeat(count)}</section>`;
  const grid=document.querySelector<HTMLElement>('section')!;
  const targets:CardTarget[]=[...grid.children].map(container=>({container:container as HTMLElement,slug:'test-player',position:'Forward'}));
  return {grid,targets};
}
function response(request: LineupSortValuesRequest): LineupSortValuesSuccessResponse {
  LineupSortValuesRequestSchema.parse(request);
  const slugs=[...(request.slugs??[]),...(request.playerNames??[]).map(name=>name.toLowerCase().replaceAll(' ','-'))];
  return {data:slugs.map(slug=>({slug,displayName:slug.replaceAll('-',' '),position:request.positions?.[slug]??'Forward',aa:10,
    goal:{probability:.4,source:'market'},cleanSheet:null,readiness:{goal:'ready',aa:'ready',cleanSheet:'unavailable'}})),
    meta:{requested:slugs.length,returned:slugs.length,cacheHits:slugs.length,source:'sorare',durationMs:1}};
}

describe('shared compact sort requests',()=>{
  it('accepts identical name/slug answers for automatic and explicit positions without retrying', async () => {
    const {grid, targets} = pool(2);
    const named: CardTarget = {container: targets[1]!.container, playerName: 'Test Player', position: 'Forward'};
    delete targets[0]!.position;
    targets[0]!.teamSlug = 'team-one';
    const fetcher = vi.fn(async (request: LineupSortValuesRequest) => {
      const result = response(request);
      expect(result.data).toHaveLength(2);
      // Independent JSON objects, including a different property order.
      for (const value of result.data) {
        value.fixtureIdentity = 'fixture-status:v1:100:one:two';
        value.fixtureRefresh = {key: 'fixture-status:v1:100:one:two', nextCheckAt: '2026-09-16T21:30:00Z'};
      }
      result.data[1]!.readiness = {aa: 'ready', cleanSheet: 'unavailable', goal: 'ready'};
      return result;
    });
    hydrator = new LineupSortHydrator(fetcher, 50, []);
    await hydrator.hydrate(grid, [targets[0]!, named]);
    hydrator.finalizePool(grid);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toMatchObject({slugs: ['test-player'], playerNames: ['Test Player']});
    expect(targets.every(t => readSortReadiness(t.container)?.goal === 'ready')).toBe(true);
    expect(targets.every(t => t.container.getAttribute('data-sorare-overlay-goal-sort-probability') === '0.4')).toBe(true);
    expect(grid.getAttribute(sortFinalCheckAttribute)).toBe('complete');
  });

  it.each<[string, Partial<LineupSortValue>]>([
    ['player', {slug: 'another-player'}],
    ['position', {position: 'Midfielder'}],
    ['fixture', {fixtureIdentity: 'fixture-status:v1:200:one:three'}],
    ['missing fixture identity', {fixtureIdentity: undefined}],
    ['no fixture', {fixtureIdentity: null}],
    ['refresh identity', {fixtureRefresh: {key: 'different-team-fixture', nextCheckAt: '2026-09-16T21:30:00Z'}}],
    ['refresh time', {fixtureRefresh: {key: 'fixture-status:v1:100:one:two', nextCheckAt: '2026-09-17T21:30:00Z'}}],
    ['goal', {goal: {probability: .8, source: 'market'}}],
    ['goal source', {goal: {probability: .4, source: 'historical'}}],
    ['AA', {aa: 20}],
    ['CS', {cleanSheet: .5}],
    ['readiness', {readiness: {goal: 'pending', aa: 'ready', cleanSheet: 'unavailable'}}],
  ])('still rejects conflicting duplicate %s answers for an unresolved card', async (_label, conflict) => {
    const {grid, targets} = pool(1);
    const named: CardTarget = {container: targets[0]!.container, playerName: 'Test Player'};
    hydrator = new LineupSortHydrator(async request => {
      const result = response(request);
      const value: LineupSortValue = {...result.data[0]!, fixtureIdentity: 'fixture-status:v1:100:one:two',
        fixtureRefresh: {key: 'fixture-status:v1:100:one:two', nextCheckAt: '2026-09-16T21:30:00Z'}};
      return {...result, data: [value, {...value, ...conflict}]};
    }, 50, []);
    await hydrator.hydrate(grid, [named]);
    expect(readSortReadiness(named.container)?.goal).toBe('error');
    expect(named.container.hasAttribute('data-sorare-overlay-goal-sort-probability')).toBe(false);
  });

  it('selects the explicit card position even when other positions occur in a duplicate response', async () => {
    const {grid, targets} = pool(1);
    hydrator = new LineupSortHydrator(async request => {
      const result = response(request);
      const value = result.data[0]!;
      return {...result, data: [value, {...value}, {...value, position: 'Midfielder', aa: 30}]};
    }, 50, []);
    await hydrator.hydrate(grid, targets);
    expect(readSortReadiness(targets[0]!.container)?.goal).toBe('ready');
    expect(targets[0]!.container.getAttribute('data-sorare-overlay-aa-sort-value')).toBe('10');
  });

  it('reuses the confirmed name/slug alias and publishes later values back to that alias',async()=>{
    const {grid,targets}=pool(1);const named:CardTarget={container:targets[0]!.container,playerName:'Test Player',position:'Forward'};
    const fetcher=vi.fn(async(request:LineupSortValuesRequest)=>response(request));hydrator=new LineupSortHydrator(fetcher);
    await hydrator.hydrate(grid,[named]);await hydrator.hydrate(grid,targets);
    expect(fetcher).toHaveBeenCalledTimes(1);
    setLineupGoalSortValue(targets[0]!.container,.7,'market');hydrator.preserve(targets[0]!);
    const replacement=document.createElement('article');named.container.replaceWith(replacement);
    await hydrator.hydrate(grid,[{...named,container:replacement}]);
    expect(fetcher).toHaveBeenCalledTimes(1);expect(replacement.getAttribute('data-sorare-overlay-goal-sort-probability')).toBe('0.7');
  });

  it('does not broaden an alias to a different team hint or card position',async()=>{
    const {grid,targets}=pool(1);const fetcher=vi.fn(async(request:LineupSortValuesRequest)=>response(request));hydrator=new LineupSortHydrator(fetcher);
    await hydrator.hydrate(grid,[{...targets[0]!,teamSlug:'team-one'}]);
    await hydrator.hydrate(grid,[{...targets[0]!,teamSlug:'team-two'}]);
    await hydrator.hydrate(grid,[{...targets[0]!,teamSlug:'team-two',position:'Midfielder'}]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('requests each of 319 players once across 638 cards',async()=>{
    const {grid,targets}=pool(638);targets.forEach((target,index)=>{target.slug=`test-player-${Math.floor(index/2)}`;});
    const fetcher=vi.fn(async(request:LineupSortValuesRequest)=>response(request));hydrator=new LineupSortHydrator(fetcher);
    await hydrator.hydrate(grid,targets);
    expect(fetcher).toHaveBeenCalledTimes(7);
    expect(fetcher.mock.calls.reduce((n,[request])=>n+(request.slugs?.length??0),0)).toBe(319);
    expect(targets.every(target=>readSortReadiness(target.container)?.goal==='ready')).toBe(true);
  });

  it('coalesces separate discoveries without waiting for a full fifty-player batch',async()=>{
    const {grid,targets}=pool(2);targets[1]!.slug='second-player';
    const fetcher=vi.fn(async(request:LineupSortValuesRequest)=>response(request));hydrator=new LineupSortHydrator(fetcher);
    const first=hydrator.hydrate(grid,targets.slice(0,1)),second=hydrator.hydrate(grid,targets.slice(1));
    expect(fetcher).not.toHaveBeenCalled();await Promise.all([first,second]);
    expect(fetcher).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls[0]![0].slugs).toEqual(['test-player','second-player']);
  });

  it('joins a duplicate discovered during an in-flight request',async()=>{
    const {grid,targets}=pool(2);let finish!:(value:LineupSortValuesSuccessResponse)=>void;
    const fetcher=vi.fn(()=>new Promise<LineupSortValuesSuccessResponse>(resolve=>{finish=resolve}));hydrator=new LineupSortHydrator(fetcher);
    const first=hydrator.hydrate(grid,targets.slice(0,1));await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));
    const second=hydrator.hydrate(grid,targets.slice(1));finish(response({slugs:['test-player']}));await Promise.all([first,second]);
    expect(fetcher).toHaveBeenCalledTimes(1);expect(targets.every(t=>readSortReadiness(t.container)?.goal==='ready')).toBe(true);
  });

  it.each(['position','team','fixture'] as const)('does not combine conflicting %s scopes',async kind=>{
    const {grid,targets}=pool(2);
    if(kind==='position')targets[1]!.position='Midfielder';
    if(kind==='team'){targets[0]!.teamSlug='team-one';targets[1]!.teamSlug='team-two';}
    if(kind==='fixture'){targets[0]!.container.setAttribute(fixtureIdentityAttribute,'fixture-one');targets[1]!.container.setAttribute(fixtureIdentityAttribute,'fixture-two');}
    const fetcher=vi.fn(async(request:LineupSortValuesRequest)=>response(request));hydrator=new LineupSortHydrator(fetcher);
    await hydrator.hydrate(grid,targets);expect(fetcher).toHaveBeenCalledTimes(2);
    expect(targets.every(t=>readSortReadiness(t.container)?.goal==='ready')).toBe(true);
  });

  it('never resolves a known conflicting slug through the display name',async()=>{
    const {grid,targets}=pool(1);targets[0]!.slug='different-player';targets[0]!.playerName='Test Player';
    hydrator=new LineupSortHydrator(async()=>response({slugs:['test-player']}),50,[]);
    await hydrator.hydrate(grid,targets);
    expect(readSortReadiness(targets[0]!.container)?.goal).toBe('error');
    expect(targets[0]!.container.hasAttribute('data-sorare-overlay-goal-sort-probability')).toBe(false);
  });

  it('does not complete the pool while the final discovery pass still has undiscovered cards',async()=>{
    const {grid,targets}=pool(2);targets[1]!.slug='second-player';
    hydrator=new LineupSortHydrator(async request=>response(request));hydrator.beginPoolReconciliation(grid);
    await hydrator.hydrate(grid,targets.slice(0,1));
    expect(grid.getAttribute(sortFinalCheckAttribute)).toBe('pending');
    expect(readSortReadiness(targets[0]!.container)?.goal).toBe('ready');
    await hydrator.hydrate(grid,targets.slice(1));hydrator.finalizePool(grid);
    expect(grid.getAttribute(sortFinalCheckAttribute)).toBe('complete');
  });

  it('cancels before the coalesced request has started',async()=>{
    const {grid,targets}=pool(1);const fetcher=vi.fn(async(request:LineupSortValuesRequest)=>response(request));hydrator=new LineupSortHydrator(fetcher);
    const pending=hydrator.hydrate(grid,targets);hydrator.cancel();await pending;
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not restore an old fixture when the same confirmed player learns its slug',async()=>{
    const {grid,targets}=pool(1);const named:CardTarget={container:targets[0]!.container,playerName:'Test Player',position:'Forward'};
    const oldFixture='fixture-status:v1:100:one:two',newFixture='fixture-status:v1:200:one:three';
    const fetcher=vi.fn(async(request:LineupSortValuesRequest)=>{const result=response(request);result.data[0]!.fixtureIdentity=oldFixture;return result;});
    hydrator=new LineupSortHydrator(fetcher,50,[]);await hydrator.hydrate(grid,[named]);
    named.container.setAttribute(fixtureIdentityAttribute,newFixture);
    await hydrator.hydrate(grid,targets);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(named.container.getAttribute(fixtureIdentityAttribute)).toBe(newFixture);
    expect(named.container.hasAttribute('data-sorare-overlay-goal-sort-probability')).toBe(false);
  });

  it('does not keep the previous player market when a DOM node is reused for another cached player',async()=>{
    const {grid,targets}=pool(2);targets[1]!.slug='other-player';
    const fetcher=vi.fn(async(request:LineupSortValuesRequest)=>{const result=response(request);for(const value of result.data)value.goal!.probability=value.slug==='other-player'?.2:.8;return result;});
    hydrator=new LineupSortHydrator(fetcher);await hydrator.hydrate(grid,targets);
    await hydrator.hydrate(grid,[{...targets[0]!,slug:'other-player'}]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(targets[0]!.container.getAttribute('data-sorare-overlay-goal-sort-probability')).toBe('0.2');
  });

  it('keeps automatic position selection when using a learned slug for a subsequent request',async()=>{
    const {grid,targets}=pool(1);const named:CardTarget={container:targets[0]!.container,playerName:'Test Player'};
    const fetcher=vi.fn(async(request:LineupSortValuesRequest)=>response(request));hydrator=new LineupSortHydrator(fetcher);
    await hydrator.hydrate(grid,[named]);
    setLineupGoalSortValue(named.container,null);
    await hydrator.reconcileMissingGoals();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]![0].slugs).toEqual(['test-player']);
    expect(fetcher.mock.calls[1]![0].positions).toBeUndefined();
  });

  it('coalesces discoveries in adjacent tasks, then starts within the bounded delay',async()=>{
    vi.useFakeTimers();const {grid,targets}=pool(2);targets[1]!.slug='second-player';
    const fetcher=vi.fn(async(request:LineupSortValuesRequest)=>response(request));hydrator=new LineupSortHydrator(fetcher);
    const first=hydrator.hydrate(grid,targets.slice(0,1));await vi.advanceTimersByTimeAsync(10);
    const second=hydrator.hydrate(grid,targets.slice(1));expect(fetcher).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(14);await Promise.all([first,second]);
    expect(fetcher).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls[0]![0].slugs).toHaveLength(2);
  });

  it('starts a full batch before the remaining coalescing delay',async()=>{
    vi.useFakeTimers();const {grid,targets}=pool(50);targets.forEach((t,i)=>{t.slug=`player-${i}`;});
    const fetcher=vi.fn(async(request:LineupSortValuesRequest)=>response(request));hydrator=new LineupSortHydrator(fetcher);
    const first=hydrator.hydrate(grid,targets.slice(0,1));await vi.advanceTimersByTimeAsync(10);
    const rest=hydrator.hydrate(grid,targets.slice(1));await vi.advanceTimersByTimeAsync(0);await Promise.all([first,rest]);
    expect(fetcher).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls[0]![0].slugs).toHaveLength(50);
  });

  it('cancels during the coalescing delay without starting a request',async()=>{
    vi.useFakeTimers();const {grid,targets}=pool(1);
    const fetcher=vi.fn(async(request:LineupSortValuesRequest)=>response(request));hydrator=new LineupSortHydrator(fetcher);
    const pending=hydrator.hydrate(grid,targets);await vi.advanceTimersByTimeAsync(10);
    hydrator.cancel();await vi.advanceTimersByTimeAsync(100);await pending;
    expect(fetcher).not.toHaveBeenCalled();
  });
});
