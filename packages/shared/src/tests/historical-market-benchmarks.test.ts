import { describe, expect, it } from 'vitest';
import { getMlsHistoricalMarketProbabilityBand } from '../historical-market-benchmarks.js';
import { getMlsMarketProbabilityBand } from '../market-probability-benchmarks.js';

describe('MLS historical goal/assist quality bands', () => {
  it('uses lower bands than volatile next-match odds', () => {
    expect(
      getMlsHistoricalMarketProbabilityBand('assist', 'Forward', 0.2)?.tone,
    ).toBe('strong');
    expect(getMlsMarketProbabilityBand('assist', 'Forward', 0.2)?.tone).toBe(
      'balanced',
    );
    expect(
      getMlsHistoricalMarketProbabilityBand('assist', 'Forward', 0.31)?.tone,
    ).toBe('elite');
    expect(getMlsMarketProbabilityBand('assist', 'Forward', 0.31)?.tone).toBe(
      'strong',
    );
  });

  it('keeps historical bands position- and market-specific', () => {
    expect(
      getMlsHistoricalMarketProbabilityBand('goal', 'Defender', 0.1)?.tone,
    ).toBe('strong');
    expect(
      getMlsHistoricalMarketProbabilityBand('goal', 'Midfielder', 0.1)?.tone,
    ).toBe('balanced');
    expect(
      getMlsHistoricalMarketProbabilityBand('goal', 'Forward', 0.1)?.tone,
    ).toBe('balanced');
    expect(
      getMlsHistoricalMarketProbabilityBand('assist', 'Midfielder', 0.2)?.tone,
    ).toBe('strong');
  });

  it('rejects unsupported, missing and non-finite values', () => {
    expect(
      getMlsHistoricalMarketProbabilityBand('goal', 'Goalkeeper', 0.5),
    ).toBeNull();
    expect(
      getMlsHistoricalMarketProbabilityBand('assist', 'Forward', null),
    ).toBeNull();
    expect(
      getMlsHistoricalMarketProbabilityBand(
        'goal',
        'Defender',
        Number.NaN,
      ),
    ).toBeNull();
  });
});
