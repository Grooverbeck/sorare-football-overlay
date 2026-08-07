import { z } from 'zod';
import {
  FootballPositionSchema,
  MarketProbabilitySchema,
  MetricSchema,
  type FootballPosition,
  type MarketProbability,
  type Metric,
} from './contracts.js';
import type { PlayerAppearance } from './calculations.js';

export const PLAYER_PREDICTION_MODEL_VERSION = 'player-prediction-v1' as const;

export const PlayerPredictionSourceSchema = z.enum([
  'market',
  'historical_l10',
  'historical_l15',
  'sorare_fixture',
  'unavailable',
  'not_applicable',
]);

export const PlayerPredictionComponentKeySchema = z.enum([
  'aa',
  'goal',
  'assist',
  'cleanSheet',
]);

export const PlayerPredictionComponentSchema = z.object({
  value: z.number().finite().nullable(),
  probability: z.number().min(0).max(1).nullable(),
  contribution: z.number().finite(),
  source: PlayerPredictionSourceSchema,
  sampleSize: z.number().int().nonnegative(),
  reasons: z.array(z.string().min(1)),
});

export const PlayerPredictionConfigSchema = z.object({
  aaWeight: z.number().finite().nonnegative(),
  fieldProbabilityScale: z.number().finite().nonnegative(),
  goalWeight: z.number().finite().nonnegative(),
  assistWeight: z.number().finite().nonnegative(),
  defenderCleanSheetScale: z.number().finite().nonnegative(),
  defenderCleanSheetWeight: z.number().finite().nonnegative(),
  goalkeeperProbabilityScale: z.number().finite().nonnegative(),
});

export const PlayerPredictionInputSchema = z.object({
  position: FootballPositionSchema,
  aa: MetricSchema,
  goalMarket: MarketProbabilitySchema.nullable().optional(),
  assistMarket: MarketProbabilitySchema.nullable().optional(),
  historicalGoalL15: MetricSchema.nullable().optional(),
  historicalAssistL15: MetricSchema.nullable().optional(),
  cleanSheetProbability: z.number().finite().nullable().optional(),
});

export const PlayerPredictionSchema = z.object({
  modelVersion: z.literal(PLAYER_PREDICTION_MODEL_VERSION),
  position: FootballPositionSchema,
  total: z.number().finite().nullable(),
  index: z.number().finite().nullable(),
  complete: z.boolean(),
  missingComponents: z.array(PlayerPredictionComponentKeySchema),
  aa: PlayerPredictionComponentSchema,
  goal: PlayerPredictionComponentSchema,
  assist: PlayerPredictionComponentSchema,
  cleanSheet: PlayerPredictionComponentSchema,
  formula: z.string().min(1),
  unit: z.enum(['position_index', 'normalized_probability']),
  comparableAcrossPositions: z.literal(false),
  config: PlayerPredictionConfigSchema,
  reasons: z.array(z.string().min(1)),
});

export type PlayerPredictionSource = z.infer<typeof PlayerPredictionSourceSchema>;
export type PlayerPredictionComponentKey = z.infer<
  typeof PlayerPredictionComponentKeySchema
>;
export type PlayerPredictionComponent = z.infer<
  typeof PlayerPredictionComponentSchema
>;
export type PlayerPredictionConfig = z.infer<
  typeof PlayerPredictionConfigSchema
>;
export type PlayerPredictionInput = z.infer<typeof PlayerPredictionInputSchema>;
export type PlayerPrediction = z.infer<typeof PlayerPredictionSchema>;

export const DEFAULT_PLAYER_PREDICTION_CONFIG: PlayerPredictionConfig =
  PlayerPredictionConfigSchema.parse({
    aaWeight: 1,
    fieldProbabilityScale: 10,
    goalWeight: 1,
    assistWeight: 1,
    defenderCleanSheetScale: 10,
    defenderCleanSheetWeight: 2,
    goalkeeperProbabilityScale: 1,
  });

export function normalizePredictionProbability(
  value: number | null | undefined,
): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  if (value >= 0 && value <= 1) return value;
  if (value > 1 && value <= 100) return value / 100;
  return null;
}

function uniqueReasons(reasons: readonly string[]): string[] {
  return [...new Set(reasons)];
}

