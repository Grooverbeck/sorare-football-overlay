import { afterEach, describe, expect, it } from 'vitest';
import type { PlayerStats } from '@sorare-overlay/shared';
import { OverlayView, applyHistoricalAssistFallbackSettings } from '../overlay.js';

const views: OverlayView[] = [];
function render(position: PlayerStats['position'], historic = false) {
  const card = document.createElement('article'); document.body.append(card);
  const view = new OverlayView(card, { slug: 'european-player' }, position); views.push(view);
  view.render({ slug: 'european-player', displayName: 'European Player', position,
    aaL10: { value: 12, sampleSize: 10 }, goalL10: { value: .2, sampleSize: 10 }, cleanSheetL10: { value: .3, sampleSize: 10 }, excludedLowCoverage: 0,
    historicalGoals: { l10: { value: 0, sampleSize: 10 }, l15: { value: 0, sampleSize: 15 }, l40: { value: 0, sampleSize: 30 } },
    historicalAssists: { l10: { value: .2, sampleSize: 10 }, l15: { value: .2, sampleSize: 15 }, l40: { value: .2, sampleSize: 30 } },
    nextGame: { date: '2032-09-13T18:00:00Z', cleanSheetProbability: .3,
      marketOdds: historic ? null : { source: 'odds-api-io', capturedAt: '2032-09-13T12:00:00Z', goal: { probability: .13, bookmakerCount: 1 }, assist: { probability: .25, bookmakerCount: 1 } },
    },
  });
  return view.host.shadowRoot!;
}
afterEach(() => { for (const view of views.splice(0)) view.destroy(); document.body.replaceChildren(); applyHistoricalAssistFallbackSettings(false, 15); });

describe('European market colors in the actual brackets', () => {
  it('uses the frozen European market bands and leaves the numbers unchanged', () => {
    const root = render('Midfielder');
    const assist = root.querySelector<HTMLElement>('[data-market="assist"]')!;
    expect(assist.dataset.tone).toBe('elite');
    expect(assist.dataset.benchmarkRegion).toBe('european-set');
    expect(assist.dataset.benchmarkVersion).toBe('1');
    expect(assist.dataset.benchmarkSource).toBe('market');
    expect(assist.querySelector('.market-value')?.textContent).toBe('25%');
  });
  it('keeps historical values distinguishable and a zero goal rate red', () => {
    applyHistoricalAssistFallbackSettings(true, 15);
    const root = render('Defender', true);
    const goal = root.querySelector<HTMLElement>('[data-market="goal"]')!;
    expect(goal.dataset.benchmarkSource).toBe('historical');
    expect(goal.dataset.tone).toBe('very-low');
    expect(goal.querySelector('.market-value')?.textContent).toBe('(0%)');
  });
  it('does not turn goalkeeper CS into a goal/assist color band', () => {
    const root = render('Goalkeeper');
    expect(root.querySelector('[data-market="goal"]')).toBeNull();
    expect(root.querySelector('[data-market="assist"]')).toBeNull();
  });
});
