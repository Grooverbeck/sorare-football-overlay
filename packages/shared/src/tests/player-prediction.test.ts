import { describe, expect, it } from 'vitest';
import {
  calculatePlayerPrediction,
  calculatePredictionHistoricalL15,
  normalizePredictionProbability,
} from '../player-prediction.js';
import type { PlayerAppearance } from '../calculations.js';

const metric = (value: number | null, sampleSize: number) => ({
  value,
  sampleSize,
});

describe('calculatePlayerPrediction', () => {
  it('uses market goal probability and historical L15 assist probability independently for a forward', () => {
    const result = calculatePlayerPrediction({
      position: 'Forward',
      aa: metric(14, 10),
      goalMarket: { probability: 0.25, bookmakerCount: 3 },
      assistMarket: null,
      historicalGoalL15: metric(0.1, 15),
      historicalAssistL15: metric(0.2, 15),
      cleanSheetProbability: null,
    });

    expect(result.modelVersion).toBe('player-prediction-v1');
    expect(result.goal).toMatchObject({
      probability: 0.25,
      contribution: 2.5,
      source: 'market',
      sampleSize: 3,
    });
    expect(result.assist).toMatchObject({
      probability: 0.2,
      contribution: 2,
      source: 'historical_l15',
      sampleSize: 15,
    });
    expect(result.aa.contribution).toBe(14);
    expect(result.total).toBeCloseTo(18.5);
    expect(result.comparableAcrossPositions).toBe(false);
  });

  it('applies the same transparent field-player formula to a midfielder', () => {
    const result = calculatePlayerPrediction({
      position: 'Midfielder',
      aa: metric(10, 9),
      goalMarket: { probability: 0.12, bookmakerCount: 2 },
      assistMarket: { probability: 0.3, bookmakerCount: 2 },
      historicalGoalL15: metric(0, 15),
      historicalAssistL15: metric(0, 15),
      cleanSheetProbability: null,
    });

    expect(result.goal.source).toBe('market');
    expect(result.assist.source).toBe('market');
    expect(result.total).toBeCloseTo(14.2);
    expect(result.formula).toContain('10');
  });

  it('uses AA plus the explicitly requested clean-sheet multiplier for a defender', () => {
    const result = calculatePlayerPrediction({
      position: 'Defender',
      aa: metric(12, 10),
      goalMarket: null,
      assistMarket: null,
      historicalGoalL15: metric(0.4, 15),
      historicalAssistL15: metric(0.2, 15),
      cleanSheetProbability: 0.3,
    });

    expect(result.cleanSheet).toMatchObject({
      probability: 0.3,
      contribution: 6,
      source: 'sorare_fixture',
      sampleSize: 1,
    });
    expect(result.goal.source).toBe('not_applicable');
    expect(result.total).toBeCloseTo(18);
  });

  it('uses only clean-sheet probability as the goalkeeper basis', () => {
    const result = calculatePlayerPrediction({
      position: 'Goalkeeper',
      aa: metric(20, 10),
      goalMarket: { probability: 0.9, bookmakerCount: 4 },
      assistMarket: { probability: 0.9, bookmakerCount: 4 },
      historicalGoalL15: metric(0.5, 15),
      historicalAssistL15: metric(0.5, 15),
      cleanSheetProbability: 0.55,
    });

    expect(result.aa.source).toBe('not_applicable');
    expect(result.goal.source).toBe('not_applicable');
    expect(result.assist.source).toBe('not_applicable');
    expect(result.cleanSheet.contribution).toBe(0.55);
    expect(result.total).toBe(0.55);
    expect(result.unit).toBe('normalized_probability');
  });

  it('keeps zero distinct from null and does not invent a zero-percent fallback', () => {
    const zero = calculatePlayerPrediction({
      position: 'Forward',
      aa: metric(0, 10),
      goalMarket: { probability: 0, bookmakerCount: 1 },
      assistMarket: null,
      historicalGoalL15: metric(0, 15),
      historicalAssistL15: metric(0, 0),
      cleanSheetProbability: null,
    });
    expect(zero.goal.source).toBe('market');
    expect(zero.goal.probability).toBe(0);
    expect(zero.assist.source).toBe('unavailable');
    expect(zero.assist.probability).toBeNull();
    expect(zero.total).toBe(0);
    expect(zero.complete).toBe(false);
    expect(zero.missingComponents).toEqual(['assist']);
  });

  it('returns an unavailable total when every applicable input is unavailable', () => {
    const result = calculatePlayerPrediction({
      position: 'Forward',
      aa: metric(null, 0),
      goalMarket: null,
      assistMarket: null,
      historicalGoalL15: metric(null, 0),
      historicalAssistL15: metric(null, 0),
      cleanSheetProbability: null,
    });

    expect(result.total).toBeNull();
    expect(result.goal).toMatchObject({ source: 'unavailable', sampleSize: 0 });
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'aa_l10_no_valid_appearances',
        'goal_market_missing',
        'assist_market_missing',
      ]),
    );
  });

  it('does not present a field-player index without its AA base', () => {
    const result = calculatePlayerPrediction({
      position: 'Forward',
      aa: metric(null, 0),
      goalMarket: { probability: 0.4, bookmakerCount: 2 },
      assistMarket: { probability: 0.2, bookmakerCount: 2 },
      historicalGoalL15: null,
      historicalAssistL15: null,
      cleanSheetProbability: null,
    });

    expect(result.total).toBeNull();
    expect(result.complete).toBe(false);
    expect(result.missingComponents).toEqual(['aa']);
  });

  it('shows every configured weight in the diagnostic formula', () => {
    const result = calculatePlayerPrediction(
      {
        position: 'Forward',
        aa: metric(5, 10),
        goalMarket: { probability: 0.2, bookmakerCount: 1 },
        assistMarket: { probability: 0.1, bookmakerCount: 1 },
        historicalGoalL15: null,
        historicalAssistL15: null,
        cleanSheetProbability: null,
      },
      { aaWeight: 2 },
    );

    expect(result.total).toBe(13);
    expect(result.formula).toContain('2×AA');
  });
});

