import {afterEach,expect,it,vi} from 'vitest';
import {FixtureRefreshScheduler,olderFixture,type FixtureRefreshHint} from '../fixture-refresh.js';
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
it('groups due encounters, skips hidden tabs and catches up on returning',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2032-01-01T10:00:00Z'));
  let hidden=true;vi.spyOn(document,'visibilityState','get').mockImplementation(()=>hidden?'hidden':'visible');
  let hints:FixtureRefreshHint[]=[{key:'game-one',nextCheckAt:new Date(Date.now()+1000).toISOString()},{key:'game-one',nextCheckAt:new Date(Date.now()+1000).toISOString()}];
  const refresh=vi.fn(async(_keys:ReadonlySet<string>)=>{hints=[];});const scheduler=new FixtureRefreshScheduler(()=>hints,refresh);
  scheduler.schedule();await vi.advanceTimersByTimeAsync(5000);expect(refresh).not.toHaveBeenCalled();
  hidden=false;document.dispatchEvent(new Event('visibilitychange'));await vi.advanceTimersByTimeAsync(250);
  expect(refresh).toHaveBeenCalledTimes(1);expect([...refresh.mock.calls[0]![0]]).toEqual(['game-one']);
  scheduler.stop();
});
it('does not refresh stale pool owners or schedule work after stop',async()=>{
  vi.useFakeTimers();let active=true;
  const refresh=vi.fn(async()=>{});const scheduler=new FixtureRefreshScheduler(()=>active?[{key:'one',nextCheckAt:new Date(Date.now()+1000).toISOString()}]:[],refresh);
  scheduler.schedule();active=false;await vi.advanceTimersByTimeAsync(2000);expect(refresh).not.toHaveBeenCalled();
  active=true;scheduler.schedule();scheduler.stop();await vi.advanceTimersByTimeAsync(3000);expect(refresh).not.toHaveBeenCalled();
});
it('bounds retries while preserving data on a failed refresh',async()=>{
  vi.useFakeTimers();const refresh=vi.fn(async()=>{throw new Error('offline');});
  const scheduler=new FixtureRefreshScheduler(()=>[{key:'one',nextCheckAt:new Date(Date.now()-1000).toISOString()}],refresh);
  scheduler.schedule();await vi.advanceTimersByTimeAsync(250);expect(refresh).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(29_999);expect(refresh).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);expect(refresh).toHaveBeenCalledTimes(2);scheduler.stop();
});
it('recognizes a late old fixture without confusing equal identities',()=>{
  expect(olderFixture('fixture-status:v1:100:a:b','fixture-status:v1:200:a:c')).toBe(true);
  expect(olderFixture('fixture-status:v1:200:a:c','fixture-status:v1:200:a:c')).toBe(false);
});
