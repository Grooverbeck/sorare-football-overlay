import type { MlsAaPercentileBand } from './mls-aa-benchmarks.js';

/**
 * Versioned snapshot of Sorare win probabilities for both team sides in
 * completed MLS matches during the current season.
 *
 * Population: home and away team sides with complete win/draw/loss basis
 * points. This matches the player-team probability displayed by the overlay.
 */
export const MLS_WIN_PROBABILITY_BENCHMARKS = {
  competition: 'Major League Soccer',
  competitionSlug: 'mlspa',
  seasonStart: '2026-01-01',
  asOf: '2026-07-23',
  matches: 238,
  sampleSize: 470,
  oddsCoverage: 0.9874,
  meanPredicted: 0.3791,
  actualWinRate: 0.3894,
  thresholds: {
    p20: 0.24,
    p40: 0.32,
    p60: 0.414,
    p80: 0.51,
    p90: 0.5699,
  },
  calibration: [
    { label: 'P0–20', sampleSize: 86, meanPredicted: 0.181, actualRate: 0.2209 },
    { label: 'P20–40', sampleSize: 93, meanPredicted: 0.2771, actualRate: 0.2903 },
    { label: 'P40–60', sampleSize: 103, meanPredicted: 0.3657, actualRate: 0.3398 },
    { label: 'P60–80', sampleSize: 88, meanPredicted: 0.4559, actualRate: 0.5 },
    { label: 'P80–90', sampleSize: 45, meanPredicted: 0.5333, actualRate: 0.5111 },
    { label: 'P90–100', sampleSize: 55, meanPredicted: 0.6376, actualRate: 0.6364 },
  ],
} as const;

export function getMlsWinProbabilityPercentileBand(
  value: number | null | undefined,
): MlsAaPercentileBand | null {
  if (value === null || value === undefined) return null;
  const bounded = Math.max(0, Math.min(1, value));
  const { thresholds } = MLS_WIN_PROBABILITY_BENCHMARKS;
  if (bounded < thresholds.p20) return { tone: 'very-low', label: 'P0–20' };
  if (bounded < thresholds.p40) return { tone: 'low', label: 'P20–40' };
  if (bounded < thresholds.p60) return { tone: 'balanced', label: 'P40–60' };
  if (bounded < thresholds.p80) return { tone: 'good', label: 'P60–80' };
  if (bounded < thresholds.p90) return { tone: 'strong', label: 'P80–90' };
  return { tone: 'elite', label: 'P90–100' };
}