describe('prediction input normalization and historical L15 selection', () => {
  it('normalizes external percentage notation without changing repository 0..1 values', () => {
    expect(normalizePredictionProbability(0)).toBe(0);
    expect(normalizePredictionProbability(0.3)).toBe(0.3);
    expect(normalizePredictionProbability(30)).toBe(0.3);
    expect(normalizePredictionProbability(null)).toBeNull();
    expect(normalizePredictionProbability(101)).toBeNull();
  });

  it('uses 15 valid current-club appearances and excludes DNPs and low coverage', () => {
    const appearances: PlayerAppearance[] = [
      {
        date: '2026-08-15T18:00:00.000Z',
        position: 'Forward',
        allAroundScore: 99,
        goals: 1,
        assists: 1,
        minsPlayed: 0,
        cleanSheet60: null,
        lowCoverage: false,
        currentClubGame: true,
      },
      {
        date: '2026-08-14T18:00:00.000Z',
        position: 'Forward',
        allAroundScore: 99,
        goals: 1,
        assists: 1,
        minsPlayed: 90,
        cleanSheet60: null,
        lowCoverage: true,
        currentClubGame: true,
      },
      {
        date: '2026-08-13T18:00:00.000Z',
        position: 'Forward',
        allAroundScore: 99,
        goals: 1,
        assists: 1,
        minsPlayed: 90,
        cleanSheet60: null,
        lowCoverage: false,
        currentClubGame: false,
      },
      ...Array.from({ length: 15 }, (_, index) => ({
        date: new Date(Date.UTC(2026, 7, 12 - index, 18)).toISOString(),
        position: 'Forward' as const,
        allAroundScore: 10,
        goals: index === 0 ? 1 : 0,
        assists: index < 2 ? 1 : 0,
        minsPlayed: 90,
        cleanSheet60: null,
        lowCoverage: false,
        currentClubGame: true,
      })),
    ];

    expect(
      calculatePredictionHistoricalL15(
        appearances,
        'Forward',
        true,
        'goal',
      ),
    ).toEqual({ value: 1 / 15, sampleSize: 15 });
    expect(
      calculatePredictionHistoricalL15(
        appearances,
        'Forward',
        true,
        'assist',
      ),
    ).toEqual({ value: 2 / 15, sampleSize: 15 });
  });

  it('returns unavailable for zero valid L15 appearances', () => {
    expect(
      calculatePredictionHistoricalL15(
        [
          {
            date: '2026-08-01T18:00:00.000Z',
            position: 'Midfielder',
            allAroundScore: 10,
            goals: 0,
            assists: 0,
            minsPlayed: 0,
            cleanSheet60: null,
            lowCoverage: false,
            currentClubGame: true,
          },
        ],
        'Midfielder',
        true,
        'goal',
      ),
    ).toEqual({ value: null, sampleSize: 0 });
  });

  it('sorts by date and limits the fallback to the newest 15 valid games', () => {
    const appearances: PlayerAppearance[] = Array.from(
      { length: 17 },
      (_, index) => ({
        date: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
        position: 'Forward',
        allAroundScore: 10,
        goals: index >= 15 ? 1 : 0,
        assists: 0,
        minsPlayed: 90,
        cleanSheet60: null,
        lowCoverage: false,
        currentClubGame: true,
      }),
    ).reverse();

    expect(
      calculatePredictionHistoricalL15(
        appearances,
        'Forward',
        true,
        'goal',
      ),
    ).toEqual({ value: 2 / 15, sampleSize: 15 });
  });
});