function unavailableComponent(
  reasons: readonly string[],
): PlayerPredictionComponent {
  return {
    value: null,
    probability: null,
    contribution: 0,
    source: 'unavailable',
    sampleSize: 0,
    reasons: uniqueReasons(reasons),
  };
}

function notApplicableComponent(): PlayerPredictionComponent {
  return {
    value: null,
    probability: null,
    contribution: 0,
    source: 'not_applicable',
    sampleSize: 0,
    reasons: ['not_used_for_position'],
  };
}

function historicalProbabilityComponent(
  metric: Metric | null | undefined,
  label: 'goal' | 'assist',
  contributionScale: number,
): PlayerPredictionComponent {
  const reasons: string[] = [];
  if (metric === null || metric === undefined) {
    reasons.push(`${label}_historical_l15_missing`);
  } else if (metric.sampleSize <= 0) {
    reasons.push(`${label}_historical_l15_no_valid_appearances`);
  } else if (metric.value === null) {
    reasons.push(`${label}_historical_l15_missing`);
  } else {
    const probability = normalizePredictionProbability(metric.value);
    if (probability !== null) {
      return {
        value: probability,
        probability,
        contribution: probability * contributionScale,
        source: 'historical_l15',
        sampleSize: metric.sampleSize,
        reasons: ['historical_l15_fallback'],
      };
    }
    reasons.push(`${label}_historical_l15_probability_invalid`);
  }
  return unavailableComponent(reasons);
}

function marketProbabilityComponent(
  market: MarketProbability | null | undefined,
  historical: Metric | null | undefined,
  label: 'goal' | 'assist',
  contributionScale: number,
): PlayerPredictionComponent {
  if (market !== null && market !== undefined) {
    const probability = normalizePredictionProbability(market.probability);
    if (probability !== null && market.bookmakerCount > 0) {
      return {
        value: probability,
        probability,
        contribution: probability * contributionScale,
        source: 'market',
        sampleSize: market.bookmakerCount,
        reasons: ['market_probability'],
      };
    }
  }

  const historicalComponent = historicalProbabilityComponent(
    historical,
    label,
    contributionScale,
  );
  if (historicalComponent.source !== 'unavailable') return historicalComponent;

  return unavailableComponent([
    market === null || market === undefined
      ? `${label}_market_missing`
      : `${label}_market_probability_invalid`,
    ...historicalComponent.reasons,
  ]);
}

function aaComponent(
  metric: Metric,
  weight: number,
): PlayerPredictionComponent {
  if (metric.sampleSize <= 0) {
    return unavailableComponent(['aa_l10_no_valid_appearances']);
  }
  if (metric.value === null || !Number.isFinite(metric.value)) {
    return unavailableComponent(['aa_l10_missing']);
  }
  return {
    value: metric.value,
    probability: null,
    contribution: metric.value * weight,
    source: 'historical_l10',
    sampleSize: metric.sampleSize,
    reasons: ['aa_l10'],
  };
}

function cleanSheetComponent(
  probabilityValue: number | null | undefined,
  scale: number,
): PlayerPredictionComponent {
  const probability = normalizePredictionProbability(probabilityValue);
  if (probability === null) {
    return unavailableComponent(['next_game_clean_sheet_probability_missing']);
  }
  return {
    value: probability,
    probability,
    contribution: probability * scale,
    source: 'sorare_fixture',
    sampleSize: 1,
    reasons: ['next_game_clean_sheet_probability'],
  };
}

function resolvedConfig(
  config: Partial<PlayerPredictionConfig> | undefined,
): PlayerPredictionConfig {
  return PlayerPredictionConfigSchema.parse({
    ...DEFAULT_PLAYER_PREDICTION_CONFIG,
    ...config,
  });
}

