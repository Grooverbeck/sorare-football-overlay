import { describe, expect, it } from 'vitest';
import {
  getMlsAaPercentileBand,
  getMlsAaTopPlayer,
  MLS_AA_BENCHMARKS,
} from '../index.js';

describe('MLS AA benchmarks', () => {
  it('uses position-specific performance bands', () => {
    expect(getMlsAaPercentileBand('Defender', 1, 10)?.tone).toBe('very-low');
    expect(getMlsAaPercentileBand('Defender', 10, 10)?.tone).toBe('balanced');
    expect(getMlsAaPercentileBand('Defender', 18, 10)).toEqual({
      tone: 'strong',
      label: 'P80–90',
    });
    expect(getMlsAaPercentileBand('Forward', 14, 10)?.tone).toBe('strong');
    expect(getMlsAaPercentileBand('Forward', 18, 10)).toEqual({
      tone: 'elite',
      label: 'P90–100',
    });
  });

  it('colors sparse AA samples but leaves missing values unranked', () => {
    expect(getMlsAaPercentileBand('Midfielder', 14, 4)).toEqual({
      tone: 'good',
      label: 'P60–80',
    });
    expect(getMlsAaPercentileBand('Midfielder', null, 10)).toBeNull();
    expect(MLS_AA_BENCHMARKS.minimumMinutes).toBe(60);
    expect(MLS_AA_BENCHMARKS.populationSize).toBe(388);
  });

  it('matches top-three players by the concrete card position and Sorare slug', () => {
    expect(
      getMlsAaTopPlayer(
        'Forward',
        'KRISTOFFER-VELDE',
      ),
    ).toMatchObject({
      rank: 1,
      displayName: 'Kristoffer Velde',
      aa: 23.31,
    });
    expect(
      getMlsAaTopPlayer('Defender', 'lucas-halter'),
    ).toMatchObject({
      rank: 2,
      displayName: 'Lucas Halter',
    });
    expect(getMlsAaTopPlayer('Forward', 'mamadou-fofana')).toBeNull();
  });

  it('keeps a snapshot podium rank stable until the ranking is regenerated', () => {
    expect(
      getMlsAaTopPlayer('Midfielder', 'alonso-coello-camarero'),
    ).toMatchObject({ rank: 2, aa: 24.09, appearances: 10 });
    expect(
      getMlsAaTopPlayer('Forward', 'kristoffer-velde'),
    ).toMatchObject({ rank: 1 });
  });
});
