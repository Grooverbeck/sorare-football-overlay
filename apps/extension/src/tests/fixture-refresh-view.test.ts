import {expect,it,vi} from 'vitest';
import {fixtureStatusKey,type PlayerStats,type PlayerStatsSuccessResponse} from '@sorare-overlay/shared';
import {StatsBatchCoordinator} from '../scanner.js';
import {OverlayView} from '../overlay.js';

it('updates a visible bracket automatically and ignores a late old fixture',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2032-01-01T22:00:00Z'));
  document.body.innerHTML='<article><img alt="Test Player - common"></article>';
  const card=document.querySelector('article')!;
  vi.spyOn(card,'getBoundingClientRect').mockReturnValue(new DOMRect(10,10,130,210));
  const old:PlayerStats={slug:'test-player',displayName:'Test Player',position:'Defender',aaL10:{value:20,sampleSize:10},goalL10:{value:0.1,sampleSize:10},cleanSheetL10:{value:0.4,sampleSize:10},excludedLowCoverage:0,
    nextGame:{date:'2032-01-01T19:00:00Z',homeTeamSlug:'home',awayTeamSlug:'away',cleanSheetProbability:0.4,matchProbabilities:null}};
  old.fixtureRefresh={key:fixtureStatusKey(old.nextGame!)!,nextCheckAt:new Date(Date.now()+1000).toISOString()};
  const next:PlayerStats={...old,nextGame:{...old.nextGame!,date:'2032-01-04T19:00:00Z',awayTeamSlug:'next',cleanSheetProbability:0.6}};
  next.fixtureRefresh={key:fixtureStatusKey(next.nextGame!)!,nextCheckAt:new Date(Date.now()+3_600_000).toISOString()};
  let calls=0;
  const fetcher=vi.fn(async():Promise<PlayerStatsSuccessResponse>=>({data:[calls++===0?old:next],meta:{requested:1,returned:1,cacheHits:1,source:'sorare'}}));
  const coordinator=new StatsBatchCoordinator(fetcher,0);
  const view=new OverlayView(card,{slug:'test-player'},'Defender');
  try {
    coordinator.enqueue({container:card,slug:'test-player',position:'Defender'},view,1);
    await coordinator.flush();
    expect(card.getAttribute('data-sorare-overlay-clean-sheet-sort-probability')).toBe('0.4');
    view.render({...old,nextGame:null,pendingRefreshes:['fixture']});
    view.render(old);
    expect(card.getAttribute('data-sorare-overlay-clean-sheet-sort-probability')).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(card.getAttribute('data-sorare-overlay-clean-sheet-sort-probability')).toBe('0.6');
    expect(card.getAttribute('data-sorare-overlay-aa-sort-value')).toBe('20');
    view.render(old);
    expect(card.getAttribute('data-sorare-overlay-clean-sheet-sort-probability')).toBe('0.6');
  } finally {coordinator.releaseView(view);view.destroy();document.body.replaceChildren();vi.useRealTimers();vi.restoreAllMocks();}
});
