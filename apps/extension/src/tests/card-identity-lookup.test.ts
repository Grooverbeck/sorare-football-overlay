import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {CardIdentityLookup} from '../card-identity-lookup.js';
import {findUnknownCardPictures,findCardTargets,hydrateCardPictureNames,hydrateCardPictureSlugs} from '../dom.js';
import {handleMessage} from '../service-worker.js';
import {CARD_PICTURE_SLUGS_KEY} from '../settings.js';
import type {CardIdentitiesResponse} from '@sorare-overlay/shared';

const id='70f9f242-6638-4505-bf9d-9d8c40fe811a';
const second='f0c4cd43-4ff1-4205-9ed2-01f97961c95d';
const card=(pictureId=id)=>`<button><div style="--mask-shape:url(https://assets.sorare.com/cardsamplepicture/${pictureId}/picture/a.png)"></div></button>`;
let lookup:CardIdentityLookup|undefined;
beforeEach(()=>{vi.useFakeTimers();hydrateCardPictureNames({});hydrateCardPictureSlugs({});document.body.innerHTML=card();Object.defineProperty(document,'hidden',{configurable:true,value:false});});
afterEach(()=>{lookup?.stop();lookup=undefined;vi.useRealTimers();vi.unstubAllGlobals();document.body.replaceChildren();});

it('recognizes a never-seen video edition without a name, local seed or card click',async()=>{
  const fetcher=vi.fn(async()=>({data:[{pictureId:id,playerSlug:'brand-new-player'}],retryAfterSeconds:300}));
  const resolved=vi.fn(slugs=>hydrateCardPictureSlugs(slugs));
  lookup=new CardIdentityLookup(resolved,fetcher);lookup.start();
  expect(findCardTargets(document)).toEqual([]);
  lookup.add(findUnknownCardPictures(document));
  await vi.advanceTimersByTimeAsync(100);
  expect(fetcher).toHaveBeenCalledWith([id]);
  expect(findCardTargets(document)).toMatchObject([{slug:'brand-new-player'}]);
});
it('deduplicates copies and batches up to 100 IDs',async()=>{
  document.body.innerHTML=card()+card()+card(second);
  const fetcher=vi.fn(async()=>({data:[],retryAfterSeconds:300}));
  lookup=new CardIdentityLookup(vi.fn(),fetcher);lookup.start();
  lookup.add(findUnknownCardPictures(document));lookup.add(findUnknownCardPictures(document));
  await vi.advanceTimersByTimeAsync(100);
  expect(fetcher.mock.calls).toEqual([[[id,second]]]);
  await vi.advanceTimersByTimeAsync(299999);expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);expect(fetcher).toHaveBeenCalledTimes(2);
});
it('does not query known, ambiguous or removed cards',async()=>{
  document.body.innerHTML=`<button>${card().replaceAll('<button>','').replaceAll('</button>','')}${card(second).replaceAll('<button>','').replaceAll('</button>','')}</button>`;
  expect(findUnknownCardPictures(document)).toEqual([]);
  document.body.innerHTML=card();hydrateCardPictureNames({[id]:'Already Known'});
  expect(findUnknownCardPictures(document)).toEqual([]);
  hydrateCardPictureNames({});
  const fetcher=vi.fn();lookup=new CardIdentityLookup(vi.fn(),fetcher);lookup.start();lookup.add(findUnknownCardPictures(document));
  document.body.replaceChildren();await vi.advanceTimersByTimeAsync(100);
  expect(fetcher).not.toHaveBeenCalled();
});
it('does not poll while disabled or hidden and backs off after failures',async()=>{
  const fetcher=vi.fn().mockRejectedValue(new Error('offline'));
  lookup=new CardIdentityLookup(vi.fn(),fetcher);lookup.add(findUnknownCardPictures(document));
  await vi.advanceTimersByTimeAsync(1000);expect(fetcher).not.toHaveBeenCalled();
  lookup.start();lookup.add(findUnknownCardPictures(document));
  Object.defineProperty(document,'hidden',{configurable:true,value:true});
  await vi.advanceTimersByTimeAsync(100);expect(fetcher).not.toHaveBeenCalled();
  Object.defineProperty(document,'hidden',{configurable:true,value:false});
  await vi.advanceTimersByTimeAsync(300000);expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10000);expect(fetcher).toHaveBeenCalledTimes(1);
  lookup.stop();await vi.advanceTimersByTimeAsync(300000);expect(fetcher).toHaveBeenCalledTimes(1);
});
it('ignores unrelated or late results after stopping',async()=>{
  let resolve!:(value:CardIdentitiesResponse)=>void;
  const fetcher=vi.fn(()=>new Promise<CardIdentitiesResponse>(done=>{resolve=done;}));
  const resolved=vi.fn();lookup=new CardIdentityLookup(resolved,fetcher);lookup.start();lookup.add(findUnknownCardPictures(document));
  await vi.advanceTimersByTimeAsync(100);lookup.stop();
  resolve({data:[{pictureId:id,playerSlug:'some-player'}],retryAfterSeconds:300});
  await vi.advanceTimersByTimeAsync(1);expect(resolved).not.toHaveBeenCalled();
});
it('the background worker stores only requested server-confirmed identities for all tabs',async()=>{
  const set=vi.fn(async()=>{});
  vi.stubGlobal('chrome',{storage:{local:{get:vi.fn(async()=>({})),set}}});
  const fetchImpl=vi.fn<typeof fetch>(async()=>Response.json({data:[{pictureId:id,playerSlug:'new-player'}],retryAfterSeconds:300}));
  const message={type:'FETCH_CARD_IDENTITIES' as const,requestId:'catalog-test',payload:{pictureIds:[id]}};
  const response=await handleMessage(message,{url:'https://sorare.com/football'},{apiBaseUrl:'https://overlay.example',fetchImpl});
  expect(response.ok).toBe(true);
  expect(set).toHaveBeenCalledWith({[CARD_PICTURE_SLUGS_KEY]:{[id]:'new-player'}});
  expect(fetchImpl).toHaveBeenCalledWith('https://overlay.example/api/card-identities',expect.objectContaining({method:'POST'}));
  fetchImpl.mockResolvedValueOnce(Response.json({data:[{pictureId:second,playerSlug:'wrong'}],retryAfterSeconds:300}));
  expect(await handleMessage(message,{url:'https://sorare.com/football'},{apiBaseUrl:'https://overlay.example',fetchImpl})).toMatchObject({ok:false,error:{code:'INVALID_BACKEND_RESPONSE'}});
  expect(set).toHaveBeenCalledTimes(1);
});
