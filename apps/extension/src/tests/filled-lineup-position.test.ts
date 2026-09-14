import type { FootballPosition, PlayerStatsRequest, PlayerStatsSuccessResponse } from '@sorare-overlay/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findCardTargets } from '../dom.js';
import { activeLineupPosition, lineupPoolReadyEvent, lineupSortHydrationGridAttribute } from '../lineup-sort.js';
import { LineupSortHydrator } from '../lineup-sort-hydrator.js';
import { SorareCardScanner, StatsBatchCoordinator } from '../scanner.js';
import { filledSlotsMarkup } from './fixtures/filled-slots.js';

function selectSlot(index: number): void {
  for (const button of document.querySelectorAll('[data-slot]')) {
    button.classList.toggle('highlighted', button.getAttribute('data-slot') === String(index));
  }
}

function pickerMarkup(): string {
  return `<div data-player-grid style="display:grid">${['Wahi', 'Ibrahimovic'].map(name => `
    <div><button data-picker="${name}" data-sorare-overlay-sort-position="Defender">
      <img alt="${name} - limited" src="/${name}.png" width="160" height="259">
    </button></div>`).join('')}</div>`;
}

describe('filled lineup slot identity', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/de/football/series/test/compose-team/lineup');
    document.body.innerHTML = `<main>${filledSlotsMarkup()}${pickerMarkup()}</main>`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it.each([
    [0, 'Goalkeeper'], [1, 'Defender'], [2, 'Midfielder'], [3, 'Forward'], [4, null],
  ] as const)('uses logical filled slot %i, not stale picker positions', (slot, position) => {
    selectSlot(slot);
    expect(activeLineupPosition()).toBe(position);
    expect(findCardTargets(document).map(target => target.position)).toEqual([
      position ?? undefined, position ?? undefined,
    ]);
  });

  it('works in the squad builder as well', () => {
    window.history.replaceState({}, '', '/de/football/series/squad/compose/lineup');
    expect(activeLineupPosition()).toBe('Forward');
    expect(findCardTargets(document)[0]?.position).toBe('Forward');
  });

  it('does not infer a slot from captain, remove or stats controls', () => {
    selectSlot(-1);
    for (const selector of ['[data-captain="1"]', '[data-remove="1"]', '[data-footer="1"]']) {
      const control = document.querySelector(selector)!;
      control.classList.add('highlighted');
      expect(activeLineupPosition()).toBeUndefined();
      control.classList.remove('highlighted');
    }
  });

  it('does not fall back to its own stale majority during ambiguous slot transitions', () => {
    document.querySelector('[data-slot="1"]')!.classList.add('highlighted');
    expect(activeLineupPosition()).toBeUndefined();
    expect(findCardTargets(document).every(target => target.position === undefined)).toBe(true);
  });

  it('keeps an explicit concrete card position ahead of the slot hint', () => {
    document.querySelector('[data-picker="Wahi"]')!.setAttribute('data-card-position', 'Midfielder');
    expect(findCardTargets(document).map(target => target.position)).toEqual(['Midfielder', 'Forward']);
  });

  it('does not impose a selected lineup position on a card-details dialog', () => {
    document.querySelector('[data-player-grid]')!.setAttribute('role', 'dialog');
    expect(findCardTargets(document).every(target => target.position === undefined)).toBe(true);
  });

  it('recognizes empty text-labelled slots and the unconstrained EX slot', () => {
    const labels = ['TW', 'VER', 'MF', 'FWD', 'EX'];
    for (const button of document.querySelectorAll('[data-slot]')) {
      button.textContent = labels[Number(button.getAttribute('data-slot'))]!;
    }
    selectSlot(4);
    expect(activeLineupPosition()).toBeNull();
    expect(findCardTargets(document).every(target => target.position === undefined)).toBe(true);
  });

  it('requests Forward AA for both cards even if the DOM was previously marked Defender', async () => {
    const fetcher = vi.fn(async (request: PlayerStatsRequest): Promise<PlayerStatsSuccessResponse> => ({
      data: (request.playerNames ?? []).map(name => ({
        slug: name.toLowerCase(), displayName: name,
        position: (request.positions?.[name] ?? 'Forward') as FootballPosition,
        aaL10: { value: name === 'Wahi' ? 0.38 : 9.3, sampleSize: 1 },
        cleanSheetL10: { value: null, sampleSize: 0 },
        goalL10: { value: 0, sampleSize: 1 },
        nextGame: null, excludedLowCoverage: 0,
      })),
      meta: { requested: 2, returned: 2, cacheHits: 2, source: 'sorare' },
    }));
    const coordinator = new StatsBatchCoordinator(fetcher, 60_000);
    const scanner = new SorareCardScanner(coordinator);
    try {
      scanner.scan(document);
      await coordinator.flush();
      expect(fetcher).toHaveBeenCalledWith(expect.objectContaining({
        positions: { Wahi: 'Forward', Ibrahimovic: 'Forward' },
      }));
      expect(document.querySelector('[data-picker="Wahi"]')!.getAttribute('data-sorare-overlay-aa-sort-value')).toBe('0.38');
      expect(document.querySelector('[data-picker="Ibrahimovic"]')!.getAttribute('data-sorare-overlay-aa-sort-value')).toBe('9.3');
    } finally {
      scanner.stop();
    }
  });

  it('does not let a delayed Defender response overwrite the new Forward AA on reused cards', async () => {
    const pending: Array<{ request: PlayerStatsRequest; resolve: (response: PlayerStatsSuccessResponse) => void }> = [];
    const fetcher = vi.fn((request: PlayerStatsRequest) => new Promise<PlayerStatsSuccessResponse>(resolve => {
      pending.push({ request, resolve });
    }));
    const resolveBatch = (index: number, position: FootballPosition, aa: number): void => {
      const batch = pending[index]!;
      batch.resolve({
        data: (batch.request.playerNames ?? []).map(name => ({
          slug: name.toLowerCase(), displayName: name, position,
          aaL10: { value: aa, sampleSize: 1 },
          cleanSheetL10: { value: null, sampleSize: 0 },
          goalL10: { value: 0, sampleSize: 1 }, nextGame: null, excludedLowCoverage: 0,
        })),
        meta: { requested: 2, returned: 2, cacheHits: 2, source: 'sorare' },
      });
    };
    // Exercise out-of-order completion even when concurrent batch loading is enabled.
    const coordinator = new StatsBatchCoordinator(fetcher, 60_000, [], 12, 2);
    const scanner = new SorareCardScanner(coordinator);
    try {
      selectSlot(1);
      scanner.scan(document);
      const oldFlush = coordinator.flush();
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      selectSlot(3);
      scanner.scan(document);
      const newFlush = coordinator.flush();
      await vi.waitFor(() => expect(pending).toHaveLength(2));
      expect(pending[0]!.request.positions).toEqual({ Wahi: 'Defender', Ibrahimovic: 'Defender' });
      expect(pending[1]!.request.positions).toEqual({ Wahi: 'Forward', Ibrahimovic: 'Forward' });
      resolveBatch(1, 'Forward', 9.3);
      await newFlush;
      resolveBatch(0, 'Defender', -9.2);
      await oldFlush;
      for (const card of document.querySelectorAll('[data-picker]')) {
        expect(card.getAttribute('data-sorare-overlay-aa-sort-value')).toBe('9.3');
        expect(card.getAttribute('data-sorare-overlay-sort-position')).toBe('Forward');
      }
    } finally {
      scanner.stop();
    }
  });

  it('restarts frame-budgeted pool discovery when the filled slot changes halfway through', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('IntersectionObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    selectSlot(1);
    const grid = document.querySelector<HTMLElement>('[data-player-grid]')!;
    grid.setAttribute(lineupSortHydrationGridAttribute, 'true');
    grid.innerHTML = Array.from({ length: 40 }, (_, index) => `
      <div><button>
        <img alt="Test player ${index} - limited" src="/player-${index}.png">
      </button></div>`).join('');
    const hydrator = new LineupSortHydrator(vi.fn());
    const hydrate = vi.spyOn(hydrator, 'hydrate').mockResolvedValue();
    const scanner = new SorareCardScanner(new StatsBatchCoordinator(vi.fn(), 60_000), undefined, hydrator);
    try {
      scanner.start();
      frames.length = 0;
      hydrate.mockClear();
      grid.dispatchEvent(new CustomEvent(lineupPoolReadyEvent, { bubbles: true }));
      grid.removeAttribute(lineupSortHydrationGridAttribute);
      frames.shift()!(performance.now());
      expect(hydrate).toHaveBeenCalledTimes(1);
      expect(hydrate.mock.calls[0]![1]!.length).toBeLessThan(40);
      hydrate.mockClear();
      const cancel=vi.spyOn(hydrator,'cancel');
      selectSlot(3);
      let count = 0;
      while (frames.length && count++ < 100) frames.shift()!(performance.now());
      expect(count).toBeLessThan(100);
      expect(cancel).toHaveBeenCalled();
      const targets = hydrate.mock.calls.flatMap(([, chunk])=>chunk??[]);
      expect(targets).toHaveLength(40);
      expect(targets.every(target => target.position === 'Forward')).toBe(true);
    } finally {
      scanner.stop();
    }
  });
});
