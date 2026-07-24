import { describe, expect, it } from 'vitest';
import {
  getMlsCleanSheetPercentileBand,
  MLS_CLEAN_SHEET_BENCHMARKS,
} from '../index.js';

describe('MLS clean-sheet benchmarks', () => {
  it('maps historical Sorare CS probabilities to the shared six-color scale', () => {
    expect(getMlsCleanSheetPercentileBand(0.15)?.tone).toBe('very-low');
    expect(getMlsCleanSheetPercentileBand(0.2)?.tone).toBe('low');
    expect(getMlsCleanSheetPercentileBand(0.25)?.tone).toBe('balanced');
    expect(getMlsCleanSheetPercentileBand(0.3)?.tone).toBe('good');
    expect(getMlsCleanSheetPercentileBand(0.35)?.tone).toBe('strong');
    expect(getMlsCleanSheetPercentileBand(0.4)).toEqual({
      tone: 'elite',
      label: 'P90–100',
    });
  });

  it('keeps unavailable values neutral and records the analysis population', () => {
    expect(getMlsCleanSheetPercentileBand(null)).toBeNull();
    expect(MLS_CLEAN_SHEET_BENCHMARKS.matches).toBe(238);
    expect(MLS_CLEAN_SHEET_BENCHMARKS.sampleSize).toBe(470);
  });
});
