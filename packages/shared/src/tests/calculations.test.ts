import { describe, expect, it } from 'vitest';
import {
  calculateHistoricalAssistMetrics,
  calculateHistoricalDecisiveMetrics,
  calculateHistoricalGoalMetrics,
  calculatePlayerMetrics,
  hasAnyDisplayData,
  type PlayerStats,
  type PlayerAppearance,
} from '../index.js';

const appearances: PlayerAppearance[] = [
  {
    date: '2026-07-20T18:00:00.000Z',
    allAroundScore: 12,
    goals: 1,
    assists: 1,
    minsPlayed: 90,
    cleanSheet60: 1,
    lowCoverage: false,
    position: 'Defender',
  },
  {
    date: '2026-07-13T18:00:00.000Z',
    allAroundScore: 8,
    goals: 0,
    assists: 0,
    minsPlayed: 59,
    cleanSheet60: 0,
    lowCoverage: false,
    position: 'Defender',
  },
  {
    date: '2026-07-06T18:00:00.000Z',
    allAroundScore: 99,
    goals: 1,
    assists: 1,
    minsPlayed: 90,
    cleanSheet60: 1,
    lowCoverage: true,
    position: 'Defender',
  },
  {
    date: '2026-06-29T18:00:00.000Z',
    allAroundScore: 50,
    goals: 1,
    assists: 1,
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

    expect(result.aaL10).toEqual({ value: 12, sampleSize: 1 });
    expect(result.cleanSheetL10).toEqual({ value: 1, sampleSize: 1 });
    expect(result.goalL10).toEqual({ value: 0.5, sampleSize: 2 });
    expect(result.excludedLowCoverage).toBe(1);
  });

  it('includes low-coverage appearances when configured', () => {
    const result = calculatePlayerMetrics(appearances, 'Defender', {
      excludeLowCoverage: false,
    });

    expect(result.aaL10.value).toBeCloseTo(55.5);
    expect(result.aaL10.sampleSize).toBe(2);
    expect(result.cleanSheetL10).toEqual({ value: 1, sampleSize: 2 });
  });

  it('uses the concrete card position', () => {
    const result = calculatePlayerMetrics(appearances, 'Forward', {
      excludeLowCoverage: false,
    });

    expect(result.aaL10).toEqual({ value: null, sampleSize: 0 });
    expect(result.goalL10).toEqual({ value: null, sampleSize: 0 });
  });

  it('uses only appearances for the current club for AA', () => {
    const mixedTeamAppearances: PlayerAppearance[] = Array.from(
      { length: 12 },
      (_, index) => ({
        date: new Date(Date.UTC(2026, 6, 24 - index)).toISOString(),
        allAroundScore: index < 2 ? 50 : 10,
        goals: 0,
        minsPlayed: 90,
        cleanSheet60: 0,
        lowCoverage: false,
        position: 'Midfielder',
        currentClubGame: index >= 2,
      }),
    );

    const result = calculatePlayerMetrics(
      mixedTeamAppearances,
      'Midfielder',
      { excludeLowCoverage: true },
    );

    expect(result.aaL10).toEqual({ value: 10, sampleSize: 10 });
    expect(result.goalL10).toEqual({ value: 0, sampleSize: 10 });
  });

  it('uses the newest ten appearances with at least 60 minutes for AA', () => {
    const withShortAppearances: PlayerAppearance[] = Array.from(
      { length: 12 },
      (_, index) => ({
        date: new Date(Date.UTC(2026, 6, 24 - index)).toISOString(),
        allAroundScore: index < 2 ? 50 : 10,
        goals: 0,
        minsPlayed: index < 2 ? 59 : 60,
        cleanSheet60: 0,
        lowCoverage: false,
        position: 'Midfielder',
        currentClubGame: true,
      }),
    );

    const result = calculatePlayerMetrics(
      withShortAppearances,
      'Midfielder',
      { excludeLowCoverage: true },
    );

    expect(result.aaL10).toEqual({ value: 10, sampleSize: 10 });
    expect(result.goalL10).toEqual({ value: 0, sampleSize: 10 });
  });

  it('calculates historical assist rates for selectable valid-appearance windows', () => {
    const history: PlayerAppearance[] = Array.from(
      { length: 42 },
      (_, index) => ({
        date: new Date(Date.UTC(2026, 6, 24 - index)).toISOString(),
        allAroundScore: 10,
        goals: index % 5 === 0 ? 1 : 0,
        assists: index % 4 === 0 ? 1 : 0,
        minsPlayed: index === 40 ? 0 : 90,
        cleanSheet60: 0,
        lowCoverage: index === 41,
        position: 'Forward',
      }),
    );

    const result = calculateHistoricalAssistMetrics(
      history,
      'Forward',
      true,
    );

    expect(result.l10).toEqual({ value: 0.3, sampleSize: 10 });
    expect(result.l15.value).toBeCloseTo(4 / 15);
    expect(result.l15.sampleSize).toBe(15);
    expect(result.l40).toEqual({ value: 0.25, sampleSize: 40 });

    const goals = calculateHistoricalGoalMetrics(history, 'Forward', true);
    expect(goals.l10).toEqual({ value: 0.2, sampleSize: 10 });
    expect(goals.l15).toEqual({ value: 0.2, sampleSize: 15 });
    expect(goals.l40).toEqual({ value: 0.2, sampleSize: 40 });

    const decisives = calculateHistoricalDecisiveMetrics(
      history,
      'Forward',
      true,
    );
    expect(decisives.l10).toEqual({ value: 0.4, sampleSize: 10 });
    expect(decisives.l15).toEqual({ value: 0.4, sampleSize: 15 });
    expect(decisives.l40).toEqual({ value: 0.4, sampleSize: 40 });
  });

  it('uses only current-club appearances for historical event rates', () => {
    const mixedClubHistory: PlayerAppearance[] = [
      {
        date: '2026-07-20T18:00:00.000Z',
        allAroundScore: 20,
        goals: 0,
        assists: 0,
        minsPlayed: 90,
        cleanSheet60: 0,
        lowCoverage: false,
        position: 'Midfielder',
        currentClubGame: false,
      },
      {
        date: '2026-07-13T18:00:00.000Z',
        allAroundScore: 20,
        goals: 0,
        assists: 0,
        minsPlayed: 90,
        cleanSheet60: 0,
        lowCoverage: false,
        position: 'Midfielder',
        currentClubGame: false,
      },
      {
        date: '2026-07-06T18:00:00.000Z',
        allAroundScore: 20,
        goals: 1,
        assists: 0,
        minsPlayed: 90,
        cleanSheet60: 0,
        lowCoverage: false,
        position: 'Midfielder',
        currentClubGame: true,
      },
      {
        date: '2026-06-29T18:00:00.000Z',
        allAroundScore: 20,
        goals: 0,
        assists: 1,
        minsPlayed: 90,
        cleanSheet60: 0,
        lowCoverage: false,
        position: 'Midfielder',
        currentClubGame: true,
      },
    ];

    expect(
      calculateHistoricalGoalMetrics(
        mixedClubHistory,
        'Midfielder',
        true,
      ).l15,
    ).toEqual({ value: 0.5, sampleSize: 2 });
    expect(
      calculateHistoricalAssistMetrics(
        mixedClubHistory,
        'Midfielder',
        true,
      ).l15,
    ).toEqual({ value: 0.5, sampleSize: 2 });
    expect(
      calculateHistoricalDecisiveMetrics(
        mixedClubHistory,
        'Midfielder',
        true,
      ).l15,
    ).toEqual({ value: 1, sampleSize: 2 });
  });

  it('keeps previous-club history until a transferred player debuts', () => {
    const preDebutHistory: PlayerAppearance[] = [
      {
        date: '2026-07-20T18:00:00.000Z',
        allAroundScore: 20,
        goals: 1,
        assists: 0,
        minsPlayed: 90,
        cleanSheet60: 0,
        lowCoverage: false,
        position: 'Forward',
        currentClubGame: false,
      },
      {
        date: '2026-07-13T18:00:00.000Z',
        allAroundScore: 20,
        goals: 0,
        assists: 0,
        minsPlayed: 90,
        cleanSheet60: 0,
        lowCoverage: false,
        position: 'Forward',
        currentClubGame: false,
      },
    ];

    expect(
      calculateHistoricalGoalMetrics(
        preDebutHistory,
        'Forward',
        true,
      ).l15,
    ).toEqual({ value: 0.5, sampleSize: 2 });
  });
});

describe('hasAnyDisplayData', () => {
  const emptyDefender: PlayerStats = {
    slug: 'new-defender',
    displayName: 'New Defender',
    position: 'Defender',
    aaL10: { value: null, sampleSize: 0 },
    cleanSheetL10: { value: null, sampleSize: 0 },
    goalL10: { value: null, sampleSize: 0 },
    nextGame: null,
    excludedLowCoverage: 0,
  };

  it('keeps a zero-L10 player displayable when next-game data exists', () => {
    expect(
      hasAnyDisplayData({
        ...emptyDefender,
        nextGame: {
          date: '2026-08-06T23:30:00.000Z',
          cleanSheetProbability: 0.38,
          matchProbabilities: { win: 0.6, draw: 0.22, loss: 0.18 },
          marketOdds: {
            source: 'odds-api-io',
            capturedAt: '2026-08-06T20:00:00.000Z',
            goal: { probability: 0.11, bookmakerCount: 1 },
            assist: null,
          },
        },
      }),
    ).toBe(true);
  });

  it('still treats a player without form or usable fixture data as empty', () => {
    expect(hasAnyDisplayData(emptyDefender)).toBe(false);
  });
});
