import {readFileSync} from 'node:fs';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeMatchOddsReplacement,readNativeMatchOdds} from '../native-match-odds.js';
import {OverlayView} from '../overlay.js';
import type {PlayerStats} from '@sorare-overlay/shared';
import {SorareCardScanner,StatsBatchCoordinator} from '../scanner.js';

const attribute='data-sorare-overlay-native-match-odds';
const hiddenSelector=`:is(button, [role="button"]):has([data-sorare-overlay-companion="lineup-odds"][data-lineup-odds-ready="true"]) + div[${attribute}="true"]`;
const hiddenByRule=(strip:Element)=>strip.matches(hiddenSelector);
const native=(values=[53,24,23])=>`<div data-native><div style="--c-left-color:var(--c-score-medium)">${values.map(value=>`<div><div>${value}</div><svg></svg></div>`).join('')}</div></div>`;
const row=()=>`<div data-team-row><span aria-label="Team" class="highlighted"><img alt="norway">NOR</span><span aria-label="Team"><img alt="denmark">DEN</span></div>`;
const markup=()=>`<section><button data-card><img alt="Keeper - common" src="https://assets.sorare.com/cardsamplepicture/test/picture/card.png"></button><div><button data-stats>${row()}</button>${native()}</div></section>`;
const replacements:NativeMatchOddsReplacement[]=[];
const views:OverlayView[]=[];
const claim=()=>{const item=new NativeMatchOddsReplacement();replacements.push(item);item.update(document.querySelector<HTMLElement>('[data-team-row]')!);return item;};
beforeEach(()=>{document.body.innerHTML=markup();window.history.replaceState({},'', '/de/football/series/test/compose-team');});
afterEach(()=>{for(const view of views.splice(0))view.destroy();for(const item of replacements.splice(0))item.clear();document.body.replaceChildren();vi.useRealTimers();vi.restoreAllMocks();});

it('hides only when a ready own bar is attached and automatically restores on clear/removal',()=>{
  claim();const strip=document.querySelector('[data-native]')!;
  expect(strip.getAttribute(attribute)).toBe('true');expect(hiddenByRule(strip)).toBe(false);
  const host=document.createElement('span');host.dataset.sorareOverlayCompanion='lineup-odds';
  document.querySelector('[data-stats]')!.append(host);
  expect(hiddenByRule(strip)).toBe(false);
  host.dataset.lineupOddsReady='true';expect(hiddenByRule(strip)).toBe(true);
  host.hidden=true;expect(hiddenByRule(strip)).toBe(true);
  delete host.dataset.lineupOddsReady;expect(hiddenByRule(strip)).toBe(false);
  host.dataset.lineupOddsReady='true';host.remove();expect(hiddenByRule(strip)).toBe(false);
  expect(readFileSync('src/sorare-native.css','utf8').replace(/\s+/g,' ')).toContain(`${hiddenSelector} { display: none !important; }`);
});
it('does not hide a neighboring card without its own replacement',()=>{
  document.body.innerHTML=markup()+markup();
  const rows=document.querySelectorAll<HTMLElement>('[data-team-row]');
  const first=claim(),second=new NativeMatchOddsReplacement();replacements.push(second);second.update(rows[1]!);
  document.querySelector('[data-stats]')!.insertAdjacentHTML('beforeend','<span data-sorare-overlay-companion="lineup-odds" data-lineup-odds-ready="true"></span>');
  const strips=document.querySelectorAll('[data-native]');
  expect(hiddenByRule(strips[0]!)).toBe(true);expect(hiddenByRule(strips[1]!)).toBe(false);
  first.clear();expect(strips[0]!.hasAttribute(attribute)).toBe(false);
});
it.each(['bad-total','button','missing-icon','not-odds','wrong-teams'])('leaves unrelated or ambiguous native UI alone: %s',kind=>{
  const strip=document.querySelector<HTMLElement>('[data-native]')!;
  if(kind==='bad-total')strip.innerHTML=strip.innerHTML.replace('53','99');
  if(kind==='button')strip.querySelector('div > div')!.append(document.createElement('button'));
  if(kind==='missing-icon')strip.querySelector('svg')!.remove();
  if(kind==='not-odds')strip.firstElementChild!.removeAttribute('style');
  if(kind==='wrong-teams')document.querySelector('[aria-label="Team"]')!.remove();
  claim();expect(strip.hasAttribute(attribute)).toBe(false);
});
it('transfers ownership safely when a card is remounted',()=>{
  const first=claim(),second=claim();const strip=document.querySelector('[data-native]')!;
  first.clear();expect(strip.hasAttribute(attribute)).toBe(true);
  second.clear();expect(strip.hasAttribute(attribute)).toBe(false);
});
it('recognizes a native bar inserted later and cleans up the replaced element',()=>{
  const first=claim();const old=document.querySelector('[data-native]')!;
  old.outerHTML=native();first.update(document.querySelector('[data-team-row]')!);
  expect(old.hasAttribute(attribute)).toBe(false);
  expect(document.querySelector('[data-native]')!.hasAttribute(attribute)).toBe(true);
});
it('integrates with real overlay lifecycle, including missing probabilities and disable cleanup',()=>{
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){return new DOMRect(20,this.hasAttribute('data-team-row')?235:20,130,this.hasAttribute('data-team-row')?20:210);});
  const stats:PlayerStats={slug:'keeper',displayName:'Keeper',position:'Goalkeeper',aaL10:{value:10,sampleSize:10},goalL10:{value:0,sampleSize:10},cleanSheetL10:{value:0.3,sampleSize:10},excludedLowCoverage:0,
    nextGame:{date:'2040-01-01T18:00:00Z',homeTeamSlug:'norway',awayTeamSlug:'denmark',homeTeamName:'Norway',awayTeamName:'Denmark',playerTeamSlug:'norway',playerTeamName:'Norway',opponentTeamName:'Denmark',cleanSheetProbability:0.38,matchProbabilities:{win:0.53,draw:0.24,loss:0.23}}};
  const view=new OverlayView(document.querySelector('[data-card]')!,{slug:stats.slug},'Goalkeeper');views.push(view);
  view.render(stats);view.reposition();const strip=document.querySelector('[data-native]')!;
  expect(hiddenByRule(strip)).toBe(true);
  view.setViewportPriorityActive(false);expect(hiddenByRule(strip)).toBe(true);
  view.setViewportPriorityActive(true);view.reposition();expect(hiddenByRule(strip)).toBe(true);
  view.render({...stats,nextGame:{...stats.nextGame!,matchProbabilities:null}});view.reposition();
  expect(hiddenByRule(strip)).toBe(true); // Native values are enough, independently of backend readiness.
  view.render(stats);view.reposition();expect(hiddenByRule(strip)).toBe(true);
  view.destroy();expect(strip.hasAttribute(attribute)).toBe(false);
});

