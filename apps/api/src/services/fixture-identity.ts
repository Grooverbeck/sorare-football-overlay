import type { PlayerStats } from '@sorare-overlay/shared';

export type PlayerFixture = NonNullable<PlayerStats['nextGame']>;

// Separate from sameFixtureIdentity: bookmaker/snapshot keys remain strictly
// kickoff-scoped. A reschedule must NOT copy player prices across those keys.
export function sameSorareGame(left:PlayerFixture,right:PlayerFixture):boolean {
  if(!left.gameId||!/^Game:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(left.gameId)||left.gameId!==right.gameId)return false;
  const canonical=(value:string|undefined)=>value?.trim().toLowerCase();
  const home=canonical(left.homeTeamSlug),away=canonical(left.awayTeamSlug),team=canonical(left.playerTeamSlug);
  return Boolean(home&&away&&home!==away&&team&&(team===home||team===away)&&
    home===canonical(right.homeTeamSlug)&&away===canonical(right.awayTeamSlug)&&team===canonical(right.playerTeamSlug)&&
    (!left.competitionSlug||!right.competitionSlug||left.competitionSlug===right.competitionSlug));
}

export function sorareObservationTime(fixture:PlayerFixture):number {
  const value=fixture.sorareObservedAt;
  return value!==undefined&&Number.isSafeInteger(value)&&value>=0?value:0;
}

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
  if (fixture.playerTeamSlug) return fixture.playerTeamSlug.toLocaleLowerCase();
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
    left.homeTeamSlug &&
    left.awayTeamSlug &&
    right.homeTeamSlug &&
    right.awayTeamSlug
  ) {
    return (
      left.homeTeamSlug.toLocaleLowerCase() ===
        right.homeTeamSlug.toLocaleLowerCase() &&
      left.awayTeamSlug.toLocaleLowerCase() ===
        right.awayTeamSlug.toLocaleLowerCase()
    );
  }

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
