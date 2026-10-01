import {describe, expect, it} from 'vitest';
import {FIXTURE_IDENTITY_VERSION, oddsApiIoMissingMarketRetryAt, shouldRetryMarketFailure, type MarketSnapshot} from '../providers/market-odds-provider.js';

const hour = 3_600_000;
const kickoff = Date.parse('2026-10-03T16:00:00Z');

describe('provider-specific missing-market retries', () => {
  it.each([[48, 6], [24, 2], [12, 2], [6, 1], [3, 1]])('retries at %ih lead after %ih', (lead, delay) => {
    const checked = kickoff - lead * hour;
    expect(oddsApiIoMissingMarketRetryAt(checked, kickoff)).toBe(checked + delay * hour);
  });
  it('checks at the 24h and 6h boundaries, but never at or after kickoff', () => {
    expect(oddsApiIoMissingMarketRetryAt(kickoff - 25 * hour, kickoff)).toBe(kickoff - 24 * hour);
    expect(oddsApiIoMissingMarketRetryAt(kickoff - 7 * hour, kickoff)).toBe(kickoff - 6 * hour);
    expect(oddsApiIoMissingMarketRetryAt(kickoff - 30 * 60_000, kickoff)).toBeNull();
    expect(oddsApiIoMissingMarketRetryAt(kickoff, kickoff)).toBeNull();
    expect(oddsApiIoMissingMarketRetryAt(NaN, kickoff)).toBeNull();
  });
  it('lazily replaces the old 24h gate for Odds.io while paid-provider policy stays unchanged', () => {
    const failure: MarketSnapshot = {status: 'unavailable', market: 'player_goal_scorer_anytime',
      fixtureIdentityVersion: FIXTURE_IDENTITY_VERSION, checkedAt: new Date(kickoff - 72 * hour).toISOString(),
      nextRetryAt: new Date(kickoff - 24 * hour).toISOString(), attemptCount: 1};
    expect(shouldRetryMarketFailure(failure, kickoff, kickoff - 66 * hour - 1, 'odds-api-io')).toBe(false);
    expect(shouldRetryMarketFailure(failure, kickoff, kickoff - 66 * hour, 'odds-api-io')).toBe(true);
    expect(shouldRetryMarketFailure(failure, kickoff, kickoff - 66 * hour)).toBe(false);
    expect(shouldRetryMarketFailure(failure, kickoff, kickoff, 'odds-api-io')).toBe(false);
  });
});
