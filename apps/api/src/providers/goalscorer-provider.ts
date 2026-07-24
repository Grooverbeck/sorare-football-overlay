import {
  calculatePlayerMetrics,
  type CalculationOptions,
  type FootballPosition,
  type Metric,
  type PlayerAppearance,
} from '@sorare-overlay/shared';

export interface GoalscorerProbability {
  metric: Metric;
  label: 'Goal L10';
  methodology: 'historical';
  isNextGamePrediction: false;
}

export interface GoalscorerProbabilityProvider {
  calculate(
    appearances: readonly PlayerAppearance[],
    position: FootballPosition,
    options: CalculationOptions,
  ): GoalscorerProbability;
}

/** Historical hit rate only. This is deliberately not a next-game forecast. */
export class HistoricalGoalscorerProvider implements GoalscorerProbabilityProvider {
  calculate(
    appearances: readonly PlayerAppearance[],
    position: FootballPosition,
    options: CalculationOptions,
  ): GoalscorerProbability {
    return {
      metric: calculatePlayerMetrics(appearances, position, options).goalL10,
      label: 'Goal L10',
      methodology: 'historical',
      isNextGamePrediction: false,
    };
  }
}
