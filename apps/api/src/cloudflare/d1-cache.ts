import type { JsonKeyValueStore } from './cache.js';
import type { AppLogger } from '../logger.js';

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
    private readonly logger?: Pick<AppLogger, 'warn' | 'error'>,
  ) {}

  async get<T = unknown>(key: string, type: 'json'): Promise<T | null> {
    let row: D1CacheRow | null;
    try {
      row = await this.database
        .prepare(
          `SELECT value
           FROM cache_entries
           WHERE cache_key = ?1
             AND (expires_at IS NULL OR expires_at > ?2)`,
        )
        .bind(key, this.nowSeconds())
        .first<D1CacheRow>();
    } catch (d1Error) {
      if (!this.fallback) {
        this.logger?.error(
          { cacheKey: key, d1Error },
          'D1 cache read failed and no fallback is configured',
        );
        throw d1Error;
      }
      this.logger?.warn(
        { cacheKey: key, error: d1Error, fallback: 'kv' },
        'D1 cache read failed; attempting KV fallback',
      );
      try {
        return await this.fallback.get<T>(key, type);
      } catch (fallbackError) {
        this.logger?.error(
          { cacheKey: key, d1Error, fallbackError },
          'D1 and KV cache reads failed',
        );
        throw fallbackError;
      }
    }

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

  /**
   * Atomically acquires a short-lived lease. An expired row may be replaced,
   * while an active row is left untouched.
   */
  async putIfAbsent(
    key: string,
    value: string,
    options: CacheWriteOptions = {},
  ): Promise<boolean> {
    const now = this.nowSeconds();
    const expiresAt =
      options.expiration ??
      (options.expirationTtl === undefined
        ? null
        : now + options.expirationTtl);
    const result = await this.database
      .prepare(
        `INSERT INTO cache_entries (cache_key, value, expires_at, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(cache_key) DO UPDATE SET
           value = excluded.value,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at
         WHERE cache_entries.expires_at IS NOT NULL
           AND cache_entries.expires_at <= ?4`,
      )
      .bind(key, value, expiresAt, now)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /**
   * Atomically keeps the fixture with the earlier kickoff. This is used by
   * the team fixture cache so concurrent Worker isolates cannot overwrite a
   * held match with the following fixture.
   */
  async putEarlierFixture(
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
           updated_at = excluded.updated_at
         WHERE cache_entries.expires_at IS NOT NULL
               AND cache_entries.expires_at <= ?4
            OR json_extract(cache_entries.value, '$.nextGame.date') IS NULL
            OR json_extract(excluded.value, '$.nextGame.date')
               < json_extract(cache_entries.value, '$.nextGame.date')`,
      )
      .bind(key, value, expiresAt, now)
      .run();
  }

  /**
   * Atomically merges players into a short-lived market supplement batch.
   * A single D1 statement avoids the read/merge/write race between isolates.
   */
  async mergeMarketSupplementBatch(
    key: string,
    playersJson: string,
    queuedAt: string,
    readyAt: string,
    expirationTtl: number,
  ): Promise<string> {
    const now = this.nowSeconds();
    const expiresAt = now + Math.max(1, expirationTtl);
    await this.database
      .prepare(
        `WITH active_existing AS (
           SELECT value
           FROM cache_entries
           WHERE cache_key = ?1
             AND (expires_at IS NULL OR expires_at > ?5)
         ),
         combined AS (
           SELECT existing_player.value AS player_json, 0 AS source
           FROM active_existing,
                json_each(active_existing.value, '$.players') AS existing_player
           UNION ALL
           SELECT incoming_player.value AS player_json, 1 AS source
           FROM json_each(?2) AS incoming_player
         ),
         ranked AS (
           SELECT player_json,
                  ROW_NUMBER() OVER (
                    PARTITION BY json_extract(player_json, '$.slug'),
                                 json_extract(player_json, '$.position')
                    ORDER BY source
                  ) AS player_rank
           FROM combined
         ),
         payload AS (
           SELECT json_object(
             'queuedAt', COALESCE(
               (SELECT json_extract(value, '$.queuedAt') FROM active_existing),
               ?3
             ),
             'readyAt', COALESCE(
               (SELECT json_extract(value, '$.readyAt') FROM active_existing),
               ?4
             ),
             'players', json(COALESCE(
               (SELECT json_group_array(json(player_json))
                FROM ranked
                WHERE player_rank = 1),
               '[]'
             ))
           ) AS value
         )
         INSERT INTO cache_entries (cache_key, value, expires_at, updated_at)
         SELECT ?1, value, ?6, ?5 FROM payload WHERE true
         ON CONFLICT(cache_key) DO UPDATE SET
           value = excluded.value,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`,
      )
      .bind(key, playersJson, queuedAt, readyAt, now, expiresAt)
      .run();

    const row = await this.database
      .prepare('SELECT value FROM cache_entries WHERE cache_key = ?1')
      .bind(key)
      .first<D1CacheRow>();
    if (!row) {
      throw new Error('D1 market supplement batch merge produced no row');
    }
    return row.value;
  }

  async delete(key: string): Promise<void> {
    await this.database
      .prepare('DELETE FROM cache_entries WHERE cache_key = ?1')
      .bind(key)
      .run();
  }

}
