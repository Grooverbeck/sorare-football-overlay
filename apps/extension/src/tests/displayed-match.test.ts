import {describe,it,expect,vi,afterEach} from 'vitest';
import {displayedMatchKey,type PlayerStats,type PlayerStatsRequest} from '@sorare-overlay/shared';
import {readDisplayedMatch} from '../displayed-match.js';
import {playerTargetKey} from '../player-identity.js';
import {findCardTargets} from '../dom.js';
import {OverlayView} from '../overlay.js';
import {StatsBatchCoordinator} from '../scanner.js';

const hint={home:'country:gr',away:'country:de',phase:'live' as const,homeScore:0,awayScore:1};
function markup() {
  window.history.replaceState({},'', '/de/football/series/squad/lineups/BoardStep:test');
  document.body.innerHTML='<section><button data-position="Midfielder"><img alt="Lennart Karl - common" src="https://assets.sorare.com/cardsamplepicture/001/picture/card.png"></button><footer><span style="border-color:var(--c-red-300)"></span><span>41</span><div><img alt="" src="https://frontend-assets.sorare.com/image-resize/flags/gr.svg?width=40"><span>0 - 1</span><img alt="" src="https://frontend-assets.sorare.com/image-resize/flags/de.svg?width=40"></div></footer></section>';
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(10,10,140,230));
  return document.querySelector('button')!;
}
afterEach(()=>{document.body.replaceChildren();vi.restoreAllMocks();});
describe('displayed match context',()=>{
  it('reads the match score without including the adjacent player score and separates it from compose-team',()=>{
    const card=markup();expect(readDisplayedMatch(card)).toEqual(hint);
    expect(findCardTargets(document)[0]?.displayedMatch).toEqual(hint);
    window.history.replaceState({},'', '/de/football/series/test/compose-team');expect(readDisplayedMatch(card)).toBeUndefined();
  });
  it('keeps live scope stable when scores change, while completed scopes and future-player keys stay separate',()=>{
    markup();const target={slug:'lennart-karl',position:'Midfielder' as const};
    expect(playerTargetKey({...target,displayedMatch:hint})).not.toBe(playerTargetKey(target));
    expect(displayedMatchKey(hint)).toBe(displayedMatchKey({...hint,awayScore:2}));
    expect(displayedMatchKey(hint)).not.toBe(displayedMatchKey({...hint,phase:'played'}));
  });
  it('does not infer nationality from card flags, ambiguous footers or arbitrary image hosts',()=>{
    const card=markup();document.querySelector('footer img')!.setAttribute('src','https://example.com/flags/gr.svg');expect(readDisplayedMatch(card)).toBeUndefined();
    document.querySelector('footer')!.remove();card.insertAdjacentHTML('beforeend','<img src="https://frontend-assets.sorare.com/flags/de.svg">');expect(readDisplayedMatch(card)).toBeUndefined();
  });
  it('keeps a confirmed game when its live score becomes final, but never carries that ID into another lineup page',()=>{
    const card=markup(),gameId='Game:00000000-0000-0000-0000-000000000001';
    card.setAttribute('data-sorare-overlay-displayed-fixture',JSON.stringify({key:displayedMatchKey(hint),state:'confirmed',gameId,viewPath:location.pathname}));
    document.querySelector('[style*="--c-red-300"]')!.remove();
    expect(readDisplayedMatch(card)?.gameId).toBe(gameId);
    window.history.replaceState({},'', '/de/football/series/squad/lineups/BoardStep:other');
    expect(readDisplayedMatch(card)?.gameId).toBeUndefined();
  });
  it('sends visible context in the ordinary batched stats request and renders an older confirmed game instead of rejecting it as stale',async()=>{
    const card=markup();const stats:PlayerStats={slug:'lennart-karl',displayName:'Lennart Karl',position:'Midfielder',aaL10:{value:6.4,sampleSize:10},goalL10:{value:0.2,sampleSize:10},cleanSheetL10:{value:0,sampleSize:0},excludedLowCoverage:0,nextGame:{date:'2026-10-10T13:30:00Z',homeTeamSlug:'augsburg',awayTeamSlug:'bayern',playerTeamSlug:'bayern',cleanSheetProbability:null,matchProbabilities:null}};
    const view=new OverlayView(card,{playerName:'Lennart Karl'},'Midfielder');
    const fetcher=vi.fn(async(request:PlayerStatsRequest)=>{
      expect(request.displayedMatches?.['Lennart Karl']).toEqual(hint);
      return {data:[{...stats,aaL10:{value:12,sampleSize:4},displayedFixture:{key:displayedMatchKey(hint),state:'confirmed' as const,gameId:'Game:00000000-0000-0000-0000-000000000001'},nextGame:{...stats.nextGame!,date:'2026-10-04T18:45:00Z',homeTeamSlug:'greece',awayTeamSlug:'germany',playerTeamSlug:'germany',marketOdds:{source:'odds-api-io' as const,capturedAt:'2026-10-04T18:30:00Z',goal:{probability:0.30357,bookmakerCount:2},assist:{probability:0.2,bookmakerCount:1}}}}],meta:{requested:1,returned:1,cacheHits:1,source:'sorare' as const}};
    });
    const coordinator=new StatsBatchCoordinator(fetcher,0);
    try {
      view.render(stats);coordinator.enqueue({container:card,playerName:'Lennart Karl',position:'Midfielder',displayedMatch:hint},view,1);await coordinator.flush();
      expect(view.host.shadowRoot?.querySelector('[data-market="goal"]')?.textContent).toBe('30%');
      expect(view.host.shadowRoot?.querySelector('[data-market="assist"]')?.textContent).toBe('20%');
    } finally {coordinator.releaseView(view);view.destroy();}
  });
});
