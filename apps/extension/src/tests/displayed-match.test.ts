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
  it.each(['/de/football/series/my-club/randomrandy','/en/football/series/my-club/another-club'])('reads the local score footer on passive club pages: %s',path=>{
    const card=markup();window.history.replaceState({},'',path);
    expect(readDisplayedMatch(card)).toEqual(hint);
    expect(findCardTargets(document)[0]?.displayedMatch).toEqual(hint);
    const gameId='Game:00000000-0000-0000-0000-000000000001';
    card.setAttribute('data-sorare-overlay-displayed-fixture',JSON.stringify({key:displayedMatchKey(hint),state:'confirmed',gameId,viewPath:path}));
    expect(readDisplayedMatch(card)?.gameId).toBe(gameId);
    window.history.replaceState({},'',path+'/other');
    expect(readDisplayedMatch(card)?.gameId).toBeUndefined();
  });
  it.each(['/de/football/series/my-club/randomrandy/compose-team','/de/football/series/my-club/randomrandy/compose','/de/baseball/series/my-club/randomrandy','/de/football/series/my-club-preview/randomrandy'])('does not broaden displayed-game reads to builders, other sports or similarly named routes: %s',path=>{
    const card=markup();window.history.replaceState({},'',path);
    expect(readDisplayedMatch(card)).toBeUndefined();
  });
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
  it('uses the same confirmed England fixture for club-page teammates while keeping AA and player markets separate',async()=>{
    markup();window.history.replaceState({},'', '/de/football/series/my-club/randomrandy');
    const names=['Lewis Hall','Trent Alexander-Arnold'],slugs=['lewis-hall-2004-09-08','trent-alexander-arnold'];
    document.body.innerHTML=names.map(name=>`<section><button data-position="Defender"><img alt="${name} - common" src="https://assets.sorare.com/cardsamplepicture/test/picture/card.png"></button><footer><span style="border-color:var(--c-red-300)"></span><span>54</span><div><img alt="" src="https://frontend-assets.sorare.com/image-resize/flags/gb-eng.svg?width=40"><span>3 - 0</span><img alt="" src="https://frontend-assets.sorare.com/image-resize/flags/cz.svg?width=40"></div></footer></section>`).join('');
    const england={home:'country:gb-eng',away:'country:cz',phase:'live' as const,homeScore:3,awayScore:0};
    const targets=findCardTargets(document);
    expect(targets).toHaveLength(2);expect(targets.every(t=>displayedMatchKey(t.displayedMatch!)===displayedMatchKey(england))).toBe(true);
    const club:PlayerStats[]=names.map((name,i)=>({slug:slugs[i]!,displayName:name,position:'Defender',aaL10:{value:i?19.5:11.1,sampleSize:10},goalL10:{value:.1,sampleSize:10},cleanSheetL10:{value:.3,sampleSize:10},excludedLowCoverage:0,nextGame:{date:i?'2026-10-10T19:00:00Z':'2026-10-12T19:00:00Z',homeTeamSlug:i?'real-madrid':'coventry',awayTeamSlug:i?'villarreal':'newcastle',playerTeamSlug:i?'real-madrid':'newcastle',cleanSheetProbability:i?.4:.294117647,matchProbabilities:null}}));
    const views=targets.map((t,i)=>new OverlayView(t.container,{playerName:names[i]!},'Defender'));
    const fetcher=vi.fn(async(request:PlayerStatsRequest)=>{
      expect(request.displayedMatches).toEqual(Object.fromEntries(names.map(name=>[name,england])));
      return {data:club.map((p,i)=>({...p,aaL10:{value:20+i,sampleSize:10},aaClub:{aaL10:p.aaL10},aaContext:{kind:'national' as const,teamSlug:'england',state:'ready' as const},displayedFixture:{key:displayedMatchKey(england),state:'confirmed' as const,gameId:'Game:00000000-0000-0000-0000-000000000002'},nextGame:{...p.nextGame!,date:'2026-10-06T18:45:00Z',homeTeamSlug:'england',awayTeamSlug:'czech-republic',playerTeamSlug:'england',cleanSheetProbability:1/1.57,marketOdds:{source:'odds-api-io' as const,capturedAt:'2026-10-06T18:30:00Z',goal:{probability:i?.2:.1,bookmakerCount:1},assist:{probability:i?.17:.03,bookmakerCount:1}}}})),meta:{requested:2,returned:2,cacheHits:2,source:'sorare' as const}};
    });
    const coordinator=new StatsBatchCoordinator(fetcher,0);
    try {
      targets.forEach((t,i)=>{views[i]!.render(club[i]!);coordinator.enqueue(t,views[i]!,1);});
      await coordinator.flush();expect(fetcher).toHaveBeenCalledTimes(1);
      views.forEach((view,i)=>{
        expect(view.host.shadowRoot?.querySelector('.cs-market-icon')?.parentElement?.textContent).toContain('64%');
        expect(view.host.shadowRoot?.querySelector('[data-market="goal"]')?.textContent).toBe(i?'20%':'10%');
        expect(view.host.shadowRoot?.querySelector('[data-market="assist"]')?.textContent).toBe(i?'17%':'3%');
        expect(targets[i]!.container.getAttribute('data-sorare-overlay-aa-sort-value')).toBe(String(20+i));
        expect(targets[i]!.container.getAttribute('data-sorare-overlay-fixture-identity')).toContain(':england:czech-republic');
        view.render(club[i]!);
        expect(targets[i]!.container.getAttribute('data-sorare-overlay-clean-sheet-sort-probability')).toBe(String(1/1.57));
      });
      expect(club[0]!.aaL10.value).toBe(11.1);expect(club[1]!.aaL10.value).toBe(19.5);
      window.history.replaceState({},'', '/de/football/series/test/compose-team');
      views.forEach((view,i)=>{
        view.render(club[i]!);
        expect(targets[i]!.container.getAttribute('data-sorare-overlay-clean-sheet-sort-probability')).toBe(String(club[i]!.nextGame!.cleanSheetProbability));
        expect(targets[i]!.container.hasAttribute('data-sorare-overlay-displayed-context')).toBe(false);
      });
    } finally {views.forEach(view=>{coordinator.releaseView(view);view.destroy();});}
  });
  it('follows a new completed score while rejecting a late response for the previous live scope',()=>{
    const card=markup();window.history.replaceState({},'', '/de/football/series/my-club/randomrandy');
    const view=new OverlayView(card,{playerName:'Lennart Karl'},'Midfielder');
    const live:PlayerStats={slug:'lennart-karl',displayName:'Lennart Karl',position:'Midfielder',aaL10:{value:12,sampleSize:10},goalL10:{value:.2,sampleSize:10},cleanSheetL10:{value:0,sampleSize:0},excludedLowCoverage:0,
      displayedFixture:{key:displayedMatchKey(hint),state:'confirmed',gameId:'Game:00000000-0000-0000-0000-000000000003'},
      nextGame:{date:'2026-10-04T18:45:00Z',homeTeamSlug:'greece',awayTeamSlug:'germany',playerTeamSlug:'germany',cleanSheetProbability:.6,matchProbabilities:null}};
    try {
      view.render(live);
      document.querySelector('[style*="--c-red-300"]')!.remove();
      document.querySelector('footer > div > span')!.textContent='1 - 1';
      view.render({...live,aaL10:{value:99,sampleSize:10}});
      expect(card.getAttribute('data-sorare-overlay-aa-sort-value')).toBe('12');
      const completed={...hint,phase:'played' as const,homeScore:1};
      view.render({...live,aaL10:{value:13,sampleSize:10},displayedFixture:{...live.displayedFixture!,key:displayedMatchKey(completed)}});
      expect(card.getAttribute('data-sorare-overlay-aa-sort-value')).toBe('13');
      expect(card.getAttribute('data-sorare-overlay-displayed-context')).toBe(displayedMatchKey(completed));
    } finally {view.destroy();}
  });
});
