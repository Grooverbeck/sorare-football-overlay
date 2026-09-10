import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {PlayerStats,PlayerStatsSuccessResponse} from '@sorare-overlay/shared';
import {findCardTargets,hydrateCardPictureNames,hydrateCardPictureSlugs} from '../dom.js';
import {OverlayView} from '../overlay.js';
import {SorareCardScanner,StatsBatchCoordinator} from '../scanner.js';

const stats:PlayerStats={slug:'mio-backhaus',displayName:'Mio Backhaus',position:'Goalkeeper',aaL10:{value:4.575,sampleSize:10},goalL10:{value:0,sampleSize:10},cleanSheetL10:{value:0.3,sampleSize:10},excludedLowCoverage:0,
  nextGame:{date:'2032-01-01T15:30:00Z',homeTeamName:'Freiburg',awayTeamName:'Gladbach',homeTeamSlug:'freiburg-freiburg-im-breisgau',awayTeamSlug:'borussia-m-gladbach-monchengladbach',playerTeamName:'Freiburg',opponentTeamName:'Gladbach',playerTeamSlug:'freiburg-freiburg-im-breisgau',cleanSheetProbability:1/3,matchProbabilities:{win:0.53,draw:0.24,loss:0.23}}};
const views:OverlayView[]=[];
let scanner:SorareCardScanner|undefined;
function markup(copy='one'):string {
  const url='https://assets.sorare.com/cardsamplepicture/bed12849-550d-4dd0-8382-81143e930a3d/picture/card.png';
  return `<section data-copy="${copy}">
    <div data-frame style="--mask-image-src:none"><div><div>
      <div style="--mask-shape:url(${url})"><div><div data-image-wrapper><img alt="Mio Backhaus - common" src="${url}"></div></div></div>
    </div><span><svg aria-label="Gesperrt"></svg></span></div></div>
    <button><div data-team-row><span aria-label="Team" class="highlighted"><img alt="freiburg-freiburg-im-breisgau"><span>SCF</span></span><span aria-label="Team"><img alt="borussia-m-gladbach-monchengladbach"><span>BMG</span></span></div></button>
    <span>In Pro-Schritt 4</span>
  </section>`;
}
beforeEach(()=>{
  hydrateCardPictureNames({});hydrateCardPictureSlugs({});
  window.history.replaceState({},'', '/de/football/series/test/compose-team');
  document.body.innerHTML=markup();
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){return new DOMRect(20,this.hasAttribute('data-team-row')?235:20,130,this.hasAttribute('data-team-row')?20:210);});
});
afterEach(()=>{scanner?.stop();scanner=undefined;for(const view of views.splice(0))view.destroy();document.body.replaceChildren();vi.restoreAllMocks();});

it('discovers one locked shiny card regardless of whole-page, frame or image scan',()=>{
  const frame=document.querySelector<HTMLElement>('[data-frame]')!;
  for(const root of [document,frame,document.querySelector('img')!]) {
    const targets=findCardTargets(root);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.container).toBe(frame);
  }
});

it('mounts only one overlay and match bar across repeated partial scans',async()=>{
  const fetcher=vi.fn(async():Promise<PlayerStatsSuccessResponse>=>({data:[stats],meta:{requested:1,returned:1,cacheHits:1,source:'sorare'}}));
  const coordinator=new StatsBatchCoordinator(fetcher,60000);
  scanner=new SorareCardScanner(coordinator);
  scanner.start();await coordinator.flush();
  for(let i=0;i<3;i++){scanner.scan(document.querySelector('img')!);scanner.scan(document.querySelector('[data-frame]')!);}
  await coordinator.flush();
  expect(document.querySelectorAll('[data-sorare-overlay-root]')).toHaveLength(1);
  expect(document.querySelectorAll('[data-sorare-overlay-companion="lineup-odds"]')).toHaveLength(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('enforces the team-row owner at insertion and permits takeover after disposal',()=>{
  const frame=document.querySelector<HTMLElement>('[data-frame]')!;
  const inner=document.querySelector<HTMLElement>('[data-image-wrapper]')!;
  const first=new OverlayView(frame,{slug:stats.slug},'Goalkeeper');views.push(first);
  const second=new OverlayView(inner,{slug:stats.slug},'Goalkeeper');views.push(second);
  first.render(stats);second.render(stats);
  for(let i=0;i<3;i++){first.reposition();second.reposition();}
  expect(document.querySelectorAll('[data-sorare-overlay-companion="lineup-odds"]')).toHaveLength(1);
  first.destroy();second.reposition();
  expect(document.querySelectorAll('[data-sorare-overlay-companion="lineup-odds"]')).toHaveLength(1);
  expect(document.querySelector('[data-sorare-overlay-companion="lineup-odds"]')?.shadowRoot?.querySelector('.lineup-odds-bar')?.textContent).toBe('53%24%23%');
});

it('retains separate views for two real copies of the same card',()=>{
  document.body.innerHTML=markup('one')+markup('two');
  expect(findCardTargets(document)).toHaveLength(2);
});

it('reclaims a row from a disconnected card before its old view is disposed',()=>{
  const frame=document.querySelector<HTMLElement>('[data-frame]')!;
  const first=new OverlayView(frame,{slug:stats.slug},'Goalkeeper');views.push(first);first.render(stats);
  const replacement=frame.cloneNode(true) as HTMLElement;
  frame.replaceWith(replacement);
  const second=new OverlayView(replacement,{slug:stats.slug},'Goalkeeper');views.push(second);second.render(stats);
  expect(document.querySelectorAll('[data-sorare-overlay-companion="lineup-odds"]')).toHaveLength(1);
  first.destroy();second.reposition();
  expect(document.querySelectorAll('[data-sorare-overlay-companion="lineup-odds"]')).toHaveLength(1);
});
