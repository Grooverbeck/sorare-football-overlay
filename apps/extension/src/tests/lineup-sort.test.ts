import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LineupCardSorter,
  lineupAaSortOptionAttribute,
  lineupAaSortValueAttribute,
  lineupGoalSortOptionAttribute,
  lineupGoalSortProbabilityAttribute,
  lineupGoalSortSourceAttribute,
  loadCompleteLineupPool,
  setLineupAaSortValue,
  setLineupGoalSortValue,
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
        <button type="button" aria-haspopup="dialog" data-native-filter>
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
    <nav data-lineup-positions>
      <button type="button" class="highlighted"><span>VER</span></button>
      <button type="button"><span>MF</span></button>
      <button type="button"><span>FWD</span></button>
      <button type="button"><span>EX</span></button>
    </nav>
    <div data-player-grid style="display: grid">
      <div data-cell="market">
        <article data-player="market">
          <img alt="Market Player - limited">
        </article>
      </div>
      <div data-cell="historical">
        <article data-player="historical">
          <img alt="Historical Player - limited">
        </article>
      </div>
      <div data-cell="missing">
        <article data-player="missing">
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

  it('supports compose-team routes only', () => {
    expect(
      supportsLineupSortPath('/de/football/series/test/compose-team/lineup'),
    ).toBe(true);
    expect(supportsLineupSortPath('/de/football/lineups/lineup')).toBe(
      false,
    );
  });

  it('loads every lazy Sorare page before declaring the player pool complete', async () => {
    const grid = document.querySelector<HTMLElement>('[data-player-grid]');
    if (!grid) throw new Error('Expected player grid');
    const pages = [
      '<div><img alt="Lazy Player One - limited"></div>',
      '<div><img alt="Lazy Player Two - limited"></div>',
    ];
    const progress: number[] = [];
    const revealGridEnd = vi.fn(async () => {
      const page = pages.shift();
      if (page) grid.insertAdjacentHTML('beforeend', page);
      return false;
    });

    const result = await loadCompleteLineupPool(
      {
        isCancelled: () => false,
        onProgress: (count) => progress.push(count),
      },
      {
        getGrid: () => grid,
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
    expect(progress.at(-1)).toBe(5);
  });

  it('reveals the lazy-load trigger without moving the visible page', async () => {
    const grid = document.querySelector<HTMLElement>('[data-player-grid]');
    const lastCell = document.querySelector<HTMLElement>(
      '[data-cell="missing"]',
    );
    if (!grid || !lastCell) throw new Error('Expected player grid');
    lastCell.style.order = '7';
    const originalChildren = Array.from(grid.children);
    const originalGridMinHeight = grid.style.minHeight;
    const initialScrollX = window.scrollX;
    const initialScrollY = window.scrollY;
    vi.spyOn(lastCell, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 1_200, width: 120, height: 260 }),
    );
    vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 24, y: 120, width: 900, height: 1_340 }),
    );
    const scrollTo = vi.spyOn(window, 'scrollTo');
    let stylesWhileTriggered:
      | { position: string; opacity: string; gridMinHeight: string }
      | undefined;
    const scrollEvent = vi.fn(() => {
      stylesWhileTriggered = {
        position: lastCell.style.position,
        opacity: lastCell.style.opacity,
        gridMinHeight: grid.style.minHeight,
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
      opacity: '0',
      gridMinHeight: '1340px',
    });
    expect(window.scrollX).toBe(initialScrollX);
    expect(window.scrollY).toBe(initialScrollY);
    expect(Array.from(grid.children)).toEqual(originalChildren);
    expect(lastCell.style.order).toBe('7');
    expect(grid.style.minHeight).toBe(originalGridMinHeight);
  });

  it('accepts a stable pool whose final card is already visible', async () => {
    const grid = document.querySelector<HTMLElement>('[data-player-grid]');
    const lastCell = document.querySelector<HTMLElement>(
      '[data-cell="missing"]',
    );
    if (!grid || !lastCell) throw new Error('Expected player grid');
    vi.spyOn(lastCell, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 24, y: 120, width: 120, height: 260 }),
    );

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

    expect(result).toBe(grid);
  });

  it('adds both custom options only while Sorare has its sort dialog open', () => {
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
    aaOption?.click();
    await vi.waitFor(() => expect(marketCell.style.order).toBe('-3'));
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

    setLineupAaSortValue(historical, 12.5);
    await vi.waitFor(() => expect(historicalCell.style.order).toBe('-3'));
    expect(historical.getAttribute(lineupAaSortValueAttribute)).toBe('12.5');
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
      document.querySelector<HTMLInputElement>(
        `[${lineupGoalSortOptionAttribute}] input[type="radio"]`,
      )?.checked,
    ).toBe(false);
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
      ).toBe('AA erneut');
    });
    expect(marketCell.style.order).toBe('');
  });
});
