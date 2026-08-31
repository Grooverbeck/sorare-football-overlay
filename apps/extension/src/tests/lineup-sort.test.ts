import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LineupCardSorter,
  lineupAaSortOptionAttribute,
  lineupAaSortValueAttribute,
  lineupCleanSheetSortOptionAttribute,
  lineupCleanSheetSortProbabilityAttribute,
  lineupGoalSortOptionAttribute,
  lineupGoalSortProbabilityAttribute,
  lineupGoalSortSourceAttribute,
  lineupPoolReadyEvent,
  lineupSortDataReadyAttribute,
  loadCompleteLineupPool,
  setLineupAaSortValue,
  setLineupCleanSheetSortValue,
  setLineupGoalSortValue,
  setLineupSortDataReady,
  setLineupSortPosition,
  supportsLineupSortPath,
  type LineupPoolLoader,
} from '../lineup-sort.js';

function lineupBuilderMarkup(): string {
  return `
    <header>
      <div data-picker-toolbar>
        <input type="search" placeholder="Spieler suchen">
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded="true"
          aria-controls="sort-dialog"
          data-native-sort
        >
          <span><div>
            <div data-native-trigger-label>Durchschnittsbewertung</div>
            <svg data-icon="iconChevronDown"></svg>
          </div></span>
        </button>
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded="false"
          aria-controls="filter-dialog"
          data-native-filter
        >
          <svg data-icon="iconFilter"></svg>
        </button>
      </div>
    </header>
    <div id="sort-dialog" role="dialog" data-state="open">
      <form>
        <div>
          <div>Sortieren nach</div>
          <div data-native-options>
            <button type="button" data-native-option="average">
              <div>
                <div><span><svg viewBox="0 0 24 24" fill="var(--c-blue-400)"><circle></circle><circle></circle></svg><input type="radio" checked></span></div>
                <div>Durchschnittsbewertung</div>
              </div>
              <div>Letzte 10 Wertungen (L10)</div>
            </button>
            <button type="button" data-native-option="soon">
              <div>
                <div><span><svg viewBox="0 0 24 24" fill="none"><circle></circle><circle></circle></svg><input type="radio"></span></div>
                <div>Spielt bald</div>
              </div>
              <div>Zeitpunkt der ersten Partie</div>
            </button>
            <button type="button" data-native-option="edition">
              <div>
                <div><span><svg viewBox="0 0 24 24" fill="none"><circle></circle><circle></circle></svg><input type="radio"></span></div>
                <div>Sonderedition</div>
              </div>
              <div>Seltenste Editionen zuerst</div>
            </button>
          </div>
        </div>
      </form>
    </div>
    <div id="filter-dialog" role="dialog" data-state="closed" aria-hidden="true">
      <button type="button"><span>Nur spielberechtigt</span></button>
    </div>
    <nav data-lineup-positions>
      <button type="button" class="highlighted"><span>VER</span></button>
      <button type="button"><span>MF</span></button>
      <button type="button"><span>FWD</span></button>
      <button type="button"><span>EX</span></button>
    </nav>
    <div data-player-grid style="display: grid">
      <div data-cell="market">
        <article data-player="market" data-sorare-overlay-sort-data-ready="true">
          <img alt="Market Player - limited">
        </article>
      </div>
      <div data-cell="historical">
        <article data-player="historical" data-sorare-overlay-sort-data-ready="true">
          <img alt="Historical Player - limited">
        </article>
      </div>
      <div data-cell="missing">
        <article data-player="missing" data-sorare-overlay-sort-data-ready="true">
          <img alt="Missing Player - limited">
        </article>
      </div>
    </div>
  `;
}

const immediatePoolLoader: LineupPoolLoader = async ({ onProgress }) => {
  const grid = document.querySelector<HTMLElement>('[data-player-grid]');
  if (grid) onProgress(grid.children.length);
  return grid;
};

function appendLoadingCell(grid: HTMLElement): HTMLElement {
  const loadingCell = document.createElement('div');
  loadingCell.dataset.loadingCell = 'true';
  loadingCell.innerHTML =
    '<div role="progressbar" aria-busy="true"></div>';
  grid.append(loadingCell);
  vi.spyOn(loadingCell, 'getBoundingClientRect').mockReturnValue(
    DOMRect.fromRect({ x: 900, y: 1_200, width: 120, height: 280 }),
  );
  vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(
    DOMRect.fromRect({ x: 100, y: 100, width: 900, height: 1_380 }),
  );
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1_200);
  return loadingCell;
}

