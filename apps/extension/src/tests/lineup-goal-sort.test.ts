import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LineupGoalOddsSorter,
  lineupGoalSortControlAttribute,
  lineupGoalSortProbabilityAttribute,
  lineupGoalSortSourceAttribute,
  setLineupGoalSortValue,
  supportsLineupGoalSortPath,
} from '../lineup-goal-sort.js';

function lineupBuilderMarkup(): string {
  return `
    <header>
      <div data-picker-toolbar>
        <input type="search" placeholder="Spieler suchen">
        <button type="button" aria-haspopup="dialog" data-native-sort>
          Durchschnittsbewertung
          <svg data-icon="iconChevronDown"></svg>
        </button>
        <button type="button" aria-haspopup="dialog" data-native-filter>
          <svg data-icon="iconFilter"></svg>
        </button>
      </div>
    </header>
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

describe('lineup goal-odds sorting', () => {
  let sorter: LineupGoalOddsSorter;

  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = lineupBuilderMarkup();
    window.history.replaceState({}, '', '/de/football/series/test/compose-team/lineup');
    sorter = new LineupGoalOddsSorter();
  });

  afterEach(() => {
    sorter.stop();
    document.body.replaceChildren();
  });

  it('supports compose-team routes only', () => {
    expect(
      supportsLineupGoalSortPath('/de/football/series/test/compose-team/lineup'),
    ).toBe(true);
    expect(supportsLineupGoalSortPath('/de/football/lineups/lineup')).toBe(
      false,
    );
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
    const control = document.querySelector<HTMLButtonElement>(
      `[${lineupGoalSortControlAttribute}]`,
    );
    expect(control).not.toBeNull();
    control!.click();

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
    expect(control?.getAttribute('aria-pressed')).toBe('true');
    expect(control?.textContent).toContain('Torquote ↓');
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
    const nativeSort = document.querySelector<HTMLButtonElement>('[data-native-sort]');
    if (!market || !historical || !marketCell || !historicalCell || !nativeSort) {
      throw new Error('Expected lineup sorting fixture');
    }
    marketCell.style.setProperty('order', '7', 'important');
    setLineupGoalSortValue(market, 0.35, 'market');
    setLineupGoalSortValue(historical, 0.2, 'historical');
    sorter.start();
    document
      .querySelector<HTMLButtonElement>(`[${lineupGoalSortControlAttribute}]`)
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

    nativeSort.click();
    expect(marketCell.style.getPropertyValue('order')).toBe('7');
    expect(marketCell.style.getPropertyPriority('order')).toBe('important');
    expect(historicalCell.style.order).toBe('');
  });
});