export function calculatePlayerPrediction(
  rawInput: PlayerPredictionInput,
  config?: Partial<PlayerPredictionConfig>,
): PlayerPrediction {
  const input = PlayerPredictionInputSchema.parse(rawInput);
  const resolved = resolvedConfig(config);
  const fieldScale = resolved.fieldProbabilityScale;
  const isFieldPlayer =
    input.position === 'Forward' || input.position === 'Midfielder';
  const isDefender = input.position === 'Defender';
  const isGoalkeeper = input.position === 'Goalkeeper';

  const aa = isFieldPlayer || isDefender
    ? aaComponent(input.aa, resolved.aaWeight)
    : notApplicableComponent();
  const goal = isFieldPlayer
    ? marketProbabilityComponent(
        input.goalMarket,
        input.historicalGoalL15,
        'goal',
        fieldScale * resolved.goalWeight,
      )
    : notApplicableComponent();
  const assist = isFieldPlayer
    ? marketProbabilityComponent(
        input.assistMarket,
        input.historicalAssistL15,
        'assist',
        fieldScale * resolved.assistWeight,
      )
    : notApplicableComponent();
  const cleanSheet = isDefender
    ? cleanSheetComponent(
        input.cleanSheetProbability,
        resolved.defenderCleanSheetScale * resolved.defenderCleanSheetWeight,
      )
    : isGoalkeeper
      ? cleanSheetComponent(
          input.cleanSheetProbability,
          resolved.goalkeeperProbabilityScale,
        )
      : notApplicableComponent();

  const components = { aa, goal, assist, cleanSheet };
  const applicableKeys: PlayerPredictionComponentKey[] = isFieldPlayer
    ? ['aa', 'goal', 'assist']
    : isDefender
      ? ['aa', 'cleanSheet']
      : ['cleanSheet'];
  const missingComponents = applicableKeys.filter(
    (key) => components[key].source === 'unavailable',
  );
  const hasRequiredBase = isGoalkeeper
    ? cleanSheet.source !== 'unavailable'
    : aa.source !== 'unavailable';
  const total = hasRequiredBase
    ? applicableKeys.reduce(
        (sum, key) => sum + components[key].contribution,
        0,
      )
    : null;
  const complete = missingComponents.length === 0;

  const formula = isFieldPlayer
    ? `${resolved.aaWeight}×AA + ${fieldScale}×P(goal)×${resolved.goalWeight} + ${fieldScale}×P(assist)×${resolved.assistWeight}`
    : isDefender
      ? `${resolved.aaWeight}×AA + (${resolved.defenderCleanSheetScale}×P(cleanSheet))×${resolved.defenderCleanSheetWeight}`
      : `${resolved.goalkeeperProbabilityScale}×P(cleanSheet)`;
  const unit = isGoalkeeper ? 'normalized_probability' : 'position_index';
  const reasons = uniqueReasons([
    'position_internal_only_not_cross_position_comparable',
    ...(complete ? [] : ['prediction_incomplete']),
    ...applicableKeys.flatMap((key) =>
      components[key].source === 'unavailable'
        ? components[key].reasons
        : [],
    ),
  ]);

  return PlayerPredictionSchema.parse({
    modelVersion: PLAYER_PREDICTION_MODEL_VERSION,
    position: input.position,
    total,
    index: total,
    complete,
    missingComponents,
    ...components,
    formula,
    unit,
    comparableAcrossPositions: false,
    config: resolved,
    reasons,
  });
}

function predictionEligibleAppearances(
  appearances: readonly PlayerAppearance[],
  position: FootballPosition,
  excludeLowCoverage: boolean,
): PlayerAppearance[] {
  const positioned = appearances
    .filter((appearance) => appearance.position === position)
    .filter((appearance) => (appearance.minsPlayed ?? 0) > 0);
  const hasCurrentClubMarkers = positioned.some(
    (appearance) => appearance.currentClubGame !== undefined,
  );
  return positioned
    .filter(
      (appearance) =>
        !hasCurrentClubMarkers || appearance.currentClubGame === true,
    )
    .filter((appearance) => !excludeLowCoverage || !appearance.lowCoverage)
    .sort((left, right) => Date.parse(right.date) - Date.parse(left.date));
}

export function calculatePredictionHistoricalL15(
  appearances: readonly PlayerAppearance[],
  position: FootballPosition,
  excludeLowCoverage: boolean,
  event: 'goal' | 'assist',
): Metric {
  const selected = predictionEligibleAppearances(
    appearances,
    position,
    excludeLowCoverage,
  ).slice(0, 15);
  if (selected.length === 0) return { value: null, sampleSize: 0 };
  const successes = selected.filter((appearance) =>
    event === 'goal'
      ? (appearance.goals ?? 0) >= 1
      : (appearance.assists ?? 0) >= 1,
  ).length;
  return { value: successes / selected.length, sampleSize: selected.length };
}
