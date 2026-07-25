import type { FootballPosition } from './contracts.js';
import type { PerformanceTone } from './mls-aa-benchmarks.js';

export type PlayerMarketKind = 'goal' | 'assist' | 'decisive';

export interface MarketProbabilityBand {
  tone: PerformanceTone;
  label: 'sehr niedrig' | 'niedrig' | 'mittel' | 'gut' | 'sehr gut' | 'Spitze';
}

/**
 * Versioned quality bands derived from the frozen, no-vig MLS player-prop
 * snapshots for the 25/26 July 2026 match weekend.
 *
 * The rounded cut points follow P20/P40/P60/P80/P90 within each card position,
 * matching the established P90–100 top band used by the other overlay metrics.
 * Goal and assist bands use their direct markets. The initial decisive bands
 * are retained as provisional display thresholds from the first weekend
 * snapshot until enough direct goals+assists markets exist to recalibrate them.
 * They color a direct bookmaker probability and never generate one.
 */
export const MLS_MARKET_PROBABILITY_BENCHMARKS = {
  asOf: '2026-07-25',
  methodology:
    'rounded empirical P20/P40/P60/P80/P90 weekend bands by card position',
  sample: {
    fixtures: 15,
    goal: {
      fixtures: 15,
      matchedPlayers: 475,
      byPosition: { Defender: 192, Midfielder: 157, Forward: 126 },
    },
    assist: {
      fixtures: 2,
      matchedPlayers: 49,
      byPosition: { Defender: 18, Midfielder: 17, Forward: 14 },
    },
    decisive: {
      fixtures: 2,
      matchedPlayers: 49,
      byPosition: { Defender: 18, Midfielder: 17, Forward: 14 },
    },
  },
  goal: {
    Defender: {
      veryLowMax: 0.055,
      lowMax: 0.066,
      balancedMax: 0.076,
      goodMax: 0.093,
      strongMax: 0.114,
    },
    Midfielder: {
      veryLowMax: 0.095,
      lowMax: 0.122,
      balancedMax: 0.167,
      goodMax: 0.227,
      strongMax: 0.264,
    },
    Forward: {
      veryLowMax: 0.217,
      lowMax: 0.253,
      balancedMax: 0.294,
      goodMax: 0.364,
      strongMax: 0.41,
    },
  },
  assist: {
    Defender: {
      veryLowMax: 0.058,
      lowMax: 0.077,
      balancedMax: 0.103,
      goodMax: 0.167,
      strongMax: 0.177,
    },
    Midfielder: {
      veryLowMax: 0.14,
      lowMax: 0.188,
      balancedMax: 0.213,
      goodMax: 0.303,
      strongMax: 0.311,
    },
    Forward: {
      veryLowMax: 0.146,
      lowMax: 0.171,
      balancedMax: 0.203,
      goodMax: 0.296,
      strongMax: 0.313,
    },
  },
  decisive: {
    Defender: {
      veryLowMax: 0.125,
      lowMax: 0.13,
      balancedMax: 0.179,
      goodMax: 0.225,
      strongMax: 0.247,
    },
    Midfielder: {
      veryLowMax: 0.216,
      lowMax: 0.281,
      balancedMax: 0.369,
      goodMax: 0.454,
      strongMax: 0.556,
    },
    Forward: {
      veryLowMax: 0.358,
      lowMax: 0.428,
      balancedMax: 0.477,
      goodMax: 0.499,
      strongMax: 0.511,
    },
  },
} as const;

export function getMlsMarketProbabilityBand(
  market: PlayerMarketKind,
  position: FootballPosition,
  value: number | null | undefined,
): MarketProbabilityBand | null {
  if (
    position === 'Goalkeeper' ||
    value === null ||
    value === undefined ||
    !Number.isFinite(value)
  ) {
    return null;
  }
  const bounded = Math.max(0, Math.min(1, value));
  const thresholds = MLS_MARKET_PROBABILITY_BENCHMARKS[market][position];
  if (bounded < thresholds.veryLowMax) {
    return { tone: 'very-low', label: 'sehr niedrig' };
  }
  if (bounded < thresholds.lowMax) {
    return { tone: 'low', label: 'niedrig' };
  }
  if (bounded < thresholds.balancedMax) {
    return { tone: 'balanced', label: 'mittel' };
  }
  if (bounded < thresholds.goodMax) {
    return { tone: 'good', label: 'gut' };
  }
  if (bounded < thresholds.strongMax) {
    return { tone: 'strong', label: 'sehr gut' };
  }
  return { tone: 'elite', label: 'Spitze' };
}
