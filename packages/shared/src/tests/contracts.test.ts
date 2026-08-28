import { describe, expect, it } from 'vitest';
import {
  LineupSortValuesRequestSchema,
  LineupSortValuesSuccessResponseSchema,
  PlayerMarketSnapshotsRequestSchema,
  PlayerMarketSnapshotsSuccessResponseSchema,
  PlayerStatsRequestSchema,
  PlayerStatsSchema,
} from '../contracts.js';

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

  it('accepts the win rate from the exact AA appearance sample', () => {
    expect(
      PlayerStatsSchema.parse({
        ...fixture,
        aaL10TeamWinRate: { value: 0.4, sampleSize: 10 },
      }).aaL10TeamWinRate,
    ).toEqual({ value: 0.4, sampleSize: 10 });
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

describe('PlayerStatsRequestSchema odds cache mode', () => {
  it('keeps old clients refresh-capable and accepts explicit cache-only follow-ups', () => {
    expect(
      PlayerStatsRequestSchema.parse({ slugs: ['contract-player'] })
        .oddsCacheOnly,
    ).toBe(false);
    expect(
      PlayerStatsRequestSchema.parse({
        slugs: ['contract-player'],
        oddsCacheOnly: true,
      }).oddsCacheOnly,
    ).toBe(true);
  });
});

describe('LineupSortValues contracts', () => {
  it('accepts a provider-free batch of up to fifty players', () => {
    const slugs = Array.from({ length: 50 }, (_, index) => `player-${index + 1}`);
    expect(
      LineupSortValuesRequestSchema.parse({
        slugs,
        historicalGoalWindow: 15,
      }),
    ).toMatchObject({ slugs, historicalGoalWindow: 15 });
  });

  it('rejects oversized batches', () => {
    const slugs = Array.from({ length: 51 }, (_, index) => `player-${index + 1}`);
    expect(
      LineupSortValuesRequestSchema.safeParse({ slugs }).success,
    ).toBe(false);
  });

  it('keeps the compact response free of full fixture and form payloads', () => {
    const response = LineupSortValuesSuccessResponseSchema.parse({
      data: [
        {
          slug: 'contract-player',
          displayName: 'Contract Player',
          position: 'Defender',
          goal: { probability: 0.25, source: 'market' },
          aa: 10,
        },
      ],
      meta: {
        requested: 1,
        returned: 1,
        cacheHits: 1,
        source: 'sorare',
        durationMs: 2.5,
      },
    });

    expect(response.data[0]).not.toHaveProperty('nextGame');
    expect(response.data[0]).not.toHaveProperty('historicalGoals');
  });
});

describe('Player market snapshot contracts', () => {
  it('accepts canonical response context without requiring full form metrics', () => {
    const request = PlayerMarketSnapshotsRequestSchema.parse({
      players: [
        {
          slug: fixture.slug,
          displayName: fixture.displayName,
          position: fixture.position,
          nextGame: {
            ...fixture.nextGame,
            playerTeamSlug: 'home-fc',
            marketOdds: null,
          },
        },
      ],
    });

    expect(request.players).toHaveLength(1);
    expect(request.players[0]).not.toHaveProperty('aaL10');
  });

  it('distinguishes pending, settled and unsupported cache reads', () => {
    const base = {
      slug: fixture.slug,
      position: fixture.position,
      fixture: {
        date: fixture.nextGame.date,
        playerTeamSlug: 'home-fc',
      },
      marketOdds: null,
    };
    const response = PlayerMarketSnapshotsSuccessResponseSchema.parse({
      data: [
        { ...base, refreshState: 'pending' },
        { ...base, refreshState: 'settled' },
        { ...base, refreshState: 'unsupported' },
      ],
      meta: {
        requested: 3,
        returned: 3,
        source: 'sorare',
        durationMs: 1.2,
      },
    });

    expect(response.data.map(({ refreshState }) => refreshState)).toEqual([
      'pending',
      'settled',
      'unsupported',
    ]);
  });

  it('rejects more than fifty snapshot targets', () => {
    const players = Array.from({ length: 51 }, (_, index) => ({
      slug: `player-${index + 1}`,
      displayName: `Player ${index + 1}`,
      position: 'Forward' as const,
      nextGame: fixture.nextGame,
    }));
    expect(
      PlayerMarketSnapshotsRequestSchema.safeParse({ players }).success,
    ).toBe(false);
  });
});
