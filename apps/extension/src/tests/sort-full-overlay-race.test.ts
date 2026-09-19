import type {LineupSortReadiness, LineupSortValue, LineupSortValuesSuccessResponse} from '@sorare-overlay/shared';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {LineupSortHydrator} from '../lineup-sort-hydrator.js';
import {fixtureIdentityAttribute} from '../fixture-refresh.js';
import {readSortReadiness, setSortReadiness, sortFinalCheckAttribute} from '../lineup-sort-readiness.js';
import {
  markLineupSortFullDataUpdated, setLineupSortDataReady,
  setLineupAaSortValue, setLineupCleanSheetSortValue, setLineupGoalSortValue,
  lineupSortLightweightReadyAttribute,
} from '../lineup-sort.js';

let hydrator: LineupSortHydrator | undefined;
afterEach(() => {hydrator?.stop(); hydrator = undefined; document.body.replaceChildren(); vi.useRealTimers();});
const fixture = 'fixture-status:v1:2000000000:home:away';

function setup() {
  document.body.innerHTML = '<section><article></article></section>';
  const grid = document.querySelector('section')!;
  const card = document.querySelector('article')!;
  card.setAttribute(fixtureIdentityAttribute, fixture);
  return {grid, card, target: {container: card, slug: 'race-player', position: 'Defender' as const}};
}

function fullOverlay(card: HTMLElement, readiness: LineupSortReadiness) {
  card.removeAttribute(lineupSortLightweightReadyAttribute);
  markLineupSortFullDataUpdated(card);
  setLineupGoalSortValue(card, readiness.goal === 'unavailable' ? null : .8, 'market');
  setLineupAaSortValue(card, readiness.aa === 'pending' ? null : 33);
  setLineupCleanSheetSortValue(card, readiness.cleanSheet === 'pending' ? null : .6);
  setLineupSortDataReady(card, true);
  setSortReadiness(card, readiness);
}

function response(overrides: Partial<LineupSortValue> = {}): LineupSortValuesSuccessResponse {
  return {data: [{slug: 'race-player', displayName: 'Race Player', position: 'Defender',
    fixtureIdentity: fixture, goal: {probability: .2, source: 'market'}, aa: 10, cleanSheet: .4,
    readiness: {goal: 'ready', aa: 'ready', cleanSheet: 'ready'}, ...overrides}],
    meta: {requested: 1, returned: 1, cacheHits: 1, source: 'sorare', durationMs: 1}};
}

