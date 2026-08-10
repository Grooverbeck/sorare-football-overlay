import { describe, expect, it } from 'vitest';
import { PlayerStatsSchema } from '../contracts.js';

const fixture = {
  slug: 'contract-player',
  displayName: 'Contract Player',
  position: 'Defender' as const,
  aaL10: { value: 10, sampleSize: 10 },
  cleanSheetL10: { value: 0.3, sampleSize: 10 },
  goalL10: { value: 0.1, sampleSize: 10 },
  nextGame: {
    date: '2026-08-12T18:00:00.000Z',
    homeTeamName: 'Home',
    awayTeamName: 'Away',
    playerTeamName: 'Home',
    opponentTeamName: 'Away',
    cleanSheetProbability: 0.4,
    matchProbabilities: { win: 0.5, draw: 0.25, loss: 0.25 },
  },
  excludedLowCoverage: 0,
};

describe('PlayerStatsSchema team fixture identity', () => {
  it('keeps legacy fixtures without a team slug valid', () => {
    expect(PlayerStatsSchema.safeParse(fixture).success).toBe(true);
  });

  it('accepts a canonical Sorare team slug', () => {
    expect(
      PlayerStatsSchema.safeParse({
        ...fixture,
        nextGame: {
          ...fixture.nextGame,
          playerTeamSlug: 'minnesota-united',
        },
      }).success,
    ).toBe(true);
  });

  it('rejects a non-canonical team slug', () => {
    expect(
      PlayerStatsSchema.safeParse({
        ...fixture,
        nextGame: {
          ...fixture.nextGame,
          playerTeamSlug: 'Minnesota United!',
        },
      }).success,
    ).toBe(false);
  });
});