describe('lineup card sorting', () => {
  let sorter: LineupCardSorter;

  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = lineupBuilderMarkup();
    window.history.replaceState({}, '', '/de/football/series/test/compose-team/lineup');
    sorter = new LineupCardSorter(immediatePoolLoader);
  });

  afterEach(() => {
    sorter.stop();
    document.body.replaceChildren();
  });

  it('supports regular and squad compose routes only', () => {
    expect(
      supportsLineupSortPath('/de/football/series/test/compose-team/lineup'),
    ).toBe(true);
    expect(
      supportsLineupSortPath(
        '/de/football/series/squad/compose/BoardStep%3Atest',
      ),
    ).toBe(true);
    expect(supportsLineupSortPath('/de/football/lineups/lineup')).toBe(
      false,
    );
    expect(
      supportsLineupSortPath(
        '/de/football/series/squad/lineups/BoardStep%3Atest',
      ),
    ).toBe(false);
  });

  it('sorts in the squad builder without repeatedly mounting menu options', async () => {
    window.history.replaceState(
      {},
      '',
      '/de/football/series/squad/compose/BoardStep%3Atest',
    );
    document.querySelector('[data-lineup-positions]')?.remove();
    document.querySelector('[data-player-grid]')?.insertAdjacentHTML(
      'beforebegin',
      `
        <div class="slots5" data-selected-squad style="display: grid">
          <div><img src="/cardsamplepicture/selected-1.png" alt=""></div>
          <div><img src="/cardsamplepicture/selected-2.png" alt=""></div>
          <div><img src="/cardsamplepicture/selected-3.png" alt=""></div>
          <div><img src="/cardsamplepicture/selected-4.png" alt=""></div>
          <div><img src="/cardsamplepicture/selected-5.png" alt=""></div>
        </div>
      `,
    );
    const options = document.querySelector<HTMLElement>(
      '[data-native-options]',
    );
    if (!options) throw new Error('Expected native sort options');
    const append = vi.spyOn(options, 'append');
    const market = document.querySelector<HTMLElement>(
      '[data-player="market"]',
    );
    const historical = document.querySelector<HTMLElement>(
      '[data-player="historical"]',
    );
    const marketCell = document.querySelector<HTMLElement>(
      '[data-cell="market"]',
    );
    const historicalCell = document.querySelector<HTMLElement>(
      '[data-cell="historical"]',
    );
    if (!market || !historical || !marketCell || !historicalCell) {
      throw new Error('Expected squad sorting fixture');
    }
    setLineupAaSortValue(market, 12);
    setLineupAaSortValue(historical, 24);

    sorter.start();
    expect(append).toHaveBeenCalledTimes(2);
    document
      .querySelector<HTMLButtonElement>(`[${lineupAaSortOptionAttribute}]`)
      ?.click();

    await vi.waitFor(() => expect(historicalCell.style.order).toBe('-3'));
    expect(marketCell.style.order).toBe('-2');
    expect(
      Array.from(
        document.querySelectorAll<HTMLElement>('[data-selected-squad] > div'),
      ).every((cell) => cell.style.order === ''),
    ).toBe(true);

    sorter.scan(document);
    sorter.scan(document);

    expect(append).toHaveBeenCalledTimes(2);
    expect(
      document.querySelector(`[${lineupGoalSortOptionAttribute}]`),
    ).not.toBeNull();
    expect(
      document.querySelector(`[${lineupAaSortOptionAttribute}]`),
    ).not.toBeNull();
  });

  it('leaves squad overview and submitted lineup pages untouched', () => {
    window.history.replaceState(
      {},
      '',
      '/de/football/series/squad/lineups/BoardStep%3Atest',
    );

    sorter.start();
    sorter.scan(document);

    expect(
      document.querySelector(`[${lineupGoalSortOptionAttribute}]`),
    ).toBeNull();
    expect(
      document.querySelector(`[${lineupAaSortOptionAttribute}]`),
    ).toBeNull();
  });

  it('loads every lazy Sorare page before declaring the player pool complete', async () => {
    const grid = document.querySelector<HTMLElement>('[data-player-grid]');
    if (!grid) throw new Error('Expected player grid');
    const pages = [
      '<div><img alt="Lazy Player One - limited"></div>',
      '<div><img alt="Lazy Player Two - limited"></div>',
    ];
    const progress: number[] = [];
    const gridUpdates = vi.fn();
    const getGrid = vi.fn(() => grid);
    const revealGridEnd = vi.fn(async () => {
      const page = pages.shift();
      if (page) grid.insertAdjacentHTML('beforeend', page);
      return false;
    });

    const result = await loadCompleteLineupPool(
      {
        isCancelled: () => false,
        onProgress: (count) => progress.push(count),
        onGridUpdate: gridUpdates,
      },
      {
        getGrid,
        revealGridEnd,
        waitForGrowth: async (_grid, previousCount) =>
          grid.children.length > previousCount,
        maxPulses: 6,
        stableMissesRequired: 2,
      },
    );

    expect(result).toBe(grid);
    expect(grid.children).toHaveLength(5);
    expect(revealGridEnd).toHaveBeenCalledTimes(4);
    expect(getGrid).toHaveBeenCalledTimes(1);
    expect(gridUpdates).toHaveBeenCalledTimes(3);
    expect(gridUpdates).toHaveBeenLastCalledWith(grid);
    expect(progress.at(-1)).toBe(5);
  });

  it('accepts a 256-card pool that finishes on the final loading probe', async () => {
    const grid = document.querySelector<HTMLElement>('[data-player-grid]');
    if (!grid) throw new Error('Expected player grid');
    grid.replaceChildren();
    appendLoadingCell(grid);
    const progress: number[] = [];
    let loadedCards = 0;

    const result = await loadCompleteLineupPool(
      {
        isCancelled: () => false,
        onProgress: (count) => progress.push(count),
      },
      {
        getGrid: () => grid,
        revealGridEnd: async () => {
          grid.querySelector('[data-loading-cell]')?.remove();
          for (let index = 0; index < 8; index += 1) {
            const cell = document.createElement('div');
            cell.innerHTML = `<img alt="Large Pool Player ${loadedCards + 1} - limited">`;
            grid.append(cell);
            loadedCards += 1;
          }
          if (loadedCards < 256) appendLoadingCell(grid);
          return true;
        },
        waitForGrowth: async (_currentGrid, previousCount) =>
          grid.querySelectorAll('img').length > previousCount,
        maxPulses: 32,
        stableMissesRequired: 2,
      },
    );

    expect(result).toBe(grid);
    expect(loadedCards).toBe(256);
    expect(grid.querySelector('[aria-busy="true"]')).toBeNull();
    expect(progress.at(-1)).toBe(256);
  });

  it('continues loading pools beyond the former 32-pulse ceiling', async () => {
    const grid = document.querySelector<HTMLElement>('[data-player-grid]');
    if (!grid) throw new Error('Expected player grid');
    grid.replaceChildren();
    appendLoadingCell(grid);
    let loadedCards = 0;

    const result = await loadCompleteLineupPool(
      {
        isCancelled: () => false,
        onProgress: () => undefined,
      },
      {
        getGrid: () => grid,
        revealGridEnd: async () => {
          if (loadedCards >= 480) return true;
          grid.querySelector('[data-loading-cell]')?.remove();
          for (let index = 0; index < 8; index += 1) {
            const cell = document.createElement('div');
            cell.innerHTML = `<img alt="Very Large Pool Player ${loadedCards + 1} - limited">`;
            grid.append(cell);
            loadedCards += 1;
          }
          if (loadedCards < 480) appendLoadingCell(grid);
          return true;
        },
        waitForGrowth: async (_currentGrid, previousCount) =>
          grid.querySelectorAll('img').length > previousCount,
        stableMissesRequired: 2,
      },
    );

    expect(result).toBe(grid);
    expect(loadedCards).toBe(480);
    expect(grid.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('announces the complete pool so offscreen cards can be hydrated', async () => {
    const grid = document.querySelector<HTMLElement>('[data-player-grid]');
    if (!grid) throw new Error('Expected player grid');
    const ready = vi.fn();
    grid.addEventListener(lineupPoolReadyEvent, ready);

    sorter.start();
    document
      .querySelector<HTMLButtonElement>(`[${lineupAaSortOptionAttribute}]`)
      ?.click();

    await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
    expect(ready.mock.calls[0]?.[0].target).toBe(grid);
  });

  it('keeps loading progress stable until value hydration has settled', async () => {
    const market = document.querySelector<HTMLElement>('[data-player="market"]');
    const historical = document.querySelector<HTMLElement>(
      '[data-player="historical"]',
    );
    const missing = document.querySelector<HTMLElement>('[data-player="missing"]');
    const label = document.querySelector<HTMLElement>(
      '[data-native-trigger-label]',
    );
    if (!market || !historical || !missing || !label) {
      throw new Error('Expected lineup loading fixture');
    }
    setLineupAaSortValue(market, 30);
    setLineupAaSortValue(historical, 20);
    setLineupSortDataReady(historical, false);
    setLineupSortDataReady(missing, false);

    sorter.start();
    document
      .querySelector<HTMLButtonElement>(`[${lineupAaSortOptionAttribute}]`)
      ?.click();

    expect(label.textContent).toBe('AA lädt …');
    expect(label.title).toBe(
      'Die vollständige Spielerliste wird geladen. Danach wird automatisch sortiert.',
    );
    expect(label.hasAttribute('data-sorare-overlay-lineup-sort-loading')).toBe(
      true,
    );
    await vi.waitFor(() => {
      expect(label.textContent).toBe('AA lädt …');
      expect(label.title).toBe(
        '3 Spieler insgesamt. AA-Werte werden abgeglichen. Die Sortierung aktualisiert sich automatisch.',
      );
      expect(
        document.querySelector(
          '[data-sorare-overlay-lineup-sort-player-status-label]',
        )?.textContent,
      ).toBe('3 Spieler geladen');
    });

    setLineupSortDataReady(historical, true);
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    setLineupSortDataReady(historical, false);
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(label.textContent).toBe('AA lädt …');
    expect(label.textContent).not.toMatch(/\d/);
    expect(
      document.querySelector(
        '[data-sorare-overlay-lineup-sort-player-status-label]',
      )?.textContent,
    ).toBe('3 Spieler geladen');

    setLineupSortDataReady(historical, true);
    setLineupSortDataReady(missing, true);
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    expect(label.textContent).toBe('AA lädt …');
    expect(
      document.querySelector(
        '[data-sorare-overlay-lineup-sort-player-status-label]',
      )?.textContent,
    ).toBe('3 Spieler geladen');

    setLineupSortDataReady(missing, false);
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    setLineupSortDataReady(missing, true);
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    expect(label.textContent).toBe('AA lädt …');
    expect(
      document.querySelector(
        '[data-sorare-overlay-lineup-sort-player-status-label]',
      )?.textContent,
    ).toBe('3 Spieler geladen');

    await vi.waitFor(() => expect(label.textContent).toBe('AA'));
    expect(label.title).toBe(
      '3 Spieler insgesamt. Nach AA sortiert. Karten ohne verfügbaren AA-Wert stehen am Ende.',
    );
    expect(
      document.querySelector(
        '[data-sorare-overlay-lineup-sort-player-status-label]',
      )?.textContent,
    ).toBe('3 Spieler sortiert');
    expect(label.hasAttribute('data-sorare-overlay-lineup-sort-loading')).toBe(
      false,
    );

    setLineupSortDataReady(missing, false);
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(label.textContent).toBe('AA');
    expect(
      document.querySelector(
        '[data-sorare-overlay-lineup-sort-player-status-label]',
      )?.textContent,
    ).toBe('3 Spieler sortiert');
    setLineupSortDataReady(missing, true);
    expect(market.getAttribute(lineupSortDataReadyAttribute)).toBe('true');
  });

  it('only counts discovered players upwards while loading the pool', async () => {
    sorter.stop();
    let reportProgress: ((cardCount: number) => void) | undefined;
    let finishLoad: ((grid: HTMLElement | null) => void) | undefined;
    sorter = new LineupCardSorter(
      (context) =>
        new Promise((resolve) => {
          reportProgress = context.onProgress;
          finishLoad = resolve;
        }),
    );
    const label = document.querySelector<HTMLElement>(
      '[data-native-trigger-label]',
    );
    if (!label) throw new Error('Expected native trigger label');

    sorter.start();
    document
      .querySelector<HTMLButtonElement>(`[${lineupAaSortOptionAttribute}]`)
      ?.click();
    await vi.waitFor(() => expect(reportProgress).toBeTypeOf('function'));

    reportProgress?.(38);
    expect(
      document.querySelector(
        '[data-sorare-overlay-lineup-sort-player-status-label]',
      )?.textContent,
    ).toBe('38 Spieler geladen');
    expect(label.title).toContain('38 Spieler bisher geladen.');

    reportProgress?.(74);
    expect(
      document.querySelector(
        '[data-sorare-overlay-lineup-sort-player-status-label]',
      )?.textContent,
    ).toBe('74 Spieler geladen');

    reportProgress?.(69);
    expect(
      document.querySelector(
        '[data-sorare-overlay-lineup-sort-player-status-label]',
      )?.textContent,
    ).toBe('74 Spieler geladen');
    expect(label.title).toContain('74 Spieler bisher geladen.');

    finishLoad?.(null);
    await vi.waitFor(() => expect(label.textContent).toBe('AA · Wiederholen'));
    expect(
      document.querySelector(
        '[data-sorare-overlay-lineup-sort-player-status-label]',
      )?.textContent,
    ).toBe('74 Spieler · unvollständig');
  });

  it('coalesces a burst of card value changes into one pool refresh', async () => {
    const market = document.querySelector<HTMLElement>('[data-player="market"]');
    const historical = document.querySelector<HTMLElement>(
      '[data-player="historical"]',
    );
    const missing = document.querySelector<HTMLElement>('[data-player="missing"]');
    if (!market || !historical || !missing) {
      throw new Error('Expected lineup cards');
    }

    sorter.start();
    document
      .querySelector<HTMLButtonElement>(`[${lineupAaSortOptionAttribute}]`)
      ?.click();
    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLElement>('[data-cell="market"]')?.style
          .order,
      ).not.toBe(''),
    );

    const refresh = vi.spyOn(
      sorter as unknown as { refreshHydrationProgress: () => void },
      'refreshHydrationProgress',
    );
    refresh.mockClear();

    setLineupAaSortValue(market, 30);
    setLineupAaSortValue(historical, 20);
    setLineupAaSortValue(missing, 10);
    setLineupSortDataReady(market, false);
    setLineupSortDataReady(historical, false);
    setLineupSortDataReady(missing, false);

    expect(refresh).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('gives Sorare exclusive control while its native filter is open', async () => {
    sorter.stop();
    let loadCalls = 0;
    sorter = new LineupCardSorter(async (context) => {
      loadCalls += 1;
      return immediatePoolLoader(context);
    });
    const market = document.querySelector<HTMLElement>('[data-player="market"]');
    const historical = document.querySelector<HTMLElement>(
      '[data-player="historical"]',
    );
    const marketCell = document.querySelector<HTMLElement>('[data-cell="market"]');
    const historicalCell = document.querySelector<HTMLElement>(
      '[data-cell="historical"]',
    );
    const missingCell = document.querySelector<HTMLElement>('[data-cell="missing"]');
    const filterTrigger = document.querySelector<HTMLButtonElement>(
      '[data-native-filter]',
    );
    const filterDialog = document.querySelector<HTMLElement>('#filter-dialog');
    if (
      !market ||
      !historical ||
      !marketCell ||
      !historicalCell ||
      !missingCell ||
      !filterTrigger ||
      !filterDialog
    ) {
      throw new Error('Expected native filter fixture');
    }
    setLineupAaSortValue(market, 30);
    setLineupAaSortValue(historical, 20);

    sorter.start();
    document
      .querySelector<HTMLButtonElement>(`[${lineupAaSortOptionAttribute}]`)
      ?.click();
    await vi.waitFor(() => expect(marketCell.style.order).toBe('-3'));
    expect(loadCalls).toBe(1);

    filterTrigger.setAttribute('aria-expanded', 'true');
    filterDialog.setAttribute('data-state', 'open');
    filterDialog.removeAttribute('aria-hidden');
    sorter.scan(document);
    expect(marketCell.style.order).toBe('');
    expect(historicalCell.style.order).toBe('');

    historicalCell.remove();
    sorter.scan(document);
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    expect(loadCalls).toBe(1);

    filterTrigger.setAttribute('aria-expanded', 'false');
    filterDialog.setAttribute('data-state', 'closed');
    filterDialog.setAttribute('aria-hidden', 'true');
    sorter.scan(document);
    await vi.waitFor(() => expect(loadCalls).toBe(2));
    await vi.waitFor(() => expect(marketCell.style.order).toBe('-2'));
    expect(missingCell.style.order).toBe('-1');
  });

  it('closes Sorare\'s sort dialog after selecting a custom option', async () => {
    const trigger = document.querySelector<HTMLButtonElement>('[data-native-sort]');
    const dialog = document.querySelector<HTMLElement>('#sort-dialog');
    if (!trigger || !dialog) throw new Error('Expected native sort controls');
    trigger.addEventListener('click', () => {
      trigger.setAttribute('aria-expanded', 'false');
      dialog.setAttribute('data-state', 'closed');
    });

    sorter.start();
    document
      .querySelector<HTMLButtonElement>(`[${lineupGoalSortOptionAttribute}]`)
      ?.click();

    await vi.waitFor(() => {
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(dialog.getAttribute('data-state')).toBe('closed');
    });
  });

  it('closes the current sort dialog when Sorare replaces its trigger', async () => {
    const trigger = document.querySelector<HTMLButtonElement>(
      '[data-native-sort]',
    );
    const dialog = document.querySelector<HTMLElement>('#sort-dialog');
    if (!trigger || !dialog) throw new Error('Expected native sort controls');

    sorter.start();
    const option = document.querySelector<HTMLButtonElement>(
      `[${lineupAaSortOptionAttribute}]`,
    );
    if (!option) throw new Error('Expected custom AA option');

    const replacement = trigger.cloneNode(true) as HTMLButtonElement;
    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      replacement.setAttribute('aria-expanded', 'false');
      dialog.setAttribute('data-state', 'closed');
    };
    document.addEventListener('keydown', handleEscape);
    option.addEventListener('click', () => trigger.replaceWith(replacement));
    try {
      option.click();

      await vi.waitFor(() => {
        expect(replacement.getAttribute('aria-expanded')).toBe('false');
        expect(dialog.getAttribute('data-state')).toBe('closed');
      });
    } finally {
      document.removeEventListener('keydown', handleEscape);
    }
  });

  it('accepts a stable one-page pool without a Sorare loading cell', async () => {
    const grid = document.querySelector<HTMLElement>('[data-player-grid]');
    const lastCell = document.querySelector<HTMLElement>(
      '[data-cell="missing"]',
    );
    if (!grid || !lastCell) throw new Error('Expected player grid');
    const progress: number[] = [];
    const growthTimeouts: number[] = [];
    vi.spyOn(lastCell, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 100, y: 1_200, width: 120, height: 280 }),
    );
    vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 100, y: 100, width: 900, height: 1_380 }),
    );
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1_200);
    const scrollTo = vi.spyOn(window, 'scrollTo');

    const result = await loadCompleteLineupPool(
      {
        isCancelled: () => false,
        onProgress: (count) => progress.push(count),
      },
      {
        getGrid: () => grid,
        waitForGrowth: async (
          _grid,
          _previousCount,
          _isCancelled,
          timeoutMs,
        ) => {
          growthTimeouts.push(timeoutMs ?? 0);
          return false;
        },
        maxPulses: 2,
        stableMissesRequired: 2,
      },
    );

    expect(result).toBe(grid);
    expect(progress).toEqual([3, 3, 3]);
    expect(growthTimeouts).toEqual([300, 300]);
    expect(grid.querySelector('[aria-busy="true"]')).toBeNull();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(lastCell.getAttribute('style')).toBeNull();
    expect(grid.style.minHeight).toBe('');
  });

  it('nudges the Sorare loading cell into view without scrolling', async () => {
    const grid = document.querySelector<HTMLElement>('[data-player-grid]');
    if (!grid) throw new Error('Expected player grid');
    const loadingCell = appendLoadingCell(grid);
    const originalLoadingStyle = loadingCell.getAttribute('style');
    const scrollTo = vi.spyOn(window, 'scrollTo');
    let stylesWhileTriggered:
      | {
          position: string;
          top: string;
          opacity: string;
          minHeight: string;
        }
      | undefined;
    const scrollEvent = vi.fn(() => {
      stylesWhileTriggered = {
        position: loadingCell.style.position,
        top: loadingCell.style.top,
        opacity: loadingCell.style.opacity,
        minHeight: grid.style.minHeight,
      };
    });
    window.addEventListener('scroll', scrollEvent);

    try {
      const result = await loadCompleteLineupPool(
        {
          isCancelled: () => false,
          onProgress: () => undefined,
        },
        {
          getGrid: () => grid,
          waitForGrowth: async () => false,
          maxPulses: 1,
          stableMissesRequired: 1,
        },
      );
      expect(result).toBeNull();
    } finally {
      window.removeEventListener('scroll', scrollEvent);
    }

    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollEvent).toHaveBeenCalled();
    expect(stylesWhileTriggered).toEqual({
      position: 'fixed',
      top: '0px',
      opacity: '0',
      minHeight: '1380px',
    });
    expect(loadingCell.getAttribute('style')).toBe(originalLoadingStyle);
    expect(grid.style.display).toBe('grid');
    expect(grid.style.minHeight).toBe('');
  });

  it('loads the next page through the hidden Sorare loading cell', async () => {
    const grid = document.querySelector<HTMLElement>('[data-player-grid]');
    if (!grid) throw new Error('Expected player grid');
    const loadingCell = appendLoadingCell(grid);
    const scrollTo = vi.spyOn(window, 'scrollTo');
    const handleScroll = (): void => {
      if (!loadingCell.isConnected) return;
      const loadedCell = document.createElement('div');
      loadedCell.innerHTML = '<img alt="Loaded Player - limited">';
      vi.spyOn(loadedCell, 'getBoundingClientRect').mockReturnValue(
        DOMRect.fromRect({ x: 100, y: 100, width: 120, height: 280 }),
      );
      loadingCell.replaceWith(loadedCell);
    };
    window.addEventListener('scroll', handleScroll);

    let result: HTMLElement | null;
    try {
      result = await loadCompleteLineupPool(
        {
          isCancelled: () => false,
          onProgress: () => undefined,
        },
        {
          getGrid: () => grid,
          waitForGrowth: async (_currentGrid, previousCount) =>
            grid.querySelectorAll('img').length > previousCount,
          maxPulses: 2,
          stableMissesRequired: 1,
        },
      );
    } finally {
      window.removeEventListener('scroll', handleScroll);
    }

    expect(result).toBe(grid);
    expect(grid.querySelectorAll('img')).toHaveLength(4);
    expect(grid.querySelector('[aria-busy="true"]')).toBeNull();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('adds the outfield sort options only while Sorare has its sort dialog open', () => {
    const trigger = document.querySelector<HTMLButtonElement>('[data-native-sort]');
    const dialog = document.querySelector<HTMLElement>('#sort-dialog');
    const chevron = trigger?.querySelector<SVGElement>('[data-icon]');
    if (!trigger || !dialog || !chevron) {
      throw new Error('Expected native sort controls');
    }
    trigger.setAttribute('aria-expanded', 'false');
    dialog.setAttribute('data-state', 'closed');

    sorter.start();
    expect(
      document.querySelector(`[${lineupGoalSortOptionAttribute}]`),
    ).toBeNull();
    expect(document.querySelector(`[${lineupAaSortOptionAttribute}]`)).toBeNull();

    trigger.setAttribute('aria-expanded', 'true');
    chevron.setAttribute('data-icon', 'iconChevronUp');
    dialog.setAttribute('data-state', 'open');
    sorter.scan(document);
    expect(
      document.querySelector(`[${lineupGoalSortOptionAttribute}]`),
    ).not.toBeNull();
    expect(
      document.querySelector(`[${lineupAaSortOptionAttribute}]`),
    ).not.toBeNull();
    expect(
      document.querySelector(`[${lineupCleanSheetSortOptionAttribute}]`),
    ).toBeNull();
  });

  it('sorts the goalkeeper slot by clean-sheet probability', async () => {
    const positionButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-lineup-positions] button',
      ),
    );
    const goalkeeperButton = positionButtons[0];
    const midfielderButton = positionButtons.find(
      (button) => button.textContent?.trim() === 'MF',
    );
    const market = document.querySelector<HTMLElement>('[data-player="market"]');
    const historical = document.querySelector<HTMLElement>(
      '[data-player="historical"]',
    );
    const marketCell = document.querySelector<HTMLElement>(
      '[data-cell="market"]',
    );
    const historicalCell = document.querySelector<HTMLElement>(
      '[data-cell="historical"]',
    );
    const missingCell = document.querySelector<HTMLElement>(
      '[data-cell="missing"]',
    );
    if (
      !goalkeeperButton ||
      !midfielderButton ||
      !market ||
      !historical ||
      !marketCell ||
      !historicalCell ||
      !missingCell
    ) {
      throw new Error('Expected goalkeeper sorting fixture');
    }
    setLineupSortPosition(market, 'Goalkeeper');
    setLineupSortPosition(historical, 'Goalkeeper');
    setLineupSortPosition(
      document.querySelector<HTMLElement>('[data-player="missing"]')!,
      'Goalkeeper',
    );
    setLineupCleanSheetSortValue(market, 0.31);
    setLineupCleanSheetSortValue(historical, 0.48);

    sorter.start();
    expect(
      document.querySelector(`[${lineupCleanSheetSortOptionAttribute}]`),
    ).toBeNull();
    goalkeeperButton.querySelector('span')!.textContent = 'TW';
    goalkeeperButton.click();
    await vi.waitFor(() =>
      expect(
        document.querySelector(`[${lineupCleanSheetSortOptionAttribute}]`),
      ).not.toBeNull(),
    );
    const option = document.querySelector<HTMLButtonElement>(
      `[${lineupCleanSheetSortOptionAttribute}]`,
    );
    expect(option?.textContent).toContain('Chance im nächsten Spiel');
    option?.click();

    await vi.waitFor(() => expect(historicalCell.style.order).toBe('-3'));
    expect(marketCell.style.order).toBe('-2');
    expect(missingCell.style.order).toBe('-1');
    expect(
      market.getAttribute(lineupCleanSheetSortProbabilityAttribute),
    ).toBe('0.31');
    expect(
      document.querySelector<HTMLElement>('[data-native-trigger-label]')
        ?.textContent,
    ).toBe('Clean Sheet');

    goalkeeperButton.classList.remove('highlighted');
    midfielderButton.classList.add('highlighted');
    midfielderButton.click();
    await vi.waitFor(() =>
      expect(
        document.querySelector(`[${lineupCleanSheetSortOptionAttribute}]`),
      ).toBeNull(),
    );
    expect(historicalCell.style.order).toBe('');
  });

  it('infers a goalkeeper picker from its card pool without a position button', async () => {
    document.querySelector('[data-lineup-positions]')?.remove();
    for (const player of document.querySelectorAll<HTMLElement>(
      '[data-player]',
    )) {
      setLineupSortPosition(player, 'Goalkeeper');
    }

    sorter.start();

    await vi.waitFor(() =>
      expect(
        document.querySelector(`[${lineupCleanSheetSortOptionAttribute}]`),
      ).not.toBeNull(),
    );
    expect(
      document.querySelector(`[${lineupGoalSortOptionAttribute}]`),
    ).not.toBeNull();
    expect(
      document.querySelector(`[${lineupAaSortOptionAttribute}]`),
    ).not.toBeNull();
  });

  it('mixes market and historical probabilities in one descending order', async () => {
    const market = document.querySelector<HTMLElement>('[data-player="market"]');
    const historical = document.querySelector<HTMLElement>(
      '[data-player="historical"]',
    );
    if (!market || !historical) throw new Error('Expected player containers');
    setLineupGoalSortValue(market, 0.35, 'market');
    setLineupGoalSortValue(historical, 0.5, 'historical');

    sorter.start();
    const option = document.querySelector<HTMLButtonElement>(
      `[${lineupGoalSortOptionAttribute}]`,
    );
    expect(option).not.toBeNull();
    expect(option?.closest('[data-native-options]')).not.toBeNull();
    expect(
      document.querySelector(
        `[data-picker-toolbar] > [${lineupGoalSortOptionAttribute}]`,
      ),
    ).toBeNull();
    expect(option?.textContent).toContain('Markt & Historie gemeinsam');
    option!.click();

    await vi.waitFor(() => {
      expect(
        document.querySelector<HTMLElement>('[data-cell="historical"]')?.style
          .order,
      ).toBe('-3');
    });
    expect(
      document.querySelector<HTMLElement>('[data-cell="market"]')?.style.order,
    ).toBe('-2');
    expect(
      document.querySelector<HTMLElement>('[data-cell="missing"]')?.style.order,
    ).toBe('-1');
    expect(option?.querySelector<HTMLInputElement>('input[type="radio"]')?.checked)
      .toBe(true);
    expect(
      document.querySelector<HTMLElement>('[data-native-trigger-label]')
        ?.textContent,
    ).toBe('Torquote');
    expect(
      document.querySelector<HTMLInputElement>(
        '[data-native-option="average"] input[type="radio"]',
      )?.checked,
    ).toBe(false);
  });

  it('waits for lazy cards and includes them in the first complete sort', async () => {
    sorter.stop();
    const grid = document.querySelector<HTMLElement>('[data-player-grid]');
    if (!grid) throw new Error('Expected player grid');
    sorter = new LineupCardSorter(async ({ onProgress }) => {
      const lateCell = document.createElement('div');
      lateCell.dataset.cell = 'late';
      lateCell.innerHTML =
        '<article data-player="late"><img alt="Late Player - limited"></article>';
      grid.append(lateCell);
      const latePlayer = lateCell.querySelector<HTMLElement>('[data-player="late"]');
      if (!latePlayer) throw new Error('Expected late player');
      setLineupAaSortValue(latePlayer, 30);
      onProgress(grid.children.length);
      return grid;
    });
    const market = document.querySelector<HTMLElement>('[data-player="market"]');
    const historical = document.querySelector<HTMLElement>(
      '[data-player="historical"]',
    );
    if (!market || !historical) throw new Error('Expected player containers');
    setLineupAaSortValue(market, 10);
    setLineupAaSortValue(historical, 20);

    sorter.start();
    document
      .querySelector<HTMLButtonElement>(`[${lineupAaSortOptionAttribute}]`)
      ?.click();

    await vi.waitFor(() => {
      expect(
        document.querySelector<HTMLElement>('[data-cell="late"]')?.style.order,
      ).toBe('-4');
    });
    expect(grid.children).toHaveLength(4);
  });

  it('sorts by AA, keeps missing values last, and switches custom modes', async () => {
    sorter.stop();
    let loadCalls = 0;
    sorter = new LineupCardSorter(async (context) => {
      loadCalls += 1;
      return immediatePoolLoader(context);
    });
    const market = document.querySelector<HTMLElement>('[data-player="market"]');
    const historical = document.querySelector<HTMLElement>(
      '[data-player="historical"]',
    );
    const marketCell = document.querySelector<HTMLElement>('[data-cell="market"]');
    const historicalCell = document.querySelector<HTMLElement>(
      '[data-cell="historical"]',
    );
    const missingCell = document.querySelector<HTMLElement>('[data-cell="missing"]');
    if (!market || !historical || !marketCell || !historicalCell || !missingCell) {
      throw new Error('Expected lineup sorting fixture');
    }
    setLineupGoalSortValue(market, 0.35, 'market');
    setLineupGoalSortValue(historical, 0.5, 'historical');
    setLineupAaSortValue(market, -5);
    setLineupAaSortValue(historical, -10);

    sorter.start();
    const goalOption = document.querySelector<HTMLButtonElement>(
      `[${lineupGoalSortOptionAttribute}]`,
    );
    const aaOption = document.querySelector<HTMLButtonElement>(
      `[${lineupAaSortOptionAttribute}]`,
    );
    expect(aaOption?.textContent).toContain('L10 · mindestens 60 Minuten');

    goalOption?.click();
    await vi.waitFor(() => expect(historicalCell.style.order).toBe('-3'));
    expect(loadCalls).toBe(1);
    aaOption?.click();
    expect(historicalCell.style.order).toBe('-3');
    await vi.waitFor(() => expect(marketCell.style.order).toBe('-3'));
    expect(loadCalls).toBe(1);
    expect(historicalCell.style.order).toBe('-2');
    expect(missingCell.style.order).toBe('-1');
    expect(
      document.querySelector<HTMLElement>('[data-native-trigger-label]')
        ?.textContent,
    ).toBe('AA');
    expect(
      goalOption?.querySelector<HTMLInputElement>('input[type="radio"]')?.checked,
    ).toBe(false);
    expect(
      aaOption?.querySelector<HTMLInputElement>('input[type="radio"]')?.checked,
    ).toBe(true);

    const untouchedMarketQueries = vi.spyOn(marketCell, 'querySelectorAll');
    const untouchedMissingQueries = vi.spyOn(missingCell, 'querySelectorAll');
    setLineupAaSortValue(historical, 12.5);
    await vi.waitFor(() => expect(historicalCell.style.order).toBe('-3'));
    expect(historical.getAttribute(lineupAaSortValueAttribute)).toBe('12.5');
    expect(untouchedMarketQueries).not.toHaveBeenCalled();
    expect(untouchedMissingQueries).not.toHaveBeenCalled();
  });

  it('re-sorts when a late historical value arrives and restores Sorare order', async () => {
    const market = document.querySelector<HTMLElement>('[data-player="market"]');
    const historical = document.querySelector<HTMLElement>(
      '[data-player="historical"]',
    );
    const marketCell = document.querySelector<HTMLElement>('[data-cell="market"]');
    const historicalCell = document.querySelector<HTMLElement>(
      '[data-cell="historical"]',
    );
    const nativeOption = document.querySelector<HTMLButtonElement>(
      '[data-native-option="soon"]',
    );
    if (!market || !historical || !marketCell || !historicalCell || !nativeOption) {
      throw new Error('Expected lineup sorting fixture');
    }
    marketCell.style.setProperty('order', '7', 'important');
    setLineupGoalSortValue(market, 0.35, 'market');
    setLineupGoalSortValue(historical, 0.2, 'historical');
    sorter.start();
    document
      .querySelector<HTMLButtonElement>(`[${lineupGoalSortOptionAttribute}]`)
      ?.click();
    await vi.waitFor(() => expect(marketCell.style.order).toBe('-3'));

    setLineupGoalSortValue(historical, 0.45, 'historical');
    await vi.waitFor(() => expect(historicalCell.style.order).toBe('-3'));
    expect(historical.getAttribute(lineupGoalSortProbabilityAttribute)).toBe(
      '0.45',
    );
    expect(historical.getAttribute(lineupGoalSortSourceAttribute)).toBe(
      'historical',
    );

    nativeOption.click();
    expect(marketCell.style.getPropertyValue('order')).toBe('7');
    expect(marketCell.style.getPropertyPriority('order')).toBe('important');
    expect(historicalCell.style.order).toBe('');
    expect(
      document.querySelector<HTMLElement>('[data-native-trigger-label]')
        ?.textContent,
    ).toBe('Durchschnittsbewertung');
    expect(
      document
        .querySelector<HTMLElement>('[data-native-trigger-label]')
        ?.hasAttribute('title'),
    ).toBe(false);
    expect(
      document.querySelector<HTMLInputElement>(
        `[${lineupGoalSortOptionAttribute}] input[type="radio"]`,
      )?.checked,
    ).toBe(false);
  });

  it('keeps a sorted card in place while Sorare remounts it on hover', async () => {
    sorter.stop();
    let loadCalls = 0;
    sorter = new LineupCardSorter(async (context) => {
      loadCalls += 1;
      return immediatePoolLoader(context);
    });
    const market = document.querySelector<HTMLElement>('[data-player="market"]');
    const historical = document.querySelector<HTMLElement>(
      '[data-player="historical"]',
    );
    const historicalCell = document.querySelector<HTMLElement>(
      '[data-cell="historical"]',
    );
    if (!market || !historical || !historicalCell) {
      throw new Error('Expected hover-remount sorting fixture');
    }
    setLineupAaSortValue(market, 10);
    setLineupAaSortValue(historical, 20);

    sorter.start();
    document
      .querySelector<HTMLButtonElement>(`[${lineupAaSortOptionAttribute}]`)
      ?.click();
    await vi.waitFor(() => expect(historicalCell.style.order).toBe('-3'));
    expect(loadCalls).toBe(1);

    const replacementCell = document.createElement('div');
    replacementCell.dataset.cell = 'historical';
    replacementCell.innerHTML = `
      <article
        data-player="historical"
        data-sorare-overlay-sort-data-ready="false"
      >
        <img alt="Historical Player - limited">
      </article>
    `;
    historicalCell.replaceWith(replacementCell);

    await vi.waitFor(() => expect(replacementCell.style.order).toBe('-3'));
    expect(loadCalls).toBe(1);
    const replacementPlayer = replacementCell.querySelector<HTMLElement>(
      '[data-player="historical"]',
    );
    if (!replacementPlayer) throw new Error('Expected replacement player');
    setLineupAaSortValue(replacementPlayer, 20);
    setLineupSortDataReady(replacementPlayer, true);

    await new Promise((resolve) => window.setTimeout(resolve, 120));
    expect(replacementCell.style.order).toBe('-3');
    expect(loadCalls).toBe(1);
  });

  it('restores the old grid before loading and sorting a newly selected position', async () => {
    sorter.stop();
    const grid = document.querySelector<HTMLElement>('[data-player-grid]');
    const market = document.querySelector<HTMLElement>('[data-player="market"]');
    const historical = document.querySelector<HTMLElement>(
      '[data-player="historical"]',
    );
    const marketCell = document.querySelector<HTMLElement>('[data-cell="market"]');
    const defenderButton = document.querySelector<HTMLButtonElement>(
      '[data-lineup-positions] button:first-child',
    );
    const midfielderButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-lineup-positions] button'),
    ).find((button) => button.textContent?.trim() === 'MF');
    if (
      !grid ||
      !market ||
      !historical ||
      !marketCell ||
      !defenderButton ||
      !midfielderButton
    ) {
      throw new Error('Expected lineup position fixture');
    }
    setLineupAaSortValue(market, 20);
    setLineupAaSortValue(historical, 10);

    let loadCalls = 0;
    let resolveNewPosition: ((value: HTMLElement | null) => void) | undefined;
    const newPositionPool = new Promise<HTMLElement | null>((resolve) => {
      resolveNewPosition = resolve;
    });
    sorter = new LineupCardSorter(async ({ onProgress }) => {
      loadCalls += 1;
      onProgress(grid.children.length);
      return loadCalls === 1 ? grid : newPositionPool;
    });
    midfielderButton.addEventListener('click', () => {
      defenderButton.classList.remove('highlighted');
      midfielderButton.classList.add('highlighted');
    });

    sorter.start();
    document
      .querySelector<HTMLButtonElement>(`[${lineupAaSortOptionAttribute}]`)
      ?.click();
    await vi.waitFor(() => expect(marketCell.style.order).toBe('-3'));

    midfielderButton.click();
    expect(marketCell.style.order).toBe('');
    await vi.waitFor(() => expect(loadCalls).toBe(2));
    resolveNewPosition?.(grid);
    await vi.waitFor(() => expect(marketCell.style.order).toBe('-3'));
  });

  it('refuses to sort a stale grid from a different active position', async () => {
    const market = document.querySelector<HTMLElement>('[data-player="market"]');
    const historical = document.querySelector<HTMLElement>(
      '[data-player="historical"]',
    );
    const marketCell = document.querySelector<HTMLElement>('[data-cell="market"]');
    if (!market || !historical || !marketCell) {
      throw new Error('Expected lineup sorting fixture');
    }
    setLineupSortPosition(market, 'Midfielder');
    setLineupSortPosition(historical, 'Midfielder');
    setLineupAaSortValue(market, 20);
    setLineupAaSortValue(historical, 10);

    sorter.start();
    document
      .querySelector<HTMLButtonElement>(`[${lineupAaSortOptionAttribute}]`)
      ?.click();

    await vi.waitFor(() => {
      expect(
        document.querySelector<HTMLElement>('[data-native-trigger-label]')
          ?.textContent,
      ).toBe('AA · Wiederholen');
    });
    expect(marketCell.style.order).toBe('');
  });

  it('accepts isolated current-player position changes in a valid card pool', async () => {
    const market = document.querySelector<HTMLElement>(
      '[data-player="market"]',
    );
    const historical = document.querySelector<HTMLElement>(
      '[data-player="historical"]',
    );
    const missing = document.querySelector<HTMLElement>(
      '[data-player="missing"]',
    );
    const marketCell = document.querySelector<HTMLElement>(
      '[data-cell="market"]',
    );
    if (!market || !historical || !missing || !marketCell) {
      throw new Error('Expected lineup sorting fixture');
    }
    setLineupSortPosition(market, 'Defender');
    setLineupSortPosition(historical, 'Defender');
    setLineupSortPosition(missing, 'Forward');
    setLineupAaSortValue(market, 20);
    setLineupAaSortValue(historical, 10);

    sorter.start();
    document
      .querySelector<HTMLButtonElement>(`[${lineupAaSortOptionAttribute}]`)
      ?.click();

    await vi.waitFor(() => expect(marketCell.style.order).toBe('-3'));
    expect(
      document.querySelector<HTMLElement>('[data-native-trigger-label]')
        ?.textContent,
    ).toBe('AA');
  });

  it('still rejects a pool whose known positions are mostly stale', async () => {
    const market = document.querySelector<HTMLElement>(
      '[data-player="market"]',
    );
    const historical = document.querySelector<HTMLElement>(
      '[data-player="historical"]',
    );
    const missing = document.querySelector<HTMLElement>(
      '[data-player="missing"]',
    );
    const marketCell = document.querySelector<HTMLElement>(
      '[data-cell="market"]',
    );
    if (!market || !historical || !missing || !marketCell) {
      throw new Error('Expected lineup sorting fixture');
    }
    setLineupSortPosition(market, 'Midfielder');
    setLineupSortPosition(historical, 'Midfielder');
    setLineupSortPosition(missing, 'Defender');
    setLineupAaSortValue(market, 20);
    setLineupAaSortValue(historical, 10);

    sorter.start();
    document
      .querySelector<HTMLButtonElement>(`[${lineupAaSortOptionAttribute}]`)
      ?.click();

    await vi.waitFor(() => {
      expect(
        document.querySelector<HTMLElement>('[data-native-trigger-label]')
          ?.textContent,
      ).toBe('AA · Wiederholen');
    });
    expect(marketCell.style.order).toBe('');
  });

  it('does not retry an unchanged failed pool until its cards change', async () => {
    sorter.stop();
    const grid = document.querySelector<HTMLElement>('[data-player-grid]');
    if (!grid) throw new Error('Expected player grid');
    let loadCalls = 0;
    sorter = new LineupCardSorter(async () => {
      loadCalls += 1;
      return null;
    });

    sorter.start();
    document
      .querySelector<HTMLButtonElement>(`[${lineupAaSortOptionAttribute}]`)
      ?.click();
    await vi.waitFor(() => expect(loadCalls).toBe(1));
    await vi.waitFor(() => {
      expect(
        document.querySelector<HTMLElement>('[data-native-trigger-label]')
          ?.textContent,
      ).toBe('AA · Wiederholen');
    });

    sorter.scan(document);
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    expect(loadCalls).toBe(1);

    grid.insertAdjacentHTML(
      'beforeend',
      '<div><img alt="Newly loaded player - limited"></div>',
    );
    sorter.scan(document);
    await vi.waitFor(() => expect(loadCalls).toBe(2));
  });
});
