import { describe, expect, it } from 'vitest';
import { EUROPEAN_MARKET_BENCHMARKS, getEuropeanMarketProbabilityBand, getEuropeanHistoricalMarketProbabilityBand } from '../european-market-benchmarks.js';

const tones = ['very-low', 'low', 'balanced', 'good', 'strong', 'elite'];
const positions = ['Defender', 'Midfielder', 'Forward'] as const;
const markets = ['goal', 'assist'] as const;

describe('frozen European goal and assist bands', () => {
  for (const source of ['market', 'historical'] as const) {
    const classify = source === 'market' ? getEuropeanMarketProbabilityBand : getEuropeanHistoricalMarketProbabilityBand;
    for (const market of markets) for (const position of positions) {
      it(`${source} ${market} ${position}: ordered, deterministic and monotonic`, () => {
        const thresholds = EUROPEAN_MARKET_BENCHMARKS[source][market][position];
        expect([...thresholds]).toEqual([...thresholds].sort((a, b) => a - b));
        let last = -1;
        for (let percentage = 0; percentage <= 1000; percentage++) {
          const value = percentage / 1000;
          const band = classify(market, position, value)!;
          const rank = tones.indexOf(band.tone);
          expect(rank).toBeGreaterThanOrEqual(last);
          expect(classify(market, position, value)).toEqual(band);
          last = rank;
        }
        for (let i = 0; i < thresholds.length; i++) {
          const cutoff = thresholds[i]!;
          if (cutoff === 0) continue;
          expect(classify(market, position, cutoff - 1e-9)?.tone).toBe(tones[i]);
          expect(classify(market, position, cutoff)?.tone).toBe(tones[i + 1]);
        }
      });
    }
    it(`${source}: missing values are neutral and zero is always very-low`, () => {
      for (const market of markets) for (const position of positions) {
        expect(classify(market, position, null)).toBeNull();
        expect(classify(market, position, undefined)).toBeNull();
        expect(classify(market, position, Number.NaN)).toBeNull();
        expect(classify(market, position, Infinity)).toBeNull();
        expect(classify(market, position, 0)?.tone).toBe('very-low');
      }
      expect(classify('goal', 'Goalkeeper', .5)).toBeNull();
    });
  }
  it('distinguishes position, market and historical observation rates', () => {
    expect(getEuropeanMarketProbabilityBand('goal', 'Defender', .2)?.tone).toBe('elite');
    expect(getEuropeanMarketProbabilityBand('goal', 'Forward', .2)?.tone).toBe('very-low');
    expect(getEuropeanMarketProbabilityBand('assist', 'Midfielder', .25)?.tone).toBe('elite');
    expect(getEuropeanMarketProbabilityBand('goal', 'Midfielder', .25)?.tone).toBe('strong');
    expect(getEuropeanHistoricalMarketProbabilityBand('goal', 'Forward', .2)?.tone).toBe('balanced');
  });
  it('does not expose mutable shared classification objects', () => {
    const result = getEuropeanMarketProbabilityBand('goal', 'Forward', 1)!;
    result.label = 'mittel';
    expect(getEuropeanMarketProbabilityBand('goal', 'Forward', 1)?.label).toBe('Spitze');
  });
});
