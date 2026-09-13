import type { LineupSortReadiness, SortMetricReadiness } from '@sorare-overlay/shared';

export const sortReadinessAttribute = 'data-sorare-overlay-sort-readiness';
export const sortFinalCheckAttribute = 'data-sorare-overlay-sort-final-check';
export const sortRetryEvent = 'sorare-overlay:lineup-sort-retry';
export const sortModeEvent = 'sorare-overlay:lineup-sort-mode';
const changedEvent = 'sorare-overlay:lineup-sort-value-changed';
export const readinessIsSettled = (state: SortMetricReadiness): boolean => state === 'ready' || state === 'unavailable';
export function uniformReadiness(state: SortMetricReadiness): LineupSortReadiness {
  return { goal: state, aa: state, cleanSheet: state };
}
export function readSortReadiness(container: HTMLElement): LineupSortReadiness | null {
  const raw = container.getAttribute(sortReadinessAttribute);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const valid = (v: unknown): v is SortMetricReadiness => typeof v === 'string' && ['pending', 'ready', 'unavailable', 'error'].includes(v);
    return valid(value.goal) && valid(value.aa) && valid(value.cleanSheet)
      ? { goal: value.goal, aa: value.aa, cleanSheet: value.cleanSheet } : null;
  } catch { return null; }
}
export function setSortReadiness(container: HTMLElement, readiness: LineupSortReadiness | null): void {
  const value = readiness ? JSON.stringify(readiness) : null;
  if (container.getAttribute(sortReadinessAttribute) === value) return;
  if (value === null) container.removeAttribute(sortReadinessAttribute);
  else container.setAttribute(sortReadinessAttribute, value);
  container.dispatchEvent(new CustomEvent(changedEvent, { bubbles: true }));
}
export function setSortFinalCheck(grid: HTMLElement, state: 'pending' | 'complete'): void {
  grid.setAttribute(sortFinalCheckAttribute, state);
  grid.dispatchEvent(new CustomEvent(changedEvent, { bubbles: true }));
}