describe('full-overlay/compact readiness races', () => {
  it.each([
    ['Goalkeeper', 'ready'], ['Goalkeeper', 'unavailable'],
    ['Defender', 'ready'], ['Defender', 'unavailable'],
  ] as const)('finishes a late %s CS check as %s on the next fresh cache read', async (position, settled) => {
    vi.useFakeTimers();
    const {grid, card, target: originalTarget} = setup();
    const target = {...originalTarget, position};
    const goalReadiness = position === 'Goalkeeper' ? 'unavailable' : 'ready';
    const incoming = response({position, goal: position === 'Goalkeeper' ? null : {probability: .2, source: 'market'},
      cleanSheet: settled === 'ready' ? .4 : null,
      readiness: {goal: goalReadiness, aa: 'ready', cleanSheet: settled}});
    const fetcher = vi.fn(async () => {
      if (fetcher.mock.calls.length === 1) fullOverlay(card, {goal: goalReadiness, aa: 'ready', cleanSheet: 'pending'});
      return incoming;
    });
    hydrator = new LineupSortHydrator(fetcher, 50, [1_000, 5_000], 0);
    hydrator.configureMode('clean-sheet');
    await hydrator.hydrate(grid, [target]);
    hydrator.finalizePool(grid);
    // The full response arrived after this read started. Do not falsely
    // certify that old read; the next request must confirm the current state.
    expect(readSortReadiness(card)?.cleanSheet).toBe('pending');
    expect(grid.getAttribute(sortFinalCheckAttribute)).toBe('pending');
    await vi.advanceTimersByTimeAsync(1_001);
    expect(readSortReadiness(card)?.cleanSheet).toBe(settled);
    expect(grid.getAttribute(sortFinalCheckAttribute)).toBe('complete');
    expect(card.getAttribute('data-sorare-overlay-clean-sheet-sort-probability')).toBe(settled === 'ready' ? '0.4' : null);
    expect(card.getAttribute('data-sorare-overlay-aa-sort-value')).toBe('33');
    expect(card.getAttribute('data-sorare-overlay-goal-sort-probability')).toBe(position === 'Goalkeeper' ? null : '0.8');
    expect(card.hasAttribute(lineupSortLightweightReadyAttribute)).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(settled === 'ready' ? 2 : 3); // includes final cache barrier
  });

  it.each(['ready', 'unavailable'] as const)('also finishes pending AA as %s without replacing existing CS or goal odds', async settled => {
    vi.useFakeTimers();
    const {grid, card, target} = setup();
    const fetcher = vi.fn(async () => {
      if (fetcher.mock.calls.length === 1) fullOverlay(card, {goal: 'ready', aa: 'pending', cleanSheet: 'ready'});
      return response({aa: settled === 'ready' ? 10 : null,
        readiness: {goal: 'ready', aa: settled, cleanSheet: 'ready'}});
    });
    hydrator = new LineupSortHydrator(fetcher, 50, [1_000], 0);
    hydrator.configureMode('aa');
    await hydrator.hydrate(grid, [target]);
    hydrator.finalizePool(grid);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(readSortReadiness(card)?.aa).toBe(settled);
    expect(grid.getAttribute(sortFinalCheckAttribute)).toBe('complete');
    expect(card.getAttribute('data-sorare-overlay-clean-sheet-sort-probability')).toBe('0.6');
    expect(card.getAttribute('data-sorare-overlay-goal-sort-probability')).toBe('0.8');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps genuine pending CS data pending, then reports an error after bounded retries', async () => {
    vi.useFakeTimers();
    const {grid, card, target} = setup();
    const fetcher = vi.fn(async () => {
      if (fetcher.mock.calls.length === 1) fullOverlay(card, {goal: 'ready', aa: 'ready', cleanSheet: 'pending'});
      return response({cleanSheet: null, readiness: {goal: 'ready', aa: 'ready', cleanSheet: 'pending'}});
    });
    hydrator = new LineupSortHydrator(fetcher, 50, [1_000], 0);
    hydrator.configureMode('clean-sheet');
    await hydrator.hydrate(grid, [target]);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(readSortReadiness(card)?.cleanSheet).toBe('error');
    expect(card.getAttribute('data-sorare-overlay-aa-sort-value')).toBe('33');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('never overwrites an actual newer full-overlay CS quote with a cache miss', async () => {
    vi.useFakeTimers();
    const {grid, card, target} = setup();
    const fetcher = vi.fn(async () => {
      fullOverlay(card, {goal: 'ready', aa: 'ready', cleanSheet: 'ready'});
      return response({cleanSheet: null, readiness: {goal: 'ready', aa: 'ready', cleanSheet: 'unavailable'}});
    });
    hydrator = new LineupSortHydrator(fetcher, 50, [1_000], 0);
    hydrator.configureMode('clean-sheet');
    await hydrator.hydrate(grid, [target]);
    hydrator.finalizePool(grid);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(readSortReadiness(card)?.cleanSheet).toBe('ready');
    expect(card.getAttribute('data-sorare-overlay-clean-sheet-sort-probability')).toBe('0.6');
    expect(card.getAttribute('data-sorare-overlay-aa-sort-value')).toBe('33');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('preserves a new full-overlay quote that arrives during the retry itself', async () => {
    vi.useFakeTimers();
    const {grid, card, target} = setup();
    const fetcher = vi.fn(async () => {
      fullOverlay(card, {goal: 'ready', aa: 'ready', cleanSheet: fetcher.mock.calls.length === 1 ? 'pending' : 'ready'});
      return response({cleanSheet: null, readiness: {goal: 'ready', aa: 'ready', cleanSheet: 'unavailable'}});
    });
    hydrator = new LineupSortHydrator(fetcher, 50, [1_000], 0);
    hydrator.configureMode('clean-sheet');
    await hydrator.hydrate(grid, [target]);
    hydrator.finalizePool(grid);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(readSortReadiness(card)?.cleanSheet).toBe('ready');
    expect(card.getAttribute('data-sorare-overlay-clean-sheet-sort-probability')).toBe('0.6');
    expect(card.getAttribute('data-sorare-overlay-aa-sort-value')).toBe('33');
    expect(grid.getAttribute(sortFinalCheckAttribute)).toBe('complete');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not settle a newer fixture using a result for the retired previous game', async () => {
    vi.useFakeTimers();
    const {grid, card, target} = setup();
    const nextFixture = 'fixture-status:v1:2000100000:home:next';
    const fetcher = vi.fn(async () => {
      if (fetcher.mock.calls.length === 1) {
        card.setAttribute(fixtureIdentityAttribute, nextFixture);
        fullOverlay(card, {goal: 'ready', aa: 'ready', cleanSheet: 'pending'});
      }
      return response({cleanSheet: null, readiness: {goal: 'ready', aa: 'ready', cleanSheet: 'unavailable'}});
    });
    hydrator = new LineupSortHydrator(fetcher, 50, [1_000], 0);
    hydrator.configureMode('clean-sheet');
    await hydrator.hydrate(grid, [target]);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(card.getAttribute(fixtureIdentityAttribute)).toBe(nextFixture);
    expect(readSortReadiness(card)?.cleanSheet).toBe('error');
    expect(card.getAttribute('data-sorare-overlay-goal-sort-probability')).toBe('0.8');
  });
});