function positionCards():void {
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){return new DOMRect(20,this.hasAttribute('data-team-row')?235:20,130,this.hasAttribute('data-team-row')?20:210);});
}
function sample():PlayerStats {
  return {slug:'keeper',displayName:'Keeper',position:'Goalkeeper',aaL10:{value:10,sampleSize:10},goalL10:{value:0,sampleSize:10},cleanSheetL10:{value:0.3,sampleSize:10},aaL10TeamWinRate:{value:0.5,sampleSize:10},excludedLowCoverage:0,
    nextGame:{date:'2032-01-03T18:00:00Z',homeTeamSlug:'norway',awayTeamSlug:'denmark',homeTeamName:'Norway',awayTeamName:'Denmark',playerTeamSlug:'norway',playerTeamName:'Norway',opponentTeamName:'Denmark',cleanSheetProbability:0.38,matchProbabilities:{win:0.79,draw:0.16,loss:0.05}}};
}
function mount():OverlayView {
  const view=new OverlayView(document.querySelector('[data-card]')!,{slug:'keeper'},'Goalkeeper');views.push(view);return view;
}
function own():HTMLElement {
  return document.querySelector<HTMLElement>('[data-sorare-overlay-companion="lineup-odds"]')!;
}
const values=()=>[...own().shadowRoot!.querySelectorAll('.lineup-odd')].map(n=>n.textContent);
function updateNative(numbers:number[]):void {
  const cells=document.querySelector('[data-native]')!.firstElementChild!.children;
  numbers.forEach((number,i)=>{cells[i]!.firstElementChild!.firstChild!.textContent=String(number);});
}

