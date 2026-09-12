import type { PlayerStatsSuccessResponse } from '@sorare-overlay/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findCardTargets, hydrateCardPictureNames, hydrateCardPictureSlugs } from '../dom.js';
import { SorareCardScanner, StatsBatchCoordinator } from '../scanner.js';

const picture = '58392eac-1a4f-4be5-b520-db23e352060b';
const poster = `https://assets.sorare.com/image-resize/cardsamplepicture/${picture}/picture/tinified-633aa1a8836615febfb9ebb9c84eccab.png?width=160`;
function cardMarkup(): string {
  return `<section><button type="button" data-card><div><div>
    <div data-foil style="--mask-shape:url(${poster});--mask-foil:url(https://assets.sorare.com/cardsamplepicture/${picture}/picture/foil.png)">
      <div><div><div><div><video poster="${poster}" loop playsinline style="mask:url('${poster}') center/cover no-repeat">
        <source src="https://assets.sorare.com/cardsamplepicture/${picture}/video/card.mov" type="video/mp4">
        <source src="https://assets.sorare.com/cardsamplepicture/${picture}/video/card.webm" type="video/webm">
      </video></div></div></div></div>
    </div>
  </div></div></button></section>`;
}

describe('Lassine Sinayoko animated overview card', () => {
  beforeEach(() => {
    hydrateCardPictureNames({});
    hydrateCardPictureSlugs({});
    document.body.innerHTML = cardMarkup();
    window.history.replaceState({}, '', '/de/football/series/my-club/forzagamer');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(80,80,85,137));
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    hydrateCardPictureNames({});
    hydrateCardPictureSlugs({});
  });

  it.each(['/football/series/my-club/forzagamer','/football/series/test/compose-team','/football/squad','/football/lineups/test'])('discovers one identity from video plus foil on %s', path => {
    window.history.replaceState({}, '', path);
    const card = document.querySelector<HTMLElement>('[data-card]')!;
    expect(card.querySelector('img[alt],a[href]')).toBeNull();
    for (const root of [document, card, document.querySelector('video')!, document.querySelector<HTMLElement>('[data-foil]')!]) {
      expect(findCardTargets(root)).toMatchObject([{slug:'lassine-sinayoko',container:card}]);
      expect(findCardTargets(root)).toHaveLength(1);
    }
  });

  it('requests Sinayoko and renders AA, goal and assist values only once', async () => {
    const fetcher = vi.fn(async (): Promise<PlayerStatsSuccessResponse> => ({
      data:[{slug:'lassine-sinayoko',displayName:'Lassine Sinayoko',position:'Forward',aaL10:{value:13.366666666666667,sampleSize:3},goalL10:{value:0,sampleSize:10},cleanSheetL10:{value:0,sampleSize:10},excludedLowCoverage:0,
        nextGame:{date:'2032-09-12T18:45:00Z',homeTeamName:'Paris',awayTeamName:'Olympique Lyonnais',homeTeamSlug:'paris-paris',awayTeamSlug:'olympique-lyonnais-lyon',playerTeamName:'Paris',opponentTeamName:'Olympique Lyonnais',playerTeamSlug:'paris-paris',cleanSheetProbability:0.25,matchProbabilities:{win:0.35,draw:0.27,loss:0.38},marketOdds:{source:'odds-api-io',capturedAt:'2032-09-12T18:05:00Z',goal:{probability:1/2.3,bookmakerCount:1},assist:{probability:1/4.333,bookmakerCount:1}}},
      }],meta:{requested:1,returned:1,cacheHits:1,source:'sorare'},
    }));
    const coordinator = new StatsBatchCoordinator(fetcher,60_000);
    const scanner = new SorareCardScanner(coordinator);
    try {
      scanner.scan(document);
      await coordinator.flush();
      scanner.scan(document.querySelector('video')!);
      scanner.scan(document.querySelector('[data-foil]')!);
      await coordinator.flush();
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0]?.[0]).toMatchObject({slugs:['lassine-sinayoko']});
      const hosts = document.querySelectorAll('[data-sorare-overlay-root]');
      expect(hosts).toHaveLength(1);
      const shadow = hosts[0]!.shadowRoot!;
      expect(shadow.querySelector('.aa-bracket-cell')?.textContent).toContain('13.4');
      expect(shadow.querySelector('[data-market="goal"] .market-value')?.textContent).toBe('43%');
      expect(shadow.querySelector('[data-market="assist"] .market-value')?.textContent).toBe('23%');
    } finally { scanner.stop(); }
  });
});
