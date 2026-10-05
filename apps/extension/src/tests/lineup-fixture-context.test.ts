import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {fixtureStatusKey,lineupSortValueForPlayer,type PlayerStats,type PlayerStatsSuccessResponse,type LineupSortValuesSuccessResponse} from '@sorare-overlay/shared';
import {visibleFixtureContextDecision} from '../lineup-fixture-context.js';
import {fixtureIdentityAttribute,retiredFixtureAttribute} from '../fixture-refresh.js';
import {OverlayView} from '../overlay.js';
import {StatsBatchCoordinator} from '../scanner.js';
import {LineupSortHydrator} from '../lineup-sort-hydrator.js';

const now=Date.parse('2032-10-05T10:00:00Z');
const club:PlayerStats={slug:'test-player',displayName:'Test Player',position:'Defender',aaL10:{value:6,sampleSize:10},
  aaContext:{kind:'club',teamSlug:'barcelona',state:'ready'},goalL10:{value:.1,sampleSize:10},cleanSheetL10:{value:.3,sampleSize:10},excludedLowCoverage:0,
  nextGame:{date:'2032-10-10T16:30:00Z',homeTeamSlug:'barcelona',awayTeamSlug:'getafe',playerTeamSlug:'barcelona',homeTeamName:'Barcelona',awayTeamName:'Getafe',playerTeamName:'Barcelona',opponentTeamName:'Getafe',cleanSheetProbability:.6,matchProbabilities:null}};
const national:PlayerStats={...club,aaL10:{value:18,sampleSize:10},aaContext:{kind:'national',teamSlug:'france',state:'ready'},aaClub:{aaL10:club.aaL10},
  nextGame:{date:'2032-10-05T18:45:00Z',homeTeamSlug:'france',awayTeamSlug:'belgium',playerTeamSlug:'france',homeTeamName:'France',awayTeamName:'Belgium',playerTeamName:'France',opponentTeamName:'Belgium',cleanSheetProbability:.38,matchProbabilities:{win:.63,draw:.21,loss:.16},
    marketOdds:{source:'odds-api-io',capturedAt:'2032-10-05T09:00:00Z',goal:{probability:.12,bookmakerCount:1},assist:{probability:.19,bookmakerCount:1}}}};
const key=(stats:PlayerStats)=>fixtureStatusKey(stats.nextGame!)!;
const views:OverlayView[]=[];
function markup(home='france',away='belgium') {
  document.body.innerHTML=`<section data-grid><div><button data-card data-position="Defender"><a href="/football/players/test-player"><img alt="Test Player - common"></a></button>
    <div data-team-row><span aria-label="Team" class="highlighted"><img alt="${home}">${home}</span><span aria-label="Team"><img alt="${away}">${away}</span></div></div></section>`;
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(10,10,140,230));
  return document.querySelector<HTMLElement>('[data-card]')!;
}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(now);window.history.replaceState({},'', '/de/football/series/squad/compose/test');});
afterEach(()=>{for(const v of views.splice(0))v.destroy();document.body.replaceChildren();vi.useRealTimers();vi.restoreAllMocks();});

