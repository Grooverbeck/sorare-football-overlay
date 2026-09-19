import {LineupSortValueSchema, type PlayerStats} from '../contracts.js';
import { describe, expect, it } from 'vitest';
import {
  lineupGoalSortValue,
  lineupSortValueForPlayer,
  lineupSortReadinessForPlayer,
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
  it('carries goal provenance from the same cache snapshot without adding unrelated assist payloads', () => {
    const goal = {probability: .4, bookmakerCount: 1, bookmakerQuotes: [
      {key: 'book', title: 'Book', decimalOdds: 2.5, probability: .4},
    ]};
    const value = lineupSortValueForPlayer(stats({nextGame: {
      date: '2030-01-02T18:00:00Z', homeTeamSlug: 'home', awayTeamSlug: 'away', cleanSheetProbability: null,
      marketOdds: {source: 'odds-api-io', capturedAt: '2030-01-01T18:00:00Z', goal,
        assist: {probability: .2, bookmakerCount: 1}},
    }}), 15);
    expect(LineupSortValueSchema.parse(value).goalMarket).toEqual({
      source: 'odds-api-io', capturedAt: '2030-01-01T18:00:00Z', goal,
    });
    expect(value.goal?.probability).toBe(value.goalMarket?.goal.probability);
    expect(value.goalMarket).not.toHaveProperty('assist');
    // Old clients ignore the additive field; new clients still accept an old worker.
    expect(LineupSortValueSchema.omit({goalMarket: true}).parse(value).goal).toEqual(value.goal);
    const {goalMarket: _details, ...legacy} = value;
    expect(LineupSortValueSchema.parse(legacy).goal).toEqual(value.goal);
  });

  it('does not invent goal market details for a historical fallback', () => {
    expect(lineupSortValueForPlayer(stats(), 15).goalMarket).toBeUndefined();
  });

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

  it('waits for the selected history instead of silently using a different window', () => {
    expect(lineupGoalSortValue(stats(), 15)).toEqual({
      probability: 0.3,
      source: 'historical',
    });
    const statsWithoutHistoricalWindows = stats();
    delete statsWithoutHistoricalWindows.historicalGoals;
    expect(lineupGoalSortValue(statsWithoutHistoricalWindows, 40)).toBeNull();
    expect(lineupSortReadinessForPlayer(statsWithoutHistoricalWindows, 40).goal).toBe('pending');
    expect(lineupGoalSortValue(statsWithoutHistoricalWindows)).toEqual({
      probability: 0.2,
      source: 'historical',
    });
  });

  it('keeps partial histories open but allows a real goal market to be ready', () => {
    const partial = stats({ pendingRefreshes: ['formHistory'] });
    expect(lineupSortValueForPlayer(partial, 15).readiness).toEqual({ goal: 'pending', aa: 'pending', cleanSheet: 'unavailable' });
    partial.nextGame = {date:'2032-09-13T18:00:00Z', cleanSheetProbability:null, marketOdds:{source:'odds-api-io',capturedAt:'2032-09-13T12:00:00Z',goal:{probability:.5,bookmakerCount:1},assist:null}};
    expect(lineupSortReadinessForPlayer(partial, 15)).toEqual({ goal: 'ready', aa: 'pending', cleanSheet: 'unavailable' });
  });

  it('distinguishes true zero, no history and a pending fixture', () => {
    const noHistory = stats({ goalL10:{value:null,sampleSize:0} });
    expect(lineupSortReadinessForPlayer(noHistory).goal).toBe('unavailable');
    expect(lineupSortReadinessForPlayer(stats({goalL10:{value:0,sampleSize:10}})).goal).toBe('ready');
    expect(lineupSortReadinessForPlayer(stats({pendingRefreshes:['fixture']})).goal).toBe('pending');
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
