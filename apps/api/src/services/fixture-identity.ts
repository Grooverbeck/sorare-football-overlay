import type { PlayerStats } from '@sorare-overlay/shared';

export type PlayerFixture = NonNullable<PlayerStats['nextGame']>;

/**
 * Cache identity for Sorare team names. Unlike bookmaker matching this keeps
 * meaningful suffixes such as FC, CF and SC, so similarly named clubs cannot
 * share a fixture cache entry.
 */
export function strictTeamIdentity(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function playerTeamFixtureIdentity(
  fixture: PlayerFixture,
): string | null {
  if (!fixture.playerTeamName) return null;
  const identity = strictTeamIdentity(fixture.playerTeamName);
  return identity || null;
}

export function sameFixtureIdentity(
  left: PlayerFixture,
  right: PlayerFixture,
): boolean {
  if (left.date !== right.date) return false;

  if (
    left.homeTeamName &&
    left.awayTeamName &&
    right.homeTeamName &&
    right.awayTeamName
  ) {
    return (
      strictTeamIdentity(left.homeTeamName) ===
        strictTeamIdentity(right.homeTeamName) &&
      strictTeamIdentity(left.awayTeamName) ===
        strictTeamIdentity(right.awayTeamName)
    );
  }

  return (
    Boolean(left.playerTeamName) &&
    Boolean(left.opponentTeamName) &&
    Boolean(right.playerTeamName) &&
    Boolean(right.opponentTeamName) &&
    strictTeamIdentity(left.playerTeamName!) ===
      strictTeamIdentity(right.playerTeamName!) &&
    strictTeamIdentity(left.opponentTeamName!) ===
      strictTeamIdentity(right.opponentTeamName!)
  );
}
