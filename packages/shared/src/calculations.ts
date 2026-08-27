import type {
  FootballPosition,
  HistoricalAssistMetrics,
  Metric,
  PlayerStats,
} from './contracts.js';

export interface PlayerAppearance {
  date: string;
  allAroundScore: number | null;
  goals: number | null;
  assists?: number | null;
  minsPlayed: number | null;
  cleanSheet60: number | null;
  lowCoverage: boolean;
  position: FootballPosition;
  /**
   * Result of this appearance from the player's team perspective. Missing
   * keeps legacy form snapshots and providers without match results usable.
   */
  teamResult?: 'win' | 'draw' | 'loss';
  /**
   * Whether the appearance was for the player's current active club.
   * Undefined keeps mock and legacy data backwards compatible.
   */
  currentClubGame?: boolean;
}

export interface CalculationOptions {
  excludeLowCoverage: boolean;
  limit?: number;
}

export interface CalculatedMetrics {
  aaL10: Metric;
  aaL10TeamWinRate: Metric;
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

function validAppearancesForPosition(
  appearances: readonly PlayerAppearance[],
  position: FootballPosition,
  excludeLowCoverage: boolean,
): PlayerAppearance[] {
  return appearances
    .filter((appearance) => appearance.position === position)
    .filter((appearance) => !excludeLowCoverage || !appearance.lowCoverage)
    .filter((appearance) => (appearance.minsPlayed ?? 0) > 0)
    .sort((left, right) => Date.parse(right.date) - Date.parse(left.date));
}

export const AA_MINIMUM_MINUTES = 60;

/**
 * Selects the exact appearances that contribute values to the AA average.
 * Keep this selector shared by every AA-derived metric so position, club,
 * coverage, minutes and window semantics cannot drift apart.
 */
export function selectAaAppearances(
  appearances: readonly PlayerAppearance[],
  position: FootballPosition,
  options: CalculationOptions,
): PlayerAppearance[] {
  const limit = options.limit ?? 10;
  const allValidAppearances = validAppearancesForPosition(
    appearances,
    position,
    options.excludeLowCoverage,
  );
  const hasCurrentClubMarkers = allValidAppearances.some(
    (appearance) => appearance.currentClubGame !== undefined,
  );

  return (
    hasCurrentClubMarkers
      ? allValidAppearances.filter(
          (appearance) => appearance.currentClubGame === true,
        )
      : allValidAppearances
  )
    .filter(
      (appearance) =>
        (appearance.minsPlayed ?? 0) >= AA_MINIMUM_MINUTES &&
        appearance.allAroundScore !== null,
    )
    .slice(0, limit);
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

  const allValidAppearances = validAppearancesForPosition(
    appearances,
    position,
    options.excludeLowCoverage,
  );
  const validAppearances = allValidAppearances.slice(0, limit);
  const aaEligibleAppearances = selectAaAppearances(
    appearances,
    position,
    options,
  );
  const allAroundScores = aaEligibleAppearances.map(
    (appearance) => appearance.allAroundScore!,
  );
  const aaAppearancesWithTeamResult = aaEligibleAppearances.filter(
    (appearance) => appearance.teamResult !== undefined,
  );
  const cleanSheetEligible = validAppearances.filter(
    (appearance) => (appearance.minsPlayed ?? 0) >= 60,
  );
  const goalEligible = validAppearances.filter((appearance) => (appearance.minsPlayed ?? 0) >= 1);

  return {
    aaL10: mean(allAroundScores),
    aaL10TeamWinRate: ratio(
      aaAppearancesWithTeamResult.filter(
        (appearance) => appearance.teamResult === 'win',
      ).length,
      aaAppearancesWithTeamResult.length,
    ),
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

function calculateHistoricalPlayerEventMetrics(
  appearances: readonly PlayerAppearance[],
  position: FootballPosition,
  excludeLowCoverage: boolean,
  eventOccurred: (appearance: PlayerAppearance) => boolean,
): HistoricalAssistMetrics {
  // Goals and assists describe the player, so transfers must not reset these
  // rates. Position, coverage and minutes eligibility still apply unchanged.
  const validAppearances = validAppearancesForPosition(
    appearances,
    position,
    excludeLowCoverage,
  );
  const forWindow = (limit: number): Metric => {
    const selected = validAppearances.slice(0, limit);
    return ratio(
      selected.filter(eventOccurred).length,
      selected.length,
    );
  };
  return {
    l10: forWindow(10),
    l15: forWindow(15),
    l40: forWindow(40),
  };
}

export function calculateHistoricalAssistMetrics(
  appearances: readonly PlayerAppearance[],
  position: FootballPosition,
  excludeLowCoverage: boolean,
): HistoricalAssistMetrics {
  return calculateHistoricalPlayerEventMetrics(
    appearances,
    position,
    excludeLowCoverage,
    (appearance) => (appearance.assists ?? 0) >= 1,
  );
}

export function calculateHistoricalGoalMetrics(
  appearances: readonly PlayerAppearance[],
  position: FootballPosition,
  excludeLowCoverage: boolean,
): HistoricalAssistMetrics {
  return calculateHistoricalPlayerEventMetrics(
    appearances,
    position,
    excludeLowCoverage,
    (appearance) => (appearance.goals ?? 0) >= 1,
  );
}

export function calculateHistoricalDecisiveMetrics(
  appearances: readonly PlayerAppearance[],
  position: FootballPosition,
  excludeLowCoverage: boolean,
): HistoricalAssistMetrics {
  return calculateHistoricalPlayerEventMetrics(
    appearances,
    position,
    excludeLowCoverage,
    (appearance) =>
      (appearance.goals ?? 0) >= 1 ||
      (appearance.assists ?? 0) >= 1,
  );
}

export function hasAnyDisplayData(stats: PlayerStats): boolean {
  const roleMetric =
    stats.position === 'Goalkeeper' || stats.position === 'Defender'
      ? stats.cleanSheetL10
      : stats.goalL10;
  const nextGame = stats.nextGame;
  const matchProbabilities = nextGame?.matchProbabilities;
  const hasCompleteMatchProbabilities = Boolean(
    matchProbabilities &&
      matchProbabilities.win !== null &&
      matchProbabilities.draw !== null &&
      matchProbabilities.loss !== null,
  );
  const hasRelevantCleanSheetProbability =
    (stats.position === 'Goalkeeper' || stats.position === 'Defender') &&
    nextGame?.cleanSheetProbability !== null &&
    nextGame?.cleanSheetProbability !== undefined;
  const hasRelevantPlayerMarket =
    stats.position !== 'Goalkeeper' &&
    Boolean(nextGame?.marketOdds?.goal || nextGame?.marketOdds?.assist);

  return (
    stats.aaL10.value !== null ||
    roleMetric.value !== null ||
    hasCompleteMatchProbabilities ||
    hasRelevantCleanSheetProbability ||
    hasRelevantPlayerMarket
  );
}
