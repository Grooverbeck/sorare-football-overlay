import { afterEach, expect, it, vi } from 'vitest';
import { handleMessage } from '../service-worker.js';
import { CARD_PICTURE_NAMES_KEY, CARD_PICTURE_SLUGS_KEY } from '../settings.js';

afterEach(() => vi.unstubAllGlobals());

it('merges simultaneous discoveries from separate tabs without losing older identities', async () => {
  let stored: Record<string, unknown> = {[CARD_PICTURE_SLUGS_KEY]: {'old-picture':'old-player'}};
  const get = vi.fn(async () => {
    const snapshot = structuredClone(stored);
    await Promise.resolve();
    return snapshot;
  });
  const set = vi.fn(async (updates: Record<string,unknown>) => {stored={...stored,...structuredClone(updates)};});
  vi.stubGlobal('chrome',{storage:{local:{get,set}}});
  const fetchImpl = vi.fn<typeof fetch>();
  const send = (id:string,slug:string) => handleMessage({type:'REMEMBER_CARD_PICTURES',requestId:id,payload:{slugs:{[id]:slug}}},
    {url:'https://sorare.com/football/series/squad/lineups/step'},{fetchImpl});
  const replies = await Promise.all([send('picture-a','player-a'),send('picture-b','player-b')]);
  expect(replies.every(reply=>reply.ok)).toBe(true);
  expect(stored[CARD_PICTURE_SLUGS_KEY]).toEqual({'old-picture':'old-player','picture-a':'player-a','picture-b':'player-b'});
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('recovers after storage failure and bounds the remembered pictures', async () => {
  const get = vi.fn().mockResolvedValue({[CARD_PICTURE_NAMES_KEY]:Object.fromEntries(Array.from({length:2000},(_,i)=>[`old-${i}`,'Old Player']))});
  const set = vi.fn().mockRejectedValueOnce(new Error('storage busy')).mockResolvedValue(undefined);
  vi.stubGlobal('chrome',{storage:{local:{get,set}}});
  const message = {type:'REMEMBER_CARD_PICTURES' as const,requestId:'save',payload:{names:{'new-picture':'New Player'}}};
  const sender = {url:'https://sorare.com/football'};
  expect(await handleMessage(message,sender)).toMatchObject({ok:false,error:{code:'STORAGE_ERROR'}});
  expect(await handleMessage(message,sender)).toMatchObject({ok:true});
  const result = set.mock.calls.at(-1)![0][CARD_PICTURE_NAMES_KEY];
  expect(Object.keys(result)).toHaveLength(2000);
  expect(result['new-picture']).toBe('New Player');
  expect(result['old-0']).toBeUndefined();
});

it('rejects foreign senders and malformed identities without reading storage', async () => {
  const get = vi.fn();
  vi.stubGlobal('chrome',{storage:{local:{get,set:vi.fn()}}});
  const valid = {type:'REMEMBER_CARD_PICTURES' as const,requestId:'save',payload:{slugs:{'picture-1':'player-one'}}};
  expect(await handleMessage(valid,{url:'https://example.com/'})).toMatchObject({ok:false,error:{code:'FORBIDDEN'}});
  expect(await handleMessage({...valid,payload:{slugs:{'picture-1':'not a slug'}}},{url:'https://sorare.com/football'}))
    .toMatchObject({ok:false,error:{code:'INVALID_REQUEST'}});
  expect(get).not.toHaveBeenCalled();
});
