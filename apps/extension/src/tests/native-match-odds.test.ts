import {readFileSync} from 'node:fs';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeMatchOddsReplacement} from '../native-match-odds.js';
import {OverlayView} from '../overlay.js';
import type {PlayerStats} from '@sorare-overlay/shared';

const attribute='data-sorare-overlay-native-match-odds';
const hiddenSelector=`:is(button, [role="button"]):has([data-sorare-overlay-companion="lineup-odds"][data-lineup-odds-ready="true"]) + div[${attribute}="true"]`;
const hiddenByRule=(strip:Element)=>strip.matches(hiddenSelector);
const native=()=>`<div data-native><div style="--c-left-color:var(--c-score-medium)">${[53,24,23].map(value=>`<div><div>${value}</div><svg></svg></div>`).join('')}</div></div>`;
const row=()=>`<div data-team-row><span aria-label="Team" class="highlighted"><img alt="norway">NOR</span><span aria-label="Team"><img alt="denmark">DEN</span></div>`;
const markup=()=>`<section><button data-card><img alt="Keeper - common" src="https://assets.sorare.com/cardsamplepicture/test/picture/card.png"></button><div><button data-stats>${row()}</button>${native()}</div></section>`;
const replacements:NativeMatchOddsReplacement[]=[];
const views:OverlayView[]=[];
const claim=()=>{const item=new NativeMatchOddsReplacement();replacements.push(item);item.update(document.querySelector<HTMLElement>('[data-team-row]')!);return item;};
beforeEach(()=>{document.body.innerHTML=markup();window.history.replaceState({},'', '/de/football/series/test/compose-team');});
afterEach(()=>{for(const view of views.splice(0))view.destroy();for(const item of replacements.splice(0))item.clear();document.body.replaceChildren();vi.restoreAllMocks();});

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
  expect(hiddenByRule(strip)).toBe(false);
  view.render(stats);view.reposition();expect(hiddenByRule(strip)).toBe(true);
  view.destroy();expect(strip.hasAttribute(attribute)).toBe(false);
});
