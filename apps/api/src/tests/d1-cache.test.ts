import { describe, expect, it, vi } from 'vitest';
import type { JsonKeyValueStore } from '../cloudflare/cache.js';
import { D1JsonKeyValueStore } from '../cloudflare/d1-cache.js';
import type { AppLogger } from '../logger.js';

function databaseReturning(
  result: { value: string } | null | Error,
): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        first: () =>
          result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
      }),
    }),
  } as unknown as D1Database;
}

function fallbackStore(
  get: JsonKeyValueStore['get'],
): JsonKeyValueStore {
  return {
    get,
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
}

function logger(): AppLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('D1JsonKeyValueStore', () => {
  it('uses the KV fallback when the D1 read fails', async () => {
    const d1Error = new Error('D1 unavailable');
    const get = vi.fn(async () => ({ source: 'kv' }));
    const log = logger();
    const store = new D1JsonKeyValueStore(
      databaseReturning(d1Error),
      fallbackStore(get),
      () => 1,
      log,
    );

    await expect(store.get('player-form:v2:test', 'json')).resolves.toEqual({
      source: 'kv',
    });
    expect(get).toHaveBeenCalledWith('player-form:v2:test', 'json');
    expect(log.warn).toHaveBeenCalledWith(
      {
        cacheKey: 'player-form:v2:test',
        error: d1Error,
        fallback: 'kv',
      },
      'D1 cache read failed; attempting KV fallback',
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it('keeps a successful D1 hit primary over KV', async () => {
    const get = vi.fn(async () => ({ source: 'kv' }));
    const log = logger();
    const store = new D1JsonKeyValueStore(
      databaseReturning({ value: JSON.stringify({ source: 'd1' }) }),
      fallbackStore(get),
      () => 1,
      log,
    );

    await expect(store.get('player-form:v2:test', 'json')).resolves.toEqual({
      source: 'd1',
    });
    expect(get).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('reports both cache failures and propagates the KV error', async () => {
    const d1Error = new Error('D1 unavailable');
    const kvError = new Error('KV unavailable');
    const log = logger();
    const store = new D1JsonKeyValueStore(
      databaseReturning(d1Error),
      fallbackStore(vi.fn(async () => Promise.reject(kvError))),
      () => 1,
      log,
    );

    await expect(store.get('player-form:v2:test', 'json')).rejects.toBe(kvError);
    expect(log.error).toHaveBeenCalledWith(
      {
        cacheKey: 'player-form:v2:test',
        d1Error,
        fallbackError: kvError,
      },
      'D1 and KV cache reads failed',
    );
  });
});
