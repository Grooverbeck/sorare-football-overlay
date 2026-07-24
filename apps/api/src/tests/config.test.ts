import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

describe('loadConfig cache TTLs', () => {
  it('uses purpose-specific defaults', () => {
    const config = loadConfig({});

    expect(config.playerFormCacheTtlMs).toBe(86_400_000);
    expect(config.fixtureCacheTtlMs).toBe(14_400_000);
    expect(config.nameCacheTtlMs).toBe(2_592_000_000);
    expect(config.nameMissCacheTtlMs).toBe(7_200_000);
  });

  it('accepts the legacy cache TTL as a form-cache fallback', () => {
    const config = loadConfig({ CACHE_TTL_SECONDS: '3600' });

    expect(config.playerFormCacheTtlMs).toBe(3_600_000);
    expect(config.cacheTtlMs).toBe(3_600_000);
    expect(config.fixtureCacheTtlMs).toBe(14_400_000);
  });

  it('allows each cache TTL to be configured independently', () => {
    const config = loadConfig({
      PLAYER_FORM_CACHE_TTL_SECONDS: '43200',
      FIXTURE_CACHE_TTL_SECONDS: '10800',
      NAME_CACHE_TTL_SECONDS: '1209600',
      NAME_MISS_CACHE_TTL_SECONDS: '3600',
    });

    expect(config).toMatchObject({
      playerFormCacheTtlMs: 43_200_000,
      fixtureCacheTtlMs: 10_800_000,
      nameCacheTtlMs: 1_209_600_000,
      nameMissCacheTtlMs: 3_600_000,
    });
  });
});
