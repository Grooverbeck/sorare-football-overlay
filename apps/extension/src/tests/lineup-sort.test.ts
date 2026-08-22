import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LineupCardSorter,
  lineupAaSortOptionAttribute,
  lineupAaSortValueAttribute,
  lineupGoalSortOptionAttribute,
  lineupGoalSortProbabilityAttribute,
  lineupGoalSortSourceAttribute,
  setLineupAaSortValue,
  setLineupGoalSortValue,
  supportsLineupSortPath,
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

describe('lineup card sorting', () => {
  let sorter: LineupCardSorter;

  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = lineupBuilderMarkup();
    window.history.replaceState({}, '', '/de/football/series/test/compose-team/lineup');
    sorter = new LineupCardSorter();
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

  it('adds both custom options only while Sorare has its sort dialog open', () => {
    const trigger = document.querySelector<HTMLButtonElement>('[data-native-sort]');
    const dialog = document.querySelector<HTMLElement>('#sort-dialog');
    if (!trigger || !dialog) throw new Error('Expected native sort controls');
    trigger.setAttribute('aria-expanded', 'false');
    dialog.setAttribute('data-state', 'closed');

    sorter.start();
    expect(
      document.querySelector(`[${lineupGoalSortOptionAttribute}]`),
    ).toBeNull();
    expect(document.querySelector(`[${lineupAaSortOptionAttribute}]`)).toBeNull();

    trigger.setAttribute('aria-expanded', 'true');
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
});
