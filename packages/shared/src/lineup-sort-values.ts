import type {
  HistoricalMarketWindow,
  LineupSortValue,
  LineupSortReadiness,
  PlayerStats,
} from './contracts.js';
import { fixtureStatusKey } from './fixture-rollover.js';

export function lineupGoalSortValue(
  stats: PlayerStats,
  historicalGoalWindow: HistoricalMarketWindow | null = null,
): LineupSortValue['goal'] {
  if (stats.position === 'Goalkeeper') return null;
  const marketProbability = stats.nextGame?.marketOdds?.goal?.probability;
  if (marketProbability !== null && marketProbability !== undefined) {
    return { probability: marketProbability, source: 'market' };
  }

  const selectedHistory = historicalGoalWindow
    ? stats.historicalGoals?.[`l${historicalGoalWindow}`]
    : undefined;
  // A requested L15/L40 is not interchangeable with a provisional L10.
  const historicalMetric = historicalGoalWindow ? selectedHistory : stats.goalL10;
  return historicalMetric?.value !== null && historicalMetric?.value !== undefined && historicalMetric.sampleSize > 0
    ? { probability: historicalMetric.value, source: 'historical' }
    : null;
}

export function lineupSortReadinessForPlayer(
  stats: PlayerStats,
  historicalGoalWindow: HistoricalMarketWindow | null = null,
): LineupSortReadiness {
  const pending = new Set(stats.pendingRefreshes ?? []);
  const goal = lineupGoalSortValue(stats, historicalGoalWindow);
  const historyMissing = historicalGoalWindow !== null && stats.historicalGoals?.[`l${historicalGoalWindow}`] === undefined;
  const outfield = stats.position !== 'Goalkeeper';
  const usesCs = !outfield || stats.position === 'Defender';
  return {
    goal: !outfield ? 'unavailable' : goal?.source === 'market' ? 'ready' :
      pending.has('formHistory') || historyMissing || pending.has('fixture') || pending.has('marketOdds') ? 'pending' :
        goal ? 'ready' : 'unavailable',
    aa: pending.has('formHistory') ? 'pending' : stats.aaL10.value === null ? 'unavailable' : 'ready',
    cleanSheet: !usesCs ? 'unavailable' : stats.nextGame?.cleanSheetProbability != null ? 'ready' :
      pending.has('fixture') ? 'pending' : 'unavailable',
  };
}

export function lineupSortValueForPlayer(
  stats: PlayerStats,
  historicalGoalWindow: HistoricalMarketWindow | null = null,
): LineupSortValue {
  return {
    readiness: lineupSortReadinessForPlayer(stats, historicalGoalWindow),
    slug: stats.slug,
    displayName: stats.displayName,
    position: stats.position,
    goal: lineupGoalSortValue(stats, historicalGoalWindow),
    aa: stats.aaL10.value,
    ...(stats.fixtureRefresh ? {fixtureRefresh:stats.fixtureRefresh} : {}),
    fixtureIdentity: stats.nextGame ? fixtureStatusKey(stats.nextGame) : null,
    cleanSheet:
      stats.position === 'Goalkeeper' || stats.position === 'Defender'
        ? (stats.nextGame?.cleanSheetProbability ?? null)
        : null,
  };
}
