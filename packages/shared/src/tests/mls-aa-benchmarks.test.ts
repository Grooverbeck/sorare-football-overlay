import { describe, expect, it } from 'vitest';
import {
  getMlsAaPercentileBand,
  getMlsAaTopPlayer,
  MLS_AA_BENCHMARKS,
} from '../index.js';

describe('MLS AA benchmarks', () => {
  it('uses position-specific performance bands', () => {
    expect(getMlsAaPercentileBand('Defender', 1, 10)?.tone).toBe('very-low');
    expect(getMlsAaPercentileBand('Defender', 7, 10)?.tone).toBe('balanced');
    expect(getMlsAaPercentileBand('Defender', 14, 10)).toEqual({
      tone: 'strong',
      label: 'P80–90',
    });
    expect(getMlsAaPercentileBand('Forward', 9, 10)?.tone).toBe('strong');
    expect(getMlsAaPercentileBand('Forward', 12, 10)).toEqual({
      tone: 'elite',
      label: 'P90–100',
    });
  });

  it('does not rank sparse or missing AA samples', () => {
    expect(getMlsAaPercentileBand('Midfielder', 12, 4)).toBeNull();
    expect(getMlsAaPercentileBand('Midfielder', null, 10)).toBeNull();
    expect(MLS_AA_BENCHMARKS.populationSize).toBe(551);
  });

  it('matches top-three players by the concrete card position and Sorare slug', () => {
    expect(
      getMlsAaTopPlayer(
        'Forward',
        'LIONEL-ANDRES-MESSI-CUCCITTINI',
      ),
    ).toMatchObject({
      rank: 1,
      displayName: 'Lionel Messi',
      aa: 25.04,
    });
    expect(
      getMlsAaTopPlayer('Defender', 'maxwell-woledzi'),
    ).toMatchObject({
      rank: 2,
      displayName: 'Maxwell Woledzi',
    });
    expect(getMlsAaTopPlayer('Forward', 'mamadou-fofana')).toBeNull();
  });

  it('keeps a snapshot podium rank stable until the ranking is regenerated', () => {
    expect(
      getMlsAaTopPlayer('Midfielder', 'alonso-coello-camarero'),
    ).toMatchObject({ rank: 1, aa: 24.09, appearances: 10 });
    expect(
      getMlsAaTopPlayer('Forward', 'lionel-andres-messi-cuccittini'),
    ).toMatchObject({ rank: 1 });
  });
});
