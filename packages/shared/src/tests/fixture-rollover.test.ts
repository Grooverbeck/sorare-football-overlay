import { describe, expect, it } from 'vitest';
import { fixtureRolloverAtMs } from '../fixture-rollover.js';

describe('fixture rollover at 09:00 Europe/Berlin', () => {
  it.each([
    ['summer', '2026-09-10T19:00:00Z', '2026-09-11T07:00:00Z'],
    ['winter', '2026-12-10T19:00:00Z', '2026-12-11T08:00:00Z'],
    ['start of summer time', '2026-03-28T19:00:00Z', '2026-03-29T07:00:00Z'],
    ['end of summer time', '2026-10-24T19:00:00Z', '2026-10-25T08:00:00Z'],
    ['year boundary', '2026-12-31T19:00:00Z', '2027-01-01T08:00:00Z'],
    ['UTC overnight match day', '2026-07-26T00:30:00Z', '2026-07-27T07:00:00Z'],
    ['late kickoff', '2026-09-10T23:59:00Z', '2026-09-11T07:00:00Z'],
    ['explicit timezone', '2026-09-10T21:00:00+02:00', '2026-09-11T07:00:00Z'],
  ])('handles %s', (_label, kickoff, expected) => {
    const boundary = fixtureRolloverAtMs(kickoff);
    expect(boundary).toBe(Date.parse(expected));
    expect(boundary! - Date.parse(kickoff)).toBeGreaterThanOrEqual(6 * 3_600_000);
  });

  it('ignores invalid fixture dates', () => {
    expect(fixtureRolloverAtMs('not-a-date')).toBeNull();
  });
});
