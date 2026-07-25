import type { FootballPosition } from './contracts.js';
import type { MarketProbabilityBand } from './market-probability-benchmarks.js';

export type HistoricalPlayerMarketKind = 'goal' | 'assist';

/**
 * Historical appearance rates are deliberately calibrated below the direct
 * next-match market bands. A bookmaker probability can move sharply with the
 * opponent, expected lineup and minutes, while an L10/L15/L40 rate is a
 * smoothed record of actual outcomes.
 *
 * The cut points are position- and market-specific product thresholds. They
 * are versioned independently from the empirical bookmaker-odds snapshot and
 * can later be replaced with full-season MLS percentiles without changing the
 * UI contract.
 */
export const MLS_HISTORICAL_MARKET_BENCHMARKS = {
  version: 1,
  asOf: '2026-07-25',
  methodology:
    'position-aware historical appearance-rate bands, calibrated separately from next-match odds',
  goal: {
    Defender: {
      veryLowMax: 0.01,
      lowMax: 0.04,
      balancedMax: 0.075,
      goodMax: 0.1,
      strongMax: 0.15,
    },
    Midfielder: {
      veryLowMax: 0.03,
      lowMax: 0.075,
      balancedMax: 0.12,
      goodMax: 0.18,
      strongMax: 0.25,
    },
    Forward: {
      veryLowMax: 0.05,
      lowMax: 0.1,
      balancedMax: 0.18,
      goodMax: 0.25,
      strongMax: 0.35,
    },
  },
  assist: {
    Defender: {
      veryLowMax: 0.01,
      lowMax: 0.04,
      balancedMax: 0.075,
      goodMax: 0.12,
      strongMax: 0.18,
    },
    Midfielder: {
      veryLowMax: 0.03,
      lowMax: 0.08,
      balancedMax: 0.13,
      goodMax: 0.2,
      strongMax: 0.27,
    },
    Forward: {
      veryLowMax: 0.03,
      lowMax: 0.075,
      balancedMax: 0.12,
      goodMax: 0.18,
      strongMax: 0.25,
    },
  },
} as const;

export function getMlsHistoricalMarketProbabilityBand(
  market: HistoricalPlayerMarketKind,
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
  const thresholds = MLS_HISTORICAL_MARKET_BENCHMARKS[market][position];
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
