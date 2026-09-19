import {fixtureStatusKey, type FootballPosition, type GoalMarketSnapshot, type PlayerStats} from '@sorare-overlay/shared';

export interface GoalMarketState {
  slug: string;
  position: FootballPosition;
  fixtureIdentity: string;
  market: GoalMarketSnapshot;
}

// Per physical card, shared by compact hydration and the visible overlay.
// No persistent cache, timers, provider requests or document-wide scans.
const states = new WeakMap<HTMLElement, GoalMarketState>();
export const goalMarketChangedEvent = 'sorare-overlay:goal-market-changed';

export function goalMarketSignature(market: GoalMarketSnapshot | undefined): string {
  return JSON.stringify(market ? [market.source, market.capturedAt, market.goal.probability,
    market.goal.bookmakerCount, market.goal.bookmakerQuotes?.map(q =>
      [q.key, q.title, q.decimalOdds, q.probability, q.providerMarketName, q.providerSelectionLabel])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))] : null);
}

export function readGoalMarketState(container: HTMLElement): GoalMarketState | undefined {
  return states.get(container);
}

export function clearGoalMarketState(container: HTMLElement): void {
  states.delete(container);
}

export function rememberGoalMarketState(container: HTMLElement, incoming: GoalMarketState): GoalMarketState {
  const current = states.get(container);
  const sameScope = current?.slug === incoming.slug && current.position === incoming.position &&
    current.fixtureIdentity === incoming.fixtureIdentity;
  if (sameScope) {
    const currentAt = Date.parse(current.market.capturedAt), incomingAt = Date.parse(incoming.market.capturedAt);
    if (currentAt > incomingAt || goalMarketSignature(current.market) === goalMarketSignature(incoming.market)) return current;
    // Equal timestamps do not prove that a conflicting price is newer. Allow
    // detail enrichment at the same price, but never strip existing quotes.
    if (currentAt === incomingAt && (current.market.goal.probability !== incoming.market.goal.probability ||
      (current.market.goal.bookmakerQuotes?.length ?? 0) > (incoming.market.goal.bookmakerQuotes?.length ?? 0))) return current;
  }
  states.set(container, incoming);
  return incoming;
}

export function withGoalMarketState(container: HTMLElement, stats: PlayerStats, remember = true): PlayerStats {
  const fixtureIdentity = stats.nextGame && fixtureStatusKey(stats.nextGame);
  if (!fixtureIdentity || !stats.nextGame || stats.position === 'Goalkeeper') return stats;
  const market = stats.nextGame.marketOdds;
  if (remember && market?.goal) rememberGoalMarketState(container, {
    slug: stats.slug, position: stats.position, fixtureIdentity,
    market: {source: market.source, capturedAt: market.capturedAt, goal: market.goal},
  });
  const state = states.get(container);
  if (!state || state.slug !== stats.slug || state.position !== stats.position || state.fixtureIdentity !== fixtureIdentity) return stats;
  if (market?.goal === state.market.goal) return stats;
  return {...stats, nextGame: {...stats.nextGame, marketOdds: {
    source: market && market.source !== state.market.source ? 'mixed' : state.market.source,
    capturedAt: market && Date.parse(market.capturedAt) > Date.parse(state.market.capturedAt) ? market.capturedAt : state.market.capturedAt,
    goal: state.market.goal, assist: market?.assist ?? null, decisive: market?.decisive ?? null,
  }}};
}
