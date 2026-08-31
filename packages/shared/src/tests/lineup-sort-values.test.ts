import type { PlayerStats } from '../contracts.js';
import { describe, expect, it } from 'vitest';
import {
  lineupGoalSortValue,
  lineupSortValueForPlayer,
} from '../lineup-sort-values.js';

function stats(overrides: Partial<PlayerStats> = {}): PlayerStats {
  return {
    slug: 'sort-player',
    displayName: 'Sort Player',
    position: 'Forward',
    aaL10: { value: 17.5, sampleSize: 10 },
    cleanSheetL10: { value: 0.1, sampleSize: 10 },
    goalL10: { value: 0.2, sampleSize: 10 },
    historicalGoals: {
      l10: { value: 0.1, sampleSize: 10 },
      l15: { value: 0.3, sampleSize: 15 },
      l40: { value: 0.4, sampleSize: 40 },
    },
    nextGame: null,
    excludedLowCoverage: 0,
    ...overrides,
  };
}

describe('lineup sort values', () => {
  it('prefers cached market odds over every historical window', () => {
    expect(
      lineupGoalSortValue(
        stats({
          nextGame: {
            date: '2026-08-29T18:00:00.000Z',
            cleanSheetProbability: null,
            matchProbabilities: null,
            marketOdds: {
              source: 'odds-api-io',
              capturedAt: '2026-08-28T18:00:00.000Z',
              goal: { probability: 0.55, bookmakerCount: 1 },
              assist: null,
              decisive: null,
            },
          },
        }),
        40,
      ),
    ).toEqual({ probability: 0.55, source: 'market' });
  });

  it('uses the selected historical window and falls back to L10', () => {
    expect(lineupGoalSortValue(stats(), 15)).toEqual({
      probability: 0.3,
      source: 'historical',
    });
    const statsWithoutHistoricalWindows = stats();
    delete statsWithoutHistoricalWindows.historicalGoals;
    expect(lineupGoalSortValue(statsWithoutHistoricalWindows, 40)).toEqual({
      probability: 0.2,
      source: 'historical',
    });
  });

  it('returns the compact AA value and excludes goalkeeper goal values', () => {
    expect(
      lineupSortValueForPlayer(
        stats({
          position: 'Goalkeeper',
          nextGame: {
            date: '2026-08-29T18:00:00.000Z',
            cleanSheetProbability: 0.43,
            matchProbabilities: null,
            marketOdds: null,
          },
        }),
        15,
      ),
    ).toMatchObject({ aa: 17.5, goal: null, cleanSheet: 0.43 });
  });

  it('exposes clean-sheet sort values for defenders only among outfield players', () => {
    expect(
      lineupSortValueForPlayer(
        stats({
          position: 'Defender',
          nextGame: {
            date: '2026-08-29T18:00:00.000Z',
            cleanSheetProbability: 0.43,
            matchProbabilities: null,
            marketOdds: null,
          },
        }),
      ).cleanSheet,
    ).toBe(0.43);
    expect(
      lineupSortValueForPlayer(
        stats({
          position: 'Midfielder',
          nextGame: {
            date: '2026-08-29T18:00:00.000Z',
            cleanSheetProbability: 0.43,
            matchProbabilities: null,
            marketOdds: null,
          },
        }),
      ).cleanSheet,
    ).toBeNull();
  });
});