it('shows local Sorare values before any backend response and keeps them during loading, failure and no-data states',()=>{
  positionCards();const view=mount();
  expect(values()).toEqual(['53%','24%','23%']);expect(own().dataset.lineupOddsSource).toBe('sorare-dom');
  for(const change of [()=>view.loading(),()=>view.retrying(),()=>view.error(),()=>view.noData()]) {
    change();expect(values()).toEqual(['53%','24%','23%']);expect(own().hidden).toBe(false);
  }
  expect(document.querySelector('[data-card]')!.getAttribute('data-sorare-overlay-clean-sheet-sort-probability')).toBeNull();
});
it('prefers current Sorare percentages over older backend percentages without modifying statistics or CS sorting',()=>{
  positionCards();const view=mount(),stats=sample(),original=JSON.stringify(stats);
  view.render(stats);
  expect(values()).toEqual(['53%','24%','23%']);expect(JSON.stringify(stats)).toBe(original);
  expect(document.querySelector('[data-card]')!.getAttribute('data-sorare-overlay-clean-sheet-sort-probability')).toBe('0.38');
  updateNative([62,22,16]);view.reposition();expect(values()).toEqual(['62%','22%','16%']);
  view.render(stats);expect(values()).toEqual(['62%','22%','16%']);
});
it('preserves unchanged bar nodes across scrolling and uses the visible right-hand player side without swapping values',()=>{
  positionCards();const view=mount();
  const segment=own().shadowRoot!.querySelector('.lineup-odd');
  for(let i=0;i<10;i++)view.reposition();expect(own().shadowRoot!.querySelector('.lineup-odd')).toBe(segment);
  const sides=document.querySelectorAll('[aria-label="Team"]');sides[0]!.classList.remove('highlighted');sides[1]!.classList.add('highlighted');
  view.reposition();expect(values()).toEqual(['53%','24%','23%']);
  expect(own().shadowRoot!.querySelector<HTMLElement>('[data-outcome="home"]')!.dataset.role).toBe('opponent');
  expect(own().shadowRoot!.querySelector<HTMLElement>('[data-outcome="away"]')!.dataset.role).toBe('player');
});
it('falls back to backend odds after Sorare removes its strip and returns to local values when the strip reappears',()=>{
  positionCards();const view=mount();view.render(sample());
  document.querySelector('[data-native]')!.remove();view.reposition();
  expect(values()).toEqual(['79%','16%','5%']);expect(own().dataset.lineupOddsSource).toBe('backend');
  document.querySelector('[data-stats]')!.insertAdjacentHTML('afterend',native([70,20,10]));view.reposition();
  expect(values()).toEqual(['70%','20%','10%']);expect(own().dataset.lineupOddsSource).toBe('sorare-dom');
});
it('leaves ambiguous player sides to Sorare instead of painting a misleading favorite role',()=>{
  positionCards();const sides=document.querySelectorAll('[aria-label="Team"]');sides[1]!.classList.add('highlighted');
  const view=mount();view.loading();expect(document.querySelector('[data-native]')!.matches(hiddenSelector)).toBe(false);
  expect(document.querySelector('[data-lineup-odds-ready="true"]')).toBeNull();
});
it('uses native win values for AA comparison only when canonical teams and visible kickoff match the backend',()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2032-01-01T10:00:00Z'));positionCards();
  const stats=sample(),date=new Date(stats.nextGame!.date);
  const weekday=new Intl.DateTimeFormat('de',{weekday:'short'}).format(date);
  const kickoff=document.createElement('div');kickoff.textContent=`${weekday}, ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
  document.querySelector('[data-stats]')!.parentElement!.insertAdjacentElement('afterend',kickoff);
  const view=mount();view.render(stats);
  const tooltip=document.querySelector('[data-sorare-overlay-companion="lineup-tooltip"]')!.shadowRoot!;
  expect(tooltip.querySelector('.tooltip-win-comparison')?.textContent).toContain('53 %');
  expect(tooltip.querySelector('.tooltip-win-comparison')?.textContent).toContain('+3 %-Pkt.');
  kickoff.textContent='Mo., 10:00';view.reposition();expect(tooltip.querySelector('.tooltip-win-comparison')).toBeNull();
  expect(values()).toEqual(['53%','24%','23%']);
  view.render({...stats,nextGame:{...stats.nextGame!,awayTeamSlug:'finland',awayTeamName:'Finland',opponentTeamName:'Finland'}});
  expect(tooltip.querySelector('.tooltip-win-comparison')).toBeNull();expect(values()).toEqual(['53%','24%','23%']);
});
it('reads rounded comma-decimal percentages and rejects a malformed complete strip',()=>{
  const cell=document.querySelector('[data-native]')!.firstElementChild!.firstElementChild!.firstElementChild!;
  cell.textContent='53,0%';expect(readNativeMatchOdds(document.querySelector('[data-team-row]')!)).toMatchObject({left:0.53,draw:0.24,right:0.23});
  cell.textContent='100';expect(readNativeMatchOdds(document.querySelector('[data-team-row]')!)).toBeNull();
});
it('observes native text and team-role changes through the shared scanner observer without another stats request',async()=>{
  positionCards();document.querySelector('[data-card]')!.setAttribute('data-position','Goalkeeper');
  const fetcher=vi.fn(async()=>({data:[sample()],meta:{requested:1,returned:1,cacheHits:1,source:'sorare' as const}}));
  const coordinator=new StatsBatchCoordinator(fetcher,0);const scanner=new SorareCardScanner(coordinator);
  try {
    scanner.start(document.body);await coordinator.flush();await vi.waitFor(()=>expect(values()).toEqual(['53%','24%','23%']));
    const calls=fetcher.mock.calls.length;updateNative([65,20,15]);
    await vi.waitFor(()=>expect(values()).toEqual(['65%','20%','15%']));
    const sides=document.querySelectorAll('[aria-label="Team"]');sides[0]!.classList.remove('highlighted');sides[1]!.classList.add('highlighted');
    await vi.waitFor(()=>expect(own().shadowRoot!.querySelector<HTMLElement>('[data-outcome="away"]')!.dataset.role).toBe('player'));
    expect(fetcher).toHaveBeenCalledTimes(calls);
  } finally {scanner.stop();}
});
