import type { PlayerStatsSuccessResponse } from '@sorare-overlay/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drainDiscoveredCardPictureNames, findCardTargets, hydrateCardPictureNames, hydrateCardPictureSlugs } from '../dom.js';
import { SorareCardScanner, StatsBatchCoordinator } from '../scanner.js';

const unaiPicture = '99289f6f-fc00-4354-a91a-5829d8e8db62';
const unaiSlug = 'unai-simon-mendibil';
const poster = `https://assets.sorare.com/image-resize/cardsamplepicture/${unaiPicture}/picture/tinified-0ba52090602f90cddc844503fe50e919.png?width=320`;
function fullArtCard(): string {
  return `<main><section>
    <button type="button" data-card><div style="--mask-image-src:none"><div><div><div>
      <video poster="${poster}" loop playsinline style="mask:url('${poster}') center/cover no-repeat">
        <source src="https://assets.sorare.com/cardsamplepicture/${unaiPicture}/video/card.mov" type="video/mp4">
        <source src="https://assets.sorare.com/cardsamplepicture/${unaiPicture}/video/card.webm" type="video/webm">
      </video>
    </div></div></div></div></button>
    <div><div><button type="button" data-stats>
      <span aria-label="Letzte 5 Statistiken"></span><span>66</span><span class="full_art">+33</span>
      <div data-team-row>
        <span aria-label="Team" class="highlighted"><img alt="athletic-club-bilbao"><span>ATH</span></span>
        <span aria-label="Team"><span>ELC</span><img alt="elche-elche"></span>
      </div>
    </button></div><span>18:30</span></div>
  </section></main>`;
}
const placeholder = '<svg><text x="50%" y="80%">NEW KEEPER</text><text y="85%">Torwart</text><text y="95%">Common</text></svg>';

describe('Full Art card identities', () => {
  beforeEach(() => {
    hydrateCardPictureNames({});
    hydrateCardPictureSlugs({});
    document.body.innerHTML = fullArtCard();
    window.history.replaceState({}, '', '/de/football/series/test/compose-team');
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    hydrateCardPictureNames({});
    hydrateCardPictureSlugs({});
  });

  it.each(['/football/series/test/compose-team', '/football/squad', '/football/lineups/test'])('recognizes Unai Simons linkless video without any learned identity on %s', path => {
    window.history.replaceState({}, '', path);
    const card = document.querySelector<HTMLElement>('[data-card]')!;
    const targets = findCardTargets(document, { activeLineupPosition: 'Goalkeeper' });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ slug: unaiSlug, container: card, position: 'Goalkeeper', teamSlug: 'athletic-club-bilbao' });
    expect(card.querySelector('img[alt],a[href]')).toBeNull();
    expect(card.getAttribute('aria-label')).toBeNull();
  });

  it('mounts one goalkeeper overlay and match bar from the Full Art video', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
      return new DOMRect(50, this.hasAttribute('data-team-row') ? 250 : 20, 130, this.hasAttribute('data-team-row') ? 20 : 210);
    });
    const fetcher = vi.fn(async (): Promise<PlayerStatsSuccessResponse> => ({
      data: [{ slug: unaiSlug, displayName: 'Unai Simón', position: 'Goalkeeper',
        aaL10: {value:9.02,sampleSize:10}, goalL10: {value:0,sampleSize:10}, cleanSheetL10: {value:0.4,sampleSize:10}, excludedLowCoverage:0,
        nextGame: {date:'2032-09-12T16:30:00Z',homeTeamName:'Athletic Club',awayTeamName:'Elche',homeTeamSlug:'athletic-club-bilbao',awayTeamSlug:'elche-elche',playerTeamName:'Athletic Club',opponentTeamName:'Elche',playerTeamSlug:'athletic-club-bilbao',cleanSheetProbability:1/2.15,matchProbabilities:{win:0.62,draw:0.22,loss:0.16}},
      }], meta:{requested:1,returned:1,cacheHits:1,source:'sorare'},
    }));
    const coordinator = new StatsBatchCoordinator(fetcher,60_000);
    const scanner = new SorareCardScanner(coordinator);
    try {
      scanner.scan(document);
      await coordinator.flush();
      scanner.scan(document.querySelector('video')!);
      await coordinator.flush();
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0]?.[0]).toMatchObject({slugs:[unaiSlug]});
      expect(document.querySelectorAll('[data-sorare-overlay-root]')).toHaveLength(1);
      expect(document.querySelectorAll('[data-sorare-overlay-companion="lineup-odds"]')).toHaveLength(1);
      expect(Number(document.querySelector('[data-card]')?.getAttribute('data-sorare-overlay-clean-sheet-sort-probability'))).toBeCloseTo(1/2.15);
    } finally { scanner.stop(); }
  });

  it.each(['video','image','mixed'])('learns an unknown picture from its own placeholder plus %s media', media => {
    const id = `new-${media}-picture`;
    const url = `https://assets.sorare.com/cardsamplepicture/${id}/picture/card.png`;
    const video = `<video poster="${url}"></video>`;
    const image = `<img alt="" src="${url}">`;
    document.body.innerHTML = `<button>${placeholder}${media==='video'?video:media==='image'?image:video+image}</button>`;
    expect(findCardTargets(document)).toMatchObject([{playerName:'NEW KEEPER',position:'Goalkeeper'}]);
    expect(findCardTargets(document)).toHaveLength(1);
    const learned = drainDiscoveredCardPictureNames();
    expect(learned).toEqual({[id]:'NEW KEEPER'});
    hydrateCardPictureNames(learned);
    document.body.innerHTML = `<button>${video}</button>`;
    expect(findCardTargets(document)).toMatchObject([{playerName:'NEW KEEPER'}]);
  });

  it('does not learn from foreign or ambiguous media next to a placeholder', () => {
    for (const media of [
      '<video poster="https://example.com/cardsamplepicture/foreign/picture/card.png"></video>',
      '<video poster="https://assets.sorare.com/cardsamplepicture/one/picture/card.png"></video><video poster="https://assets.sorare.com/cardsamplepicture/two/picture/card.png"></video>',
    ]) {
      document.body.innerHTML = `<button>${placeholder}${media}</button>`;
      expect(findCardTargets(document)).toEqual([]);
      expect(drainDiscoveredCardPictureNames()).toEqual({});
    }
  });
});
