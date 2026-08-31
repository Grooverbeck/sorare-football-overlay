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
  it('loads multiple cache entries with one D1 query', async () => {
    const all = vi.fn(async () => ({
      results: [
        { cache_key: 'market:a', value: JSON.stringify({ value: 'first' }) },
        { cache_key: 'market:b', value: JSON.stringify({ value: 'second' }) },
      ],
    }));
    const bind = vi.fn(() => ({ all }));
    const prepare = vi.fn(() => ({ bind }));
    const store = new D1JsonKeyValueStore(
      { prepare } as unknown as D1Database,
      undefined,
      () => 123,
    );

    const values = await store.getMany<{ value: string }>(
      ['market:a', 'market:b'],
      'json',
    );

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(bind).toHaveBeenCalledWith('market:a', 'market:b', 123);
    expect(values).toEqual(
      new Map([
        ['market:a', { value: 'first' }],
        ['market:b', { value: 'second' }],
      ]),
    );
  });

  it('uses one D1 batch call when a cache read needs multiple statements', async () => {
    const boundStatements: Array<{
      values: unknown[];
      all: ReturnType<typeof vi.fn>;
    }> = [];
    const prepare = vi.fn(() => ({
      bind: (...values: unknown[]) => {
        const statement = {
          values,
          all: vi.fn(async () => ({ results: [] })),
        };
        boundStatements.push(statement);
        return statement;
      },
    }));
    const batch = vi.fn(async () => [
      {
        results: [
          { cache_key: 'key-0', value: JSON.stringify({ value: 0 }) },
        ],
      },
      {
        results: [
          { cache_key: 'key-99', value: JSON.stringify({ value: 99 }) },
        ],
      },
    ]);
    const store = new D1JsonKeyValueStore(
      { prepare, batch } as unknown as D1Database,
      undefined,
      () => 456,
    );
    const keys = Array.from({ length: 100 }, (_, index) => `key-${index}`);

    const values = await store.getMany<{ value: number }>(keys, 'json');

    expect(prepare).toHaveBeenCalledTimes(2);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(boundStatements[0]?.values).toHaveLength(100);
    expect(boundStatements[0]?.values.at(-1)).toBe(456);
    expect(boundStatements[1]?.values).toEqual(['key-99', 456]);
    expect(boundStatements.every(({ all }) => all.mock.calls.length === 0)).toBe(
      true,
    );
    expect(values).toEqual(
      new Map([
        ['key-0', { value: 0 }],
        ['key-99', { value: 99 }],
      ]),
    );
  });

  it('deletes expired cache entries in a bounded batch', async () => {
    const run = vi.fn(async () => ({ meta: { changes: 37 } }));
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));
    const store = new D1JsonKeyValueStore(
      { prepare } as unknown as D1Database,
      undefined,
      () => 789,
    );

    await expect(store.deleteExpired(20_000)).resolves.toBe(37);

    expect(bind).toHaveBeenCalledWith(789, 5_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

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

  it('does not consult stale KV data after an ordinary D1 miss', async () => {
    const get = vi.fn(async () => ({ source: 'kv' }));
    const store = new D1JsonKeyValueStore(
      databaseReturning(null),
      fallbackStore(get),
      () => 1,
    );

    await expect(store.get('player-form:v3:test', 'json')).resolves.toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('does not batch-read stale KV data for keys missing from D1', async () => {
    const all = vi.fn(async () => ({ results: [] }));
    const prepare = vi.fn(() => ({ bind: () => ({ all }) }));
    const getMany = vi.fn(async () =>
      new Map([['player-form:v3:test', { source: 'kv' }]]),
    );
    const fallback = {
      ...fallbackStore(vi.fn(async () => ({ source: 'kv' }))),
      getMany,
    };
    const store = new D1JsonKeyValueStore(
      { prepare } as unknown as D1Database,
      fallback,
      () => 1,
    );

    await expect(
      store.getMany(['player-form:v3:test'], 'json'),
    ).resolves.toEqual(new Map());
    expect(getMany).not.toHaveBeenCalled();
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
