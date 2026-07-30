import { z } from 'zod';
import type { AppLogger } from '../logger.js';

export const OddsProviderNameSchema = z.enum([
  'the-odds-api',
  'odds-api-io',
  'odds-api-io-hourly',
  'sports-game-odds',
]);
export type OddsProviderName = z.infer<typeof OddsProviderNameSchema>;

export const ProviderQuotaIntervalSchema = z.object({
  unit: z.enum(['minute', 'hour', 'day', 'month']),
  startsAt: z.string().datetime().nullable(),
  endsAt: z.string().datetime().nullable(),
});
export type ProviderQuotaInterval = z.infer<
  typeof ProviderQuotaIntervalSchema
>;

const defaultMonthlyInterval = {
  unit: 'month',
  startsAt: null,
  endsAt: null,
} as const satisfies ProviderQuotaInterval;

export const ProviderQuotaUsageSchema = z.object({
  provider: OddsProviderNameSchema,
  unit: z.enum(['requests', 'objects']),
  used: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  remaining: z.number().int().nonnegative(),
  interval: ProviderQuotaIntervalSchema.default(defaultMonthlyInterval),
  checkedAt: z.string().datetime(),
});
export type ProviderQuotaUsage = z.infer<typeof ProviderQuotaUsageSchema>;

export interface ProviderQuotaUsageStore {
  get(provider: OddsProviderName): Promise<ProviderQuotaUsage | undefined>;
  set(usage: ProviderQuotaUsage): void | Promise<void>;
  claimRefreshLease?(
    provider: OddsProviderName,
    lease: string,
    ttlSeconds: number,
  ): Promise<boolean>;
}

export class InMemoryProviderQuotaUsageStore
  implements ProviderQuotaUsageStore
{
  private readonly entries = new Map<OddsProviderName, ProviderQuotaUsage>();
  private readonly refreshLeases = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  async get(
    provider: OddsProviderName,
  ): Promise<ProviderQuotaUsage | undefined> {
    return this.entries.get(provider);
  }

  set(usage: ProviderQuotaUsage): void {
    this.entries.set(usage.provider, ProviderQuotaUsageSchema.parse(usage));
  }

  async claimRefreshLease(
    provider: OddsProviderName,
    lease: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const key = `${provider}:${lease}`;
    const now = this.now();
    const expiresAt = this.refreshLeases.get(key);
    if (expiresAt !== undefined && expiresAt > now) return false;
    this.refreshLeases.set(
      key,
      now + Math.max(1, ttlSeconds) * 1_000,
    );
    return true;
  }
}

export const oddsUsageThresholds = {
  warning: 0.5,
  fallbackDisabled: 0.7,
  essentialOnly: 0.85,
  stopped: 0.9,
} as const;

export type OddsUsageProtectionLevel =
  | 'normal'
  | 'warning'
  | 'fallback-disabled'
  | 'cache-only'
  | 'essential-only'
  | 'stopped';

export interface OddsUsageProtection {
  level: OddsUsageProtectionLevel;
  ratio: number | null;
  allowExternalRequests: boolean;
  allowRegionalFallback: boolean;
  allowSnapshotSupplements: boolean;
}

export function quotaUsageRatio(usage: ProviderQuotaUsage): number {
  return Math.min(1, usage.used / usage.limit);
}

export function protectionForUsage(
  usage: ProviderQuotaUsage | undefined,
  _now: number = Date.now(),
): OddsUsageProtection {
  if (!usage || !Number.isFinite(Date.parse(usage.checkedAt))) {
    return {
      level: 'normal',
      ratio: null,
      allowExternalRequests: true,
      allowRegionalFallback: true,
      allowSnapshotSupplements: true,
    };
  }

  const ratio = quotaUsageRatio(usage);
  if (ratio >= oddsUsageThresholds.stopped) {
    return {
      level: 'stopped',
      ratio,
      allowExternalRequests: false,
      allowRegionalFallback: false,
      allowSnapshotSupplements: false,
    };
  }
  if (ratio >= oddsUsageThresholds.essentialOnly) {
    return {
      level: 'essential-only',
      ratio,
      allowExternalRequests: true,
      allowRegionalFallback: false,
      allowSnapshotSupplements: false,
    };
  }
  if (ratio >= oddsUsageThresholds.fallbackDisabled) {
    return {
      level: 'fallback-disabled',
      ratio,
      allowExternalRequests: true,
      allowRegionalFallback: false,
      allowSnapshotSupplements: true,
    };
  }
  if (ratio >= oddsUsageThresholds.warning) {
    return {
      level: 'warning',
      ratio,
      allowExternalRequests: true,
      allowRegionalFallback: true,
      allowSnapshotSupplements: true,
    };
  }
  return {
    level: 'normal',
    ratio,
    allowExternalRequests: true,
    allowRegionalFallback: true,
    allowSnapshotSupplements: true,
  };
}

export function protectionForProviderUsage(
  provider: OddsProviderName,
  usage: ProviderQuotaUsage | undefined,
  now: number = Date.now(),
): OddsUsageProtection {
  const protection = protectionForUsage(usage, now);
  if (
    provider !== 'sports-game-odds' ||
    protection.ratio === null ||
    protection.ratio < oddsUsageThresholds.fallbackDisabled ||
    protection.level === 'stopped'
  ) {
    return protection;
  }
  if (protection.ratio < oddsUsageThresholds.essentialOnly) {
    return {
      level: 'essential-only',
      ratio: protection.ratio,
      allowExternalRequests: true,
      allowRegionalFallback: false,
      allowSnapshotSupplements: false,
    };
  }
  return {
    level: 'cache-only',
    ratio: protection.ratio,
    allowExternalRequests: false,
    allowRegionalFallback: false,
    allowSnapshotSupplements: false,
  };
}

export async function providerProtection(
  store: ProviderQuotaUsageStore | undefined,
  provider: OddsProviderName,
  logger: AppLogger,
  now: number = Date.now(),
): Promise<OddsUsageProtection> {
  let usage: ProviderQuotaUsage | undefined;
  try {
    usage = store ? await store.get(provider) : undefined;
  } catch (error) {
    logger.warn(
      {
        provider,
        error: error instanceof Error ? error.message : String(error),
      },
      'Bookmaker quota state unavailable; continuing with cached market safeguards',
    );
  }
  const protection = protectionForProviderUsage(provider, usage, now);
  if (protection.level !== 'normal') {
    logger.warn(
      {
        provider,
        usagePercent:
          protection.ratio === null
            ? null
            : Math.round(protection.ratio * 1_000) / 10,
        protection: protection.level,
      },
      'Bookmaker quota protection active',
    );
  }
  return protection;
}

export function quotaUsage(
  provider: OddsProviderName,
  unit: ProviderQuotaUsage['unit'],
  used: number,
  limit: number,
  checkedAt: string,
  interval: ProviderQuotaInterval = defaultMonthlyInterval,
): ProviderQuotaUsage | null {
  if (
    !Number.isFinite(used) ||
    !Number.isFinite(limit) ||
    used < 0 ||
    limit <= 0
  ) {
    return null;
  }
  const normalizedUsed = Math.max(0, Math.floor(used));
  const normalizedLimit = Math.max(1, Math.floor(limit));
  return ProviderQuotaUsageSchema.parse({
    provider,
    unit,
    used: normalizedUsed,
    limit: normalizedLimit,
    remaining: Math.max(0, normalizedLimit - normalizedUsed),
    interval,
    checkedAt,
  });
}
