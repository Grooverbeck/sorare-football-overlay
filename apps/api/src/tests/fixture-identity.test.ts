import { describe, expect, it } from 'vitest';
import {
  playerTeamFixtureIdentity,
  sameFixtureIdentity,
  strictTeamIdentity,
} from '../services/fixture-identity.js';

const fixture = (playerTeamName: string) => ({
  date: '2026-08-01T18:00:00.000Z',
  homeTeamName: playerTeamName,
  awayTeamName: 'Opponent FC',
  playerTeamName,
  opponentTeamName: 'Opponent FC',
  cleanSheetProbability: null,
  matchProbabilities: null,
});

describe('fixture cache identity', () => {
  it('keeps meaningful club suffixes instead of using bookmaker aliases', () => {
    expect(strictTeamIdentity('FC Barcelona')).toBe('fc barcelona');
    expect(strictTeamIdentity('Barcelona SC')).toBe('barcelona sc');
    expect(playerTeamFixtureIdentity(fixture('FC Barcelona'))).not.toBe(
      playerTeamFixtureIdentity(fixture('Barcelona SC')),
    );
  });

  it('recognizes the same Sorare fixture without bookmaker normalization', () => {
    expect(
      sameFixtureIdentity(
        fixture('SK Sturm Graz'),
        fixture('SK Sturm Graz'),
      ),
    ).toBe(true);
    expect(
      sameFixtureIdentity(
        fixture('FC Barcelona'),
        fixture('Barcelona SC'),
      ),
    ).toBe(false);
  });

  it('prefers canonical Sorare slugs over changing display names', () => {
    const canonical = {
      ...fixture('Bodø / Glimt'),
      homeTeamSlug: 'bodo-glimt-bodo',
      awayTeamSlug: 'nec-nijmegen',
      playerTeamSlug: 'bodo-glimt-bodo',
    };
    const renamed = {
      ...fixture('Bodo Glimt'),
      homeTeamName: 'Bodo Glimt',
      awayTeamName: 'NEC Nijmegen',
      homeTeamSlug: 'bodo-glimt-bodo',
      awayTeamSlug: 'nec-nijmegen',
      playerTeamSlug: 'bodo-glimt-bodo',
    };

    expect(playerTeamFixtureIdentity(canonical)).toBe('bodo-glimt-bodo');
    expect(sameFixtureIdentity(canonical, renamed)).toBe(true);
  });
});
