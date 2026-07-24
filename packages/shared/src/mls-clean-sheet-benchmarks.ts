import type { MlsAaPercentileBand } from './mls-aa-benchmarks.js';

/**
 * Versioned snapshot of historical Sorare clean-sheet odds for completed MLS
 * matches in the current season.
 *
 * Population: home and away team sides with a historical cleanSheetOdds value.
 * The displayed probability is calculated in the same way as the backend:
 * `1 / cleanSheetOdds`.
 */
export const MLS_CLEAN_SHEET_BENCHMARKS = {
  competition: 'Major League Soccer',
  competitionSlug: 'mlspa',
  seasonStart: '2026-01-01',
  asOf: '2026-07-23',
  matches: 238,
  sampleSize: 470,
  oddsCoverage: 0.9874,
  meanPredicted: 0.2623,
  actualCleanSheetRate: 0.2149,
  thresholds: {
    p20: 0.1905,
    p40: 0.2381,
    p60: 0.2817,
    p80: 0.3333,
    p90: 0.3774,
  },
  calibration: [
    { label: 'P0–20', sampleSize: 91, meanPredicted: 0.1469, actualRate: 0.0879 },
    { label: 'P20–40', sampleSize: 94, meanPredicted: 0.2121, actualRate: 0.1383 },
    { label: 'P40–60', sampleSize: 91, meanPredicted: 0.2582, actualRate: 0.1978 },
    { label: 'P60–80', sampleSize: 80, meanPredicted: 0.2981, actualRate: 0.2625 },
    { label: 'P80–90', sampleSize: 62, meanPredicted: 0.3462, actualRate: 0.3065 },
    { label: 'P90–100', sampleSize: 52, meanPredicted: 0.407, actualRate: 0.4231 },
  ],
} as const;

export function getMlsCleanSheetPercentileBand(
  value: number | null | undefined,
): MlsAaPercentileBand | null {
  if (value === null || value === undefined) return null;
  const bounded = Math.max(0, Math.min(1, value));
  const { thresholds } = MLS_CLEAN_SHEET_BENCHMARKS;
  if (bounded < thresholds.p20) return { tone: 'very-low', label: 'P0–20' };
  if (bounded < thresholds.p40) return { tone: 'low', label: 'P20–40' };
  if (bounded < thresholds.p60) return { tone: 'balanced', label: 'P40–60' };
  if (bounded < thresholds.p80) return { tone: 'good', label: 'P60–80' };
  if (bounded < thresholds.p90) return { tone: 'strong', label: 'P80–90' };
  return { tone: 'elite', label: 'P90–100' };
}
