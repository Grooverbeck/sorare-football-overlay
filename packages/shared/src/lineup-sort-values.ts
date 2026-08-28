import type {
  HistoricalMarketWindow,
  LineupSortValue,
  PlayerStats,
} from './contracts.js';

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
  const historicalMetric =
    selectedHistory?.value !== null && selectedHistory?.value !== undefined
      ? selectedHistory
      : stats.goalL10;
  return historicalMetric.value !== null && historicalMetric.sampleSize > 0
    ? { probability: historicalMetric.value, source: 'historical' }
    : null;
}

export function lineupSortValueForPlayer(
  stats: PlayerStats,
  historicalGoalWindow: HistoricalMarketWindow | null = null,
): LineupSortValue {
  return {
    slug: stats.slug,
    displayName: stats.displayName,
    position: stats.position,
    goal: lineupGoalSortValue(stats, historicalGoalWindow),
    aa: stats.aaL10.value,
  };
}
