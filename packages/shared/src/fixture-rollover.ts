const HOUR_MS = 60 * 60 * 1_000;
const ROLLOVER_HOUR_BERLIN = 9;
const MINIMUM_POST_KICKOFF_MS = 6 * HOUR_MS;
export const FIXTURE_STATUS_START_MS = 2 * HOUR_MS;
export const FIXTURE_STATUS_INTERVAL_MS = 15 * 60 * 1_000;

export function fixtureStatusKey(fixture: {date: string; homeTeamSlug?: string | undefined; awayTeamSlug?: string | undefined}): string | null {
  const kickoff = Date.parse(fixture.date);
  if (!Number.isFinite(kickoff) || !fixture.homeTeamSlug || !fixture.awayTeamSlug) return null;
  return `fixture-status:v1:${Math.floor(kickoff / 1_000)}:${fixture.homeTeamSlug.toLowerCase()}:${fixture.awayTeamSlug.toLowerCase()}`;
}

// Reuse the formatter rather than constructing one for every card/cache read.
const berlinHour = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Berlin',
  hour: '2-digit',
  hourCycle: 'h23',
});

/** Morning fixture boundary, in milliseconds; invalid dates have no boundary. */
export function fixtureRolloverAtMs(fixtureDate: string): number | null {
  const kickoffMs = Date.parse(fixtureDate);
  if (!Number.isFinite(kickoffMs)) return null;
  const kickoff = new Date(kickoffMs);
  // Preserve the existing UTC match-day assignment, including overnight games.
  const morningUtc = Date.UTC(
    kickoff.getUTCFullYear(),
    kickoff.getUTCMonth(),
    kickoff.getUTCDate() + 1,
    ROLLOVER_HOUR_BERLIN,
  );
  // At this morning hour any DST transition has already happened. Determine
  // the offset on the rollover day, not the kickoff day (which may differ).
  const offsetHours = Number(berlinHour.format(morningUtc)) - ROLLOVER_HOUR_BERLIN;
  const morningBerlin = morningUtc - offsetHours * HOUR_MS;
  return Math.max(morningBerlin, kickoffMs + MINIMUM_POST_KICKOFF_MS);
}
