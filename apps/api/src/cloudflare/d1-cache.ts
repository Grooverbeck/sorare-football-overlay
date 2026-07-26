import type { JsonKeyValueStore } from './cache.js';

interface D1CacheRow {
  value: string;
}

interface CacheWriteOptions {
  expiration?: number;
  expirationTtl?: number;
}

/**
 * Temporary persistent cache backed by D1. Reads fall back to the existing KV
 * namespace so the already populated weekly form cache remains useful while KV
 * writes are unavailable.
 */
export class D1JsonKeyValueStore implements JsonKeyValueStore {
  constructor(
    private readonly database: D1Database,
    private readonly fallback?: JsonKeyValueStore,
    private readonly nowSeconds: () => number = () =>
      Math.floor(Date.now() / 1_000),
  ) {}

  async get<T = unknown>(key: string, type: 'json'): Promise<T | null> {
    const row = await this.database
      .prepare(
        `SELECT value
         FROM cache_entries
         WHERE cache_key = ?1
           AND (expires_at IS NULL OR expires_at > ?2)`,
      )
      .bind(key, this.nowSeconds())
      .first<D1CacheRow>();

    if (row) {
      try {
        return JSON.parse(row.value) as T;
      } catch {
        await this.delete(key);
      }
    }

    return this.fallback?.get<T>(key, type) ?? null;
  }

  async put(
    key: string,
    value: string,
    options: CacheWriteOptions = {},
  ): Promise<void> {
    const now = this.nowSeconds();
    const expiresAt =
      options.expiration ??
      (options.expirationTtl === undefined
        ? null
        : now + options.expirationTtl);

    await this.database
      .prepare(
        `INSERT INTO cache_entries (cache_key, value, expires_at, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(cache_key) DO UPDATE SET
           value = excluded.value,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`,
      )
      .bind(key, value, expiresAt, now)
      .run();
  }

  async delete(key: string): Promise<void> {
    await this.database
      .prepare('DELETE FROM cache_entries WHERE cache_key = ?1')
      .bind(key)
      .run();
  }
}
