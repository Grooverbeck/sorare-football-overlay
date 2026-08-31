import { describe, expect, it, vi } from 'vitest';
import {
  CloudflareProviderQuotaUsageStore,
  type JsonKeyValueStore,
} from '../cloudflare/cache.js';
import { quotaUsage } from '../providers/odds-usage.js';

describe('Cloudflare request-local cache stores', () => {
  it('memoizes provider quota reads and updates the memo after a write', async () => {
    const initial = quotaUsage(
      'odds-api-io',
      'requests',
      10,
      500,
      '2026-08-31T00:00:00.000Z',
    );
    const updated = quotaUsage(
      'odds-api-io',
      'requests',
      11,
      500,
      '2026-08-31T00:01:00.000Z',
    );
    if (!initial || !updated) throw new Error('Expected valid quota usage');
    const get = vi.fn(async () => initial);
    const put = vi.fn(async () => undefined);
    const namespace: JsonKeyValueStore = {
      get,
      put,
      delete: vi.fn(async () => undefined),
    };
    const store = new CloudflareProviderQuotaUsageStore(namespace);

    await expect(
      Promise.all([store.get('odds-api-io'), store.get('odds-api-io')]),
    ).resolves.toEqual([initial, initial]);
    expect(get).toHaveBeenCalledTimes(1);

    await store.set(updated);
    await expect(store.get('odds-api-io')).resolves.toEqual(updated);
    expect(get).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
  });
});
