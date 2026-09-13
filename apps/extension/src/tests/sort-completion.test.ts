import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LineupSortValue, LineupSortValuesRequest, LineupSortValuesSuccessResponse } from '@sorare-overlay/shared';
import { LineupSortValuesRequestSchema } from '@sorare-overlay/shared';
import { LineupSortHydrator } from '../lineup-sort-hydrator.js';
import { readSortReadiness, setSortReadiness, sortFinalCheckAttribute } from '../lineup-sort-readiness.js';

let hydrator: LineupSortHydrator | undefined;
afterEach(() => { hydrator?.stop(); hydrator = undefined; document.body.replaceChildren(); vi.useRealTimers(); });
function grid(count: number) {
  document.body.innerHTML = `<main><section id="pool">${Array.from({length:count},(_,i)=>`<div><article data-position="Forward"><a href="/football/players/test-player-${i}"><img alt="Test Player ${i} - common"></a></article></div>`).join('')}</section></main>`;
  return document.querySelector<HTMLElement>('#pool')!;
}
const targets = (pool: HTMLElement) => [...pool.querySelectorAll<HTMLElement>('article')].map((container,i) => ({container,slug:`test-player-${i}`,playerName:`Test Player ${i}`,position:'Forward' as const}));
function response(request: LineupSortValuesRequest, build: (slug: string) => Partial<LineupSortValue>): LineupSortValuesSuccessResponse {
  // Exercise the real wire contract, not just the number of internal states.
  LineupSortValuesRequestSchema.parse(request);
  return {data:(request.slugs ?? []).map(slug=>({slug,displayName:slug,position:'Forward',goal:{probability:.4,source:'historical'},aa:10,cleanSheet:null,
    readiness:{goal:'ready',aa:'ready',cleanSheet:'unavailable'},...build(slug)})),meta:{requested:request.slugs?.length??0,returned:request.slugs?.length??0,cacheHits:0,source:'sorare',durationMs:1}};
}

