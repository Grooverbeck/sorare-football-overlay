import type { FootballPosition, Metric, PlayerStats } from './contracts.js';

export interface PlayerAppearance {
  date: string;
  allAroundScore: number | null;
  goals: number | null;
  minsPlayed: number | null;
  cleanSheet60: number | null;
  lowCoverage: boolean;
  position: FootballPosition;
}

export interface CalculationOptions {
  excludeLowCoverage: boolean;
  limit?: number;
}

export interface CalculatedMetrics {
  aaL10: Metric;
  cleanSheetL10: Metric;
  goalL10: Metric;
  excludedLowCoverage: number;
}

const emptyMetric = (): Metric => ({ value: null, sampleSize: 0 });

function mean(values: number[]): Metric {
  if (values.length === 0) return emptyMetric();
  return {
    value: values.reduce((sum, value) => sum + value, 0) / values.length,
    sampleSize: values.length,
  };
}

function ratio(successes: number, total: number): Metric {
  return total === 0 ? emptyMetric() : { value: successes / total, sampleSize: total };
}

export function calculatePlayerMetrics(
  appearances: readonly PlayerAppearance[],
  position: FootballPosition,
  options: CalculationOptions,
): CalculatedMetrics {
  const limit = options.limit ?? 10;
  const forPosition = appearances.filter((appearance) => appearance.position === position);
  const excludedLowCoverage = options.excludeLowCoverage
    ? forPosition.filter((appearance) => appearance.lowCoverage).length
    : 0;

  const validAppearances = forPosition
    .filter((appearance) => !options.excludeLowCoverage || !appearance.lowCoverage)
    .filter((appearance) => (appearance.minsPlayed ?? 0) > 0)
    .sort((left, right) => Date.parse(right.date) - Date.parse(left.date))
    .slice(0, limit);

  const allAroundScores = validAppearances.flatMap((appearance) =>
    appearance.allAroundScore === null ? [] : [appearance.allAroundScore],
  );
  const cleanSheetEligible = validAppearances.filter(
    (appearance) => (appearance.minsPlayed ?? 0) >= 60,
  );
  const goalEligible = validAppearances.filter((appearance) => (appearance.minsPlayed ?? 0) >= 1);

  return {
    aaL10: mean(allAroundScores),
    cleanSheetL10: ratio(
      cleanSheetEligible.filter((appearance) => (appearance.cleanSheet60 ?? 0) >= 1).length,
      cleanSheetEligible.length,
    ),
    goalL10: ratio(
      goalEligible.filter((appearance) => (appearance.goals ?? 0) >= 1).length,
      goalEligible.length,
    ),
    excludedLowCoverage,
  };
}

export function hasAnyDisplayData(stats: PlayerStats): boolean {
  const roleMetric =
    stats.position === 'Goalkeeper' || stats.position === 'Defender'
      ? stats.cleanSheetL10
      : stats.goalL10;
  return stats.aaL10.value !== null || roleMetric.value !== null;
}
