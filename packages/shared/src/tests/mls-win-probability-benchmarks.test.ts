import { describe, expect, it } from 'vitest';
import {
  getMlsWinProbabilityPercentileBand,
  MLS_WIN_PROBABILITY_BENCHMARKS,
} from '../index.js';

describe('MLS win-probability benchmarks', () => {
  it('maps historical Sorare win probabilities to the shared six-color scale', () => {
    expect(getMlsWinProbabilityPercentileBand(0.2)?.tone).toBe('very-low');
    expect(getMlsWinProbabilityPercentileBand(0.28)?.tone).toBe('low');
    expect(getMlsWinProbabilityPercentileBand(0.37)?.tone).toBe('balanced');
    expect(getMlsWinProbabilityPercentileBand(0.46)).toEqual({
      tone: 'good',
      label: 'P60–80',
    });
    expect(getMlsWinProbabilityPercentileBand(0.53)?.tone).toBe('strong');
    expect(getMlsWinProbabilityPercentileBand(0.57)?.tone).toBe('elite');
  });

  it('keeps unavailable values neutral and records the analysis population', () => {
    expect(getMlsWinProbabilityPercentileBand(null)).toBeNull();
    expect(MLS_WIN_PROBABILITY_BENCHMARKS.matches).toBe(238);
    expect(MLS_WIN_PROBABILITY_BENCHMARKS.sampleSize).toBe(470);
  });
});