describe('honest sort completion', () => {
  it('continues newly partial full-overlay data without waiting for another visibility event', async () => {
    const pool=grid(1), fetcher=vi.fn(async(req:LineupSortValuesRequest)=>response(req,()=>({})));
    hydrator=new LineupSortHydrator(fetcher);
    await hydrator.hydrate(pool, targets(pool));
    const card=pool.querySelector('article')!;
    card.removeAttribute('data-sorare-overlay-sort-lightweight-ready');
    setSortReadiness(card,{goal:'pending',aa:'ready',cleanSheet:'unavailable'});
    await vi.waitFor(()=>expect(readSortReadiness(card)?.goal).toBe('ready'));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('finishes all 638 offscreen histories and a final cache pass without visibility events', async () => {
    vi.useFakeTimers();
    const pool=grid(638),seen=new Map<string,number>();
    const fetcher=vi.fn(async(request:LineupSortValuesRequest)=>response(request,slug=>{
      const count=(seen.get(slug)??0)+1;seen.set(slug,count);
      return count===1?{goal:null,aa:null,readiness:{goal:'pending',aa:'pending',cleanSheet:'unavailable'}}:{};
    }));
    hydrator=new LineupSortHydrator(fetcher,50,[10,20]);
    await hydrator.hydrate(pool, targets(pool)); hydrator.finalizePool(pool);
    expect(pool.getAttribute(sortFinalCheckAttribute)).toBe('pending');
    expect([...pool.querySelectorAll('article')].every(c=>readSortReadiness(c)?.goal==='pending')).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(pool.getAttribute(sortFinalCheckAttribute)).toBe('complete');
    expect([...pool.querySelectorAll('article')].every(c=>readSortReadiness(c)?.goal==='ready'&&c.getAttribute('data-sorare-overlay-goal-sort-probability')==='0.4')).toBe(true);
    expect(seen.size).toBe(638);
    expect([...seen.values()].every(n=>n===3)).toBe(true);
    expect(fetcher.mock.calls.every(([request])=>(request.slugs?.length??0)<=50)).toBe(true);
    expect(fetcher.mock.calls.every(([request])=>(request.slugs?.length??0)+(request.playerNames?.length??0)<=50)).toBe(true);
    expect(fetcher.mock.calls.every(([request])=>request.playerNames?.length===0)).toBe(true);
  }, 15_000);

  it('does not wait for AA history when the selected goal market is already complete', async () => {
    const pool=grid(1);
    hydrator=new LineupSortHydrator(async req=>response(req,()=>({goal:{probability:.5,source:'market'},aa:null,readiness:{goal:'ready',aa:'pending',cleanSheet:'unavailable'}})));
    await hydrator.hydrate(pool, targets(pool));hydrator.finalizePool(pool);
    expect(pool.getAttribute(sortFinalCheckAttribute)).toBe('complete');
    expect(readSortReadiness(pool.querySelector('article')!)?.goal).toBe('ready');
  });

  it('does not classify exhausted partial data as unavailable, and permits an explicit retry', async () => {
    const pool=grid(1);let complete=false;
    hydrator=new LineupSortHydrator(async req=>response(req,()=>complete?{}:{goal:null,readiness:{goal:'pending',aa:'ready',cleanSheet:'unavailable'}}),50,[]);
    await hydrator.hydrate(pool, targets(pool));hydrator.finalizePool(pool);
    expect(readSortReadiness(pool.querySelector('article')!)?.goal).toBe('error');
    expect(pool.querySelector('article')!.getAttribute('data-sorare-overlay-sort-data-ready')).toBe('false');
    complete=true;hydrator.retryOpenValues();
    await vi.waitFor(()=>expect(pool.getAttribute(sortFinalCheckAttribute)).toBe('complete'));
    expect(readSortReadiness(pool.querySelector('article')!)?.goal).toBe('ready');
  });

  it('leaves an absent response record as an error instead of a genuine data gap', async () => {
    const pool=grid(1);
    hydrator=new LineupSortHydrator(async()=>({data:[],meta:{requested:1,returned:0,cacheHits:0,source:'sorare',durationMs:1}}),50,[]);
    await hydrator.hydrate(pool, targets(pool));
    expect(readSortReadiness(pool.querySelector('article')!)?.goal).toBe('error');
  });

  it('rechecks a reused pool after a new sort session instead of leaving the completion barrier pending', async () => {
    const pool=grid(1),fetcher=vi.fn(async(req:LineupSortValuesRequest)=>response(req,()=>({})));
    hydrator=new LineupSortHydrator(fetcher);
    await hydrator.hydrate(pool, targets(pool));hydrator.finalizePool(pool);
    await vi.waitFor(()=>expect(pool.getAttribute(sortFinalCheckAttribute)).toBe('complete'));
    hydrator.finalizePool(pool);
    await vi.waitFor(()=>expect(pool.getAttribute(sortFinalCheckAttribute)).toBe('complete'));
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('keeps a real zero distinct from pending or missing data', async () => {
    const pool=grid(1);
    hydrator=new LineupSortHydrator(async req=>response(req,()=>({goal:{probability:0,source:'historical'}})));
    await hydrator.hydrate(pool, targets(pool));
    const card=pool.querySelector('article')!;
    expect(card.getAttribute('data-sorare-overlay-goal-sort-probability')).toBe('0');
    expect(readSortReadiness(card)?.goal).toBe('ready');
  });

  it('sends one wire identity for learned cards in a mixed slug/name-only batch', async () => {
    const pool=grid(50);
    const mixed=targets(pool).map((t,i)=>i<25?t:{container:t.container,playerName:t.playerName,position:t.position});
    const fetcher=vi.fn(async(request:LineupSortValuesRequest)=>{
      LineupSortValuesRequestSchema.parse(request);
      expect(request.slugs).toHaveLength(25);expect(request.playerNames).toHaveLength(25);
      const all=[...(request.slugs??[]),...(request.playerNames??[]).map(name=>name.toLowerCase().replaceAll(' ','-'))];
      return response({slugs:all},slug=>({displayName:slug.replaceAll('-',' ')}));
    });
    hydrator=new LineupSortHydrator(fetcher);
    await hydrator.hydrate(pool,mixed);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect([...pool.querySelectorAll('article')].every(card=>readSortReadiness(card)?.goal==='ready')).toBe(true);
  });
});
