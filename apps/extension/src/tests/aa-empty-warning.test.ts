import type {PlayerStats} from '@sorare-overlay/shared';
import {afterEach, describe, expect, it} from 'vitest';
import {OverlayView} from '../overlay.js';

let view: OverlayView | undefined;
afterEach(() => {view?.destroy(); view = undefined; document.body.replaceChildren(); window.history.replaceState({}, '', '/football');});

const baseStats: PlayerStats = {
  slug: 'empty-aa-player', displayName: 'Empty AA Player', position: 'Forward',
  aaL10: {value: null, sampleSize: 0}, cleanSheetL10: {value: 0, sampleSize: 10},
  goalL10: {value: .2, sampleSize: 10}, excludedLowCoverage: 0,
  nextGame: {date: '2030-01-01T18:00:00Z', cleanSheetProbability: null,
    marketOdds: {source: 'odds-api-io', capturedAt: '2029-12-31T18:00:00Z',
      goal: {probability: .3, bookmakerCount: 2}, assist: null}},
};

function render(stats = baseStats) {
  if (!view) {
    const card = document.createElement('article');
    document.body.append(card);
    view = new OverlayView(card, {slug: stats.slug}, stats.position);
  }
  view.render(stats);
  return view.host.shadowRoot!;
}

describe('empty AA bracket information', () => {
  it('explains national history for both a small and a complete sample', () => {
    const context = {kind:'national' as const,teamSlug:'austria',teamName:'Austria',state:'ready' as const};
    let root=render({...baseStats,aaL10:{value:17.3,sampleSize:4},aaContext:context});
    expect(root.querySelector('.aa-sample-warning-detail')?.textContent).toContain('aktuellen Nationalmannschaft');
    expect(root.querySelector('.aa-sample-warning-detail')?.textContent).toContain('Vereinsspiele ausgeschlossen');
    expect(root.querySelector('.aa-bracket-cell')?.getAttribute('aria-label')).toContain('4 Länderspiele');
    root=render({...baseStats,aaL10:{value:17.3,sampleSize:10},aaContext:context});
    expect(root.querySelector('.aa-sample-warning')).toBeNull();
    expect(root.querySelector('.aa-bracket-cell')?.getAttribute('title')).toContain('10/10 Länderspiele für Austria');
  });

  it('labels retained club values while the matching context is still loading', () => {
    const root=render({...baseStats,aaL10:{value:1.5,sampleSize:4},aaContext:{kind:'club',state:'loading'},pendingRefreshes:['aaContext']});
    expect(root.querySelector('.aa-sample-warning-title')?.textContent).toBe('AA-Kontext wird geladen');
    expect(root.querySelector('.aa-sample-warning-detail')?.textContent).toContain('bisherigen Werte sichtbar');
    expect(root.querySelector('.aa-bracket-cell .market-value')?.textContent).toBe('1.5');
  });
  it.each(['/football/series/test/compose-team', '/football/series/squad', '/football/series/test/lineups'])('reuses the accessible sample-warning icon on %s', path => {
    window.history.replaceState({}, '', path);
    const root = render();
    const aa = root.querySelector<HTMLElement>('.aa-bracket-cell')!;
    expect(aa.dataset.available).toBe('false');
    expect(aa.dataset.tone).toBe('unavailable');
    expect(aa.querySelector('.market-value')?.textContent).toBe('—');
    const warning = aa.querySelector<HTMLElement>('.aa-sample-warning')!;
    expect(warning.childNodes[0]?.textContent).toBe('!');
    expect(warning.querySelector('.aa-sample-warning-glyph')).not.toBeNull();
    expect(warning.tabIndex).toBe(0);
    expect(warning.getAttribute('role')).toBe('note');
    expect(warning.getAttribute('aria-label')).toContain('Hinweis: Keine AA-Daten');
    expect(warning.querySelector('.aa-sample-warning-title')?.textContent).toBe('Keine AA-Daten');
    expect(warning.querySelector('.aa-sample-warning-detail')?.textContent).toContain('mindestens 60 Minuten beim aktuellen Verein');
    expect(root.querySelector('[data-market="goal"] .market-value')?.textContent).toBe('30%');
  });

  it('distinguishes still-loading history from a confirmed missing AA value', () => {
    const root = render({...baseStats, pendingRefreshes: ['formHistory']});
    expect(root.querySelector('.aa-sample-warning-title')?.textContent).toBe('AA-Daten werden geladen');
    expect(root.querySelector('.aa-sample-warning-detail')?.textContent).toContain('wird noch geladen');
    expect(root.querySelector('.aa-bracket-cell')?.getAttribute('aria-label')).toBe('AA L10: Daten werden noch geladen');
  });

  it('changes the explanation as data arrives and does not warn for a complete real zero', () => {
    render();
    let root = render({...baseStats, aaL10: {value: 2.5, sampleSize: 3}});
    expect(root.querySelectorAll('.aa-sample-warning')).toHaveLength(1);
    expect(root.querySelector('.aa-sample-warning-title')?.textContent).toBe('Begrenzte AA-Datenbasis');
    expect(root.querySelector('.aa-sample-warning-detail')?.textContent).toContain('3/10');
    root = render({...baseStats, aaL10: {value: 0, sampleSize: 10}});
    expect(root.querySelector('.aa-sample-warning')).toBeNull();
    expect(root.querySelector('.aa-bracket-cell')?.getAttribute('data-available')).toBe('true');
    expect(root.querySelector('.aa-bracket-cell .market-value')?.textContent).toBe('0.0');
  });

  it('does not add an AA warning to a goalkeeper CS bracket', () => {
    const root = render({...baseStats, position: 'Goalkeeper'});
    expect(root.querySelector('.aa-bracket-cell')).toBeNull();
    expect(root.querySelector('.aa-sample-warning')).toBeNull();
    expect(root.querySelector('.clean-sheet-bracket-cell')).not.toBeNull();
  });
});
