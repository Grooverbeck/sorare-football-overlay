import { describe, expect, it } from 'vitest';
import { getMlsMarketProbabilityBand } from '../market-probability-benchmarks.js';

describe('MLS market probability quality bands', () => {
  it('compares goal probabilities within the card position', () => {
    expect(getMlsMarketProbabilityBand('goal', 'Defender', 0.05)?.tone).toBe('very-low');
    expect(getMlsMarketProbabilityBand('goal', 'Defender', 0.08)?.tone).toBe('good');
    expect(getMlsMarketProbabilityBand('goal', 'Midfielder', 0.08)?.tone).toBe('very-low');
    expect(getMlsMarketProbabilityBand('goal', 'Midfielder', 0.2)?.tone).toBe('good');
    expect(getMlsMarketProbabilityBand('goal', 'Forward', 0.4)).toEqual({
      tone: 'strong',
      label: 'sehr gut',
    });
    expect(getMlsMarketProbabilityBand('goal', 'Forward', 0.41)?.tone).toBe('elite');
  });

  it('uses separate position-aware assist bands', () => {
    expect(getMlsMarketProbabilityBand('assist', 'Defender', 0.05)?.tone).toBe('very-low');
    expect(getMlsMarketProbabilityBand('assist', 'Defender', 0.15)?.tone).toBe('good');
    expect(getMlsMarketProbabilityBand('assist', 'Midfielder', 0.13)?.tone).toBe('very-low');
    expect(getMlsMarketProbabilityBand('assist', 'Forward', 0.18)).toEqual({
      tone: 'balanced',
      label: 'mittel',
    });
    expect(getMlsMarketProbabilityBand('assist', 'Midfielder', 0.305)).toEqual({
      tone: 'strong',
      label: 'sehr gut',
    });
    expect(getMlsMarketProbabilityBand('assist', 'Forward', 0.313)?.tone).toBe('elite');
  });

  it('uses position-aware bands for the combined decisive estimate', () => {
    expect(getMlsMarketProbabilityBand('decisive', 'Defender', 0.2)?.tone).toBe('good');
    expect(getMlsMarketProbabilityBand('decisive', 'Midfielder', 0.2)?.tone).toBe('very-low');
    expect(getMlsMarketProbabilityBand('decisive', 'Forward', 0.45)?.tone).toBe('balanced');
  });

  it('rejects unsupported, missing and non-finite values', () => {
    expect(getMlsMarketProbabilityBand('goal', 'Forward', null)).toBeNull();
    expect(getMlsMarketProbabilityBand('assist', 'Midfielder', undefined)).toBeNull();
    expect(getMlsMarketProbabilityBand('goal', 'Defender', Number.NaN)).toBeNull();
    expect(getMlsMarketProbabilityBand('goal', 'Goalkeeper', 0.5)).toBeNull();
  });
});
