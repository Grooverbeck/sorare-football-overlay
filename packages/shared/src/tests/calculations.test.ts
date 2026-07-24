import { describe, expect, it } from 'vitest';
import { calculatePlayerMetrics, type PlayerAppearance } from '../index.js';

const appearances: PlayerAppearance[] = [
  {
    date: '2026-07-20T18:00:00.000Z',
    allAroundScore: 12,
    goals: 1,
    minsPlayed: 90,
    cleanSheet60: 1,
    lowCoverage: false,
    position: 'Defender',
  },
  {
    date: '2026-07-13T18:00:00.000Z',
    allAroundScore: 8,
    goals: 0,
    minsPlayed: 59,
    cleanSheet60: 0,
    lowCoverage: false,
    position: 'Defender',
  },
  {
    date: '2026-07-06T18:00:00.000Z',
    allAroundScore: 99,
    goals: 1,
    minsPlayed: 90,
    cleanSheet60: 1,
    lowCoverage: true,
    position: 'Defender',
  },
  {
    date: '2026-06-29T18:00:00.000Z',
    allAroundScore: 50,
    goals: 1,
    minsPlayed: 0,
    cleanSheet60: 0,
    lowCoverage: false,
    position: 'Defender',
  },
];

describe('calculatePlayerMetrics', () => {
  it('excludes DNP and configured low-coverage appearances', () => {
    const result = calculatePlayerMetrics(appearances, 'Defender', {
      excludeLowCoverage: true,
    });

    expect(result.aaL10).toEqual({ value: 10, sampleSize: 2 });
    expect(result.cleanSheetL10).toEqual({ value: 1, sampleSize: 1 });
    expect(result.goalL10).toEqual({ value: 0.5, sampleSize: 2 });
    expect(result.excludedLowCoverage).toBe(1);
  });

  it('includes low-coverage appearances when configured', () => {
    const result = calculatePlayerMetrics(appearances, 'Defender', {
      excludeLowCoverage: false,
    });

    expect(result.aaL10.value).toBeCloseTo(39.666_666);
    expect(result.aaL10.sampleSize).toBe(3);
    expect(result.cleanSheetL10).toEqual({ value: 1, sampleSize: 2 });
  });

  it('uses the concrete card position', () => {
    const result = calculatePlayerMetrics(appearances, 'Forward', {
      excludeLowCoverage: false,
    });

    expect(result.aaL10).toEqual({ value: null, sampleSize: 0 });
    expect(result.goalL10).toEqual({ value: null, sampleSize: 0 });
  });
});