it('permits an earlier confirmed national fixture only when its exact pair and player side match the local row',()=>{
  const card=markup();expect(visibleFixtureContextDecision(card,key(national),key(club),'france')).toBe('correct-context');
  expect(visibleFixtureContextDecision(card,key(club),key(national),'barcelona')).toBe('retain-context');
});
it('also corrects a stale national fixture when the visible row has switched back to the club',()=>{
  const card=markup('barcelona','getafe');
  const earlier={...club,nextGame:{...club.nextGame!,date:'2032-10-05T18:45:00Z'}};
  const later={...national,nextGame:{...national.nextGame!,date:'2032-10-10T18:45:00Z'}};
  expect(visibleFixtureContextDecision(card,key(earlier),key(later),'barcelona')).toBe('correct-context');
});
it.each(['wrong-opponent','wrong-player-side','missing-membership','youth-team','ambiguous-row','finished','same-pair'])('does not relax chronology for uncertain or already old context: %s',kind=>{
  const card=markup();let incoming=key(national),current=key(club),team:string|undefined='france';
  if(kind==='wrong-opponent')incoming=incoming.replace('belgium','germany');
  if(kind==='wrong-player-side')team='belgium';
  if(kind==='missing-membership')team=undefined;
  if(kind==='youth-team'){incoming=incoming.replace(':france:',':france-under-21:');team='france-under-21';}
  if(kind==='ambiguous-row')document.querySelectorAll('[aria-label="Team"]')[1]!.classList.add('highlighted');
  if(kind==='finished')incoming=key({...national,nextGame:{...national.nextGame!,date:new Date(now-2*3_600_000-1).toISOString()}});
  if(kind==='same-pair')current=key({...national,nextGame:{...national.nextGame!,date:'2032-10-10T18:45:00Z'}});
  expect(visibleFixtureContextDecision(card,incoming,current,team)).toBe('none');
});
it('requires a single local team row rather than borrowing a neighboring card context',()=>{
  const card=markup();document.querySelector('[data-team-row]')!.remove();
  expect(visibleFixtureContextDecision(card,key(national),key(club),'france')).toBe('none');
});
it('updates visible CS, AA and this player’s own markets together, then refuses a late future club response',()=>{
  const card=markup(),view=new OverlayView(card,{slug:'test-player'},'Defender');views.push(view);
  view.render(club);expect(card.getAttribute('data-sorare-overlay-clean-sheet-sort-probability')).toBeNull();
  view.render(national);
  expect(card.getAttribute(fixtureIdentityAttribute)).toBe(key(national));
  expect(card.getAttribute('data-sorare-overlay-clean-sheet-sort-probability')).toBe('0.38');
  expect(card.getAttribute('data-sorare-overlay-aa-sort-value')).toBe('18');
  expect(view.host.shadowRoot!.querySelector('[data-market="goal"]')?.textContent).toBe('12%');
  expect(view.host.shadowRoot!.querySelector('[data-market="assist"]')?.textContent).toBe('19%');
  view.render(club);
  expect(card.getAttribute(fixtureIdentityAttribute)).toBe(key(national));
  expect(card.getAttribute('data-sorare-overlay-clean-sheet-sort-probability')).toBe('0.38');
});
it('never revives an explicitly retired game even if the displayed pair still matches',()=>{
  const card=markup(),view=new OverlayView(card,{slug:'test-player'},'Defender');views.push(view);
  view.render(club);card.setAttribute(retiredFixtureAttribute,key(national));view.render(national);
  expect(card.getAttribute(fixtureIdentityAttribute)).toBe(key(club));
});
it('corrects the coordinator cache automatically without F5 and retains that context on a delayed club answer',async()=>{
  const card=markup(),view=new OverlayView(card,{slug:'test-player'},'Defender');views.push(view);
  let calls=0;
  const fetcher=vi.fn(async():Promise<PlayerStatsSuccessResponse>=>{
    const stats=calls++===0?{...club,fixtureRefresh:{key:key(club),nextCheckAt:new Date(now+1000).toISOString()}}:national;
    return {data:[stats],meta:{requested:1,returned:1,cacheHits:1,source:'sorare'}};
  });
  const coordinator=new StatsBatchCoordinator(fetcher,0),target={container:card,slug:'test-player',position:'Defender' as const,teamSlug:'france'};
  try {
    coordinator.enqueue(target,view,1);await coordinator.flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(card.getAttribute('data-sorare-overlay-clean-sheet-sort-probability')).toBe('0.38');
    const internals=coordinator as unknown as {mergeWithCachedStats(stats:PlayerStats,batch:Array<{slug:string;views:Set<OverlayView>;priority:number}>):PlayerStats};
    const merged=internals.mergeWithCachedStats(club,[{slug:'test-player',views:new Set([view]),priority:1}]);
    expect(merged.nextGame?.playerTeamSlug).toBe('france');expect(merged.aaContext?.kind).toBe('national');
  } finally {coordinator.releaseView(view);}
});
it('applies the same correction to offscreen compact CS sorting and rejects a late future club value',async()=>{
  const card=markup(),grid=document.querySelector<HTMLElement>('[data-grid]')!;
  const trigger=document.createElement('span');trigger.setAttribute('data-sorare-overlay-lineup-sort-trigger-label','true');document.body.append(trigger);
  card.setAttribute(fixtureIdentityAttribute,key(club));
  let calls=0;
  const fetcher=vi.fn(async():Promise<LineupSortValuesSuccessResponse>=>({
    data:[calls++===0?{...lineupSortValueForPlayer(national),fixtureRefresh:{key:key(national),nextCheckAt:new Date(now+1000).toISOString()}}:lineupSortValueForPlayer(club)],
    meta:{requested:1,returned:1,cacheHits:1,source:'sorare',durationMs:1},
  }));
  const hydrator=new LineupSortHydrator(fetcher,50,undefined,0);hydrator.configureMode('clean-sheet');
  try {
    await hydrator.hydrate(grid,[{container:card,slug:'test-player',position:'Defender',teamSlug:'france'}]);
    expect(card.getAttribute(fixtureIdentityAttribute)).toBe(key(national));
    expect(card.getAttribute('data-sorare-overlay-clean-sheet-sort-probability')).toBe('0.38');
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(card.getAttribute(fixtureIdentityAttribute)).toBe(key(national));
    expect(card.getAttribute('data-sorare-overlay-clean-sheet-sort-probability')).toBe('0.38');
  } finally {hydrator.stop();}
});
