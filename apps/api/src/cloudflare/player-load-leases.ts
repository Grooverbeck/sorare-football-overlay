import type { PlayerLoadLeases } from '../services/player-load-leases.js';

export class D1PlayerLoadLeases implements PlayerLoadLeases {
  constructor(private readonly db: D1Database, private readonly now = Date.now) {}

  async claim(key: string, owner: string): Promise<boolean> {
    const now = Math.floor(this.now() / 1000);
    const result = await this.db.prepare(`
      INSERT INTO cache_entries(cache_key,value,expires_at,updated_at)
      VALUES (?1,?2,?3,?4)
      ON CONFLICT(cache_key) DO UPDATE SET value=excluded.value,
        expires_at=excluded.expires_at,updated_at=excluded.updated_at
      WHERE cache_entries.expires_at <= ?4
    `).bind(`player-load:v1:${key}`, JSON.stringify(owner), now + 60, now).run();
    return (result.meta.changes ?? 0) > 0;
  }

  async release(key: string, owner: string): Promise<void> {
    await this.db.prepare('DELETE FROM cache_entries WHERE cache_key=?1 AND value=?2')
      .bind(`player-load:v1:${key}`, JSON.stringify(owner)).run();
  }
}
