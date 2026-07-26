import { describe, expect, it } from 'vitest';
import {
  oddsUsageThresholds,
  protectionForProviderUsage,
  protectionForUsage,
  quotaUsage,
} from '../providers/odds-usage.js';

const checkedAt = '2026-07-26T08:00:00.000Z';
const now = Date.parse(checkedAt);

function usage(ratio: number) {
  const value = quotaUsage(
    'the-odds-api',
    'requests',
    ratio * 1_000,
    1_000,
    checkedAt,
  );
  if (!value) throw new Error('Expected finite quota usage');
  return value;
}

describe('bookmaker quota protection', () => {
  it('uses the configured four-stage safety thresholds', () => {
    expect(
      protectionForUsage(usage(oddsUsageThresholds.warning), now),
    ).toMatchObject({
      level: 'warning',
      allowExternalRequests: true,
      allowRegionalFallback: true,
      allowSnapshotSupplements: true,
    });
    expect(
      protectionForUsage(usage(oddsUsageThresholds.fallbackDisabled), now),
    ).toMatchObject({
      level: 'fallback-disabled',
      allowExternalRequests: true,
      allowRegionalFallback: false,
      allowSnapshotSupplements: true,
    });
    expect(
      protectionForUsage(usage(oddsUsageThresholds.essentialOnly), now),
    ).toMatchObject({
      level: 'essential-only',
      allowExternalRequests: true,
      allowRegionalFallback: false,
      allowSnapshotSupplements: false,
    });
    expect(
      protectionForUsage(usage(oddsUsageThresholds.stopped), now),
    ).toMatchObject({
      level: 'stopped',
      allowExternalRequests: false,
      allowRegionalFallback: false,
      allowSnapshotSupplements: false,
    });
  });

  it('keeps the last protection state when a daily usage refresh is delayed', () => {
    const stale = usage(0.95);
    const protection = protectionForUsage(
      stale,
      now + 49 * 60 * 60 * 1_000,
    );

    expect(protection).toMatchObject({
      level: 'stopped',
      ratio: 0.95,
      allowExternalRequests: false,
    });
  });

  it('keeps new SportsGameOdds fixtures enabled at 70 percent and switches to cache-only at 85 percent', () => {
    const restrictedUsage = quotaUsage(
      'sports-game-odds',
      'objects',
      1_750,
      2_500,
      checkedAt,
    );
    if (!restrictedUsage) throw new Error('Expected finite quota usage');

    expect(
      protectionForProviderUsage(
        'sports-game-odds',
        restrictedUsage,
        now,
      ),
    ).toMatchObject({
      level: 'essential-only',
      ratio: 0.7,
      allowExternalRequests: true,
      allowRegionalFallback: false,
      allowSnapshotSupplements: false,
    });

    const cacheOnlyUsage = quotaUsage(
      'sports-game-odds',
      'objects',
      2_125,
      2_500,
      checkedAt,
    );
    if (!cacheOnlyUsage) throw new Error('Expected finite quota usage');

    expect(
      protectionForProviderUsage(
        'sports-game-odds',
        cacheOnlyUsage,
        now,
      ),
    ).toMatchObject({
      level: 'cache-only',
      ratio: 0.85,
      allowExternalRequests: false,
      allowRegionalFallback: false,
      allowSnapshotSupplements: false,
    });
  });
});
