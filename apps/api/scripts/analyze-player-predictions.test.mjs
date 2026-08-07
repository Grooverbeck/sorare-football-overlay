import { describe, expect, it } from 'vitest';
import {
  parsePlayerSpec,
  predictionFromPlayerStats,
} from './analyze-player-predictions.mjs';

describe('separate player prediction analysis', () => {
  it('parses compact position aliases without involving the overlay', () => {
    expect(parsePlayerSpec('kylian-mbappe-lottin:FWD')).toEqual({
      slug: 'kylian-mbappe-lottin',
      position: 'Forward',
    });
  });

  it('uses API metrics locally and reports missing components explicitly', () => {
    const prediction = predictionFromPlayerStats({
      slug: 'example-forward',
      displayName: 'Example Forward',
      position: 'Forward',
      aaL10: { value: 12, sampleSize: 10 },
      cleanSheetL10: { value: null, sampleSize: 0 },
      goalL10: { value: 0.2, sampleSize: 10 },
      historicalGoals: {
        l10: { value: 0.2, sampleSize: 10 },
        l15: { value: 0.2, sampleSize: 15 },
        l40: { value: 0.15, sampleSize: 40 },
      },
      historicalAssists: {
        l10: { value: 0.1, sampleSize: 10 },
        l15: { value: 0.1, sampleSize: 15 },
        l40: { value: 0.08, sampleSize: 40 },
      },
      nextGame: {
        date: '2026-08-09T13:30:00.000Z',
        cleanSheetProbability: null,
        matchProbabilities: null,
        marketOdds: {
          source: 'mock',
          capturedAt: '2026-08-07T10:00:00.000Z',
          goal: { probability: 0.3, bookmakerCount: 2 },
          assist: null,
        },
      },
      excludedLowCoverage: 0,
    });

    expect(prediction).toMatchObject({
      total: 16,
      complete: true,
      goal: { probability: 0.3, source: 'market' },
      assist: { probability: 0.1, source: 'historical_l15' },
    });
  });
});
