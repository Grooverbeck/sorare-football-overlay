import type { ProviderQuotaUsage } from '../providers/odds-usage.js';

const key = 'odds-api-io-budget:v2';
const hour = 3_600_000;
interface Budget {
  dayUsed: number; dayEnd: number; dayLimit: number;
  hourUsed: number; hourEnd: number; hourLimit: number;
  checkedAt: number;
}

/** One row makes the two-window admission decision indivisible across Workers. */
export class D1OddsBudget {
  constructor(private readonly db: D1Database) {}

  async reserve(now: number, dayLimit: number, hourLimit: number): Promise<boolean> {
    const dayEnd = Math.floor(now / (24 * hour)) * 24 * hour + 24 * hour;
    // Seed from the previous telemetry only once, preserving usage at rollout.
    const seed = (provider: string, field: string, fallback: string) =>
      `COALESCE((SELECT json_extract(value, '$.${field}') FROM cache_entries
        WHERE cache_key = 'odds-provider-usage:v1:${provider}'
        AND julianday(json_extract(value, '$.interval.endsAt')) > julianday(?1 / 1000.0, 'unixepoch')), ${fallback})`;
    const oldHourEnd = `COALESCE((SELECT CAST((julianday(json_extract(value, '$.interval.endsAt')) - 2440587.5) * 86400000 AS INTEGER) FROM cache_entries WHERE cache_key = 'odds-provider-usage:v1:odds-api-io-hourly' AND julianday(json_extract(value, '$.interval.endsAt')) > julianday(?1 / 1000.0, 'unixepoch')), ?1 + 3600000)`;
    const d = "CASE WHEN json_extract(value,'$.dayEnd') > ?1 THEN json_extract(value,'$.dayUsed') ELSE 0 END";
    const h = "CASE WHEN json_extract(value,'$.hourEnd') > ?1 THEN json_extract(value,'$.hourUsed') ELSE 0 END";
    const effectiveLimit = "MIN(?5,COALESCE(json_extract(value,'$.providerLimit'),json_extract(value,'$.hourLimit'),?5))";
    const result = await this.db.prepare(`INSERT INTO cache_entries(cache_key,value,updated_at)
      SELECT ?2, json_object('dayUsed', ${seed('odds-api-io','used','0')} + 1,
        'dayEnd',?3,'dayLimit',?4,'hourUsed',${seed('odds-api-io-hourly','used','0')} + 1,
        'hourEnd',${oldHourEnd},'hourStart',?1,'headerAt',0,'providerLimit',${seed('odds-api-io-hourly','limit','?5')},'hourLimit',MIN(?5,${seed('odds-api-io-hourly','limit','?5')}),'checkedAt',?1), CAST(?1 / 1000 AS INTEGER)
      WHERE ${seed('odds-api-io','used','0')} < ?4 AND ${seed('odds-api-io-hourly','used','0')} < MIN(?5,${seed('odds-api-io-hourly','limit','?5')})
      ON CONFLICT(cache_key) DO UPDATE SET value=json_object(
        'dayUsed',(${d})+1,'dayEnd',?3,'dayLimit',?4,
        'hourUsed',(${h})+1,'hourEnd',CASE WHEN json_extract(value,'$.hourEnd') > ?1 THEN json_extract(value,'$.hourEnd') ELSE ?1+3600000 END,
        'hourStart',CASE WHEN json_extract(value,'$.hourEnd') > ?1 THEN json_extract(value,'$.hourStart') ELSE ?1 END,
        'headerAt',CASE WHEN json_extract(value,'$.hourEnd') > ?1 THEN json_extract(value,'$.headerAt') ELSE 0 END,
        'providerLimit',COALESCE(json_extract(value,'$.providerLimit'),json_extract(value,'$.hourLimit'),?5),
        'hourLimit',(${effectiveLimit}),'checkedAt',?1), updated_at=CAST(?1/1000 AS INTEGER)
      WHERE (${d}) < ?4 AND (${h}) < (${effectiveLimit})`).bind(now,key,dayEnd,dayLimit,hourLimit).run();
    return (result.meta.changes ?? 0) > 0;
  }

  async reconcile(now: number, used: number | null, reset: number | null, blocked: boolean, reservedAt = now, reportedLimit: number | null = null): Promise<void> {
    // The dispatch timestamp binds responses to their reserved window. Provider
    // reset times can replace our initial estimate, including an earlier reset.
    await this.db.prepare(`UPDATE cache_entries SET value=json_set(value,
      '$.hourUsed',MAX(json_extract(value,'$.hourUsed'),?2,CASE WHEN ?4 THEN COALESCE(?7,json_extract(value,'$.hourLimit')) ELSE 0 END),
      '$.hourLimit',CASE WHEN ?6 >= json_extract(value,'$.headerAt') THEN COALESCE(?7,json_extract(value,'$.hourLimit')) ELSE json_extract(value,'$.hourLimit') END,
      '$.providerLimit',CASE WHEN ?6 >= json_extract(value,'$.headerAt') THEN COALESCE(?7,json_extract(value,'$.providerLimit'),json_extract(value,'$.hourLimit')) ELSE COALESCE(json_extract(value,'$.providerLimit'),json_extract(value,'$.hourLimit')) END,
      '$.hourEnd',CASE WHEN ?3 > ?1 AND ?6 >= json_extract(value,'$.headerAt') THEN ?3 ELSE json_extract(value,'$.hourEnd') END,
      '$.headerAt',MAX(?6,json_extract(value,'$.headerAt')), '$.checkedAt',?1)
      WHERE cache_key=?5 AND json_extract(value,'$.hourEnd') > ?1
        AND ?6 >= json_extract(value,'$.hourStart') AND (?3 = 0 OR ?3 > ?1)`)
      .bind(now, used ?? 0, reset ?? 0, blocked ? 1 : 0, key, reservedAt, reportedLimit).run();
  }

  async get(provider: 'odds-api-io' | 'odds-api-io-hourly'): Promise<ProviderQuotaUsage | undefined> {
    const row = await this.db.prepare('SELECT value FROM cache_entries WHERE cache_key=?1').bind(key).first<{value:string}>();
    if (!row) return undefined;
    const b = JSON.parse(row.value) as Budget;
    const daily = provider === 'odds-api-io';
    const end = daily ? b.dayEnd : b.hourEnd;
    const limit = daily ? b.dayLimit : b.hourLimit;
    const used = daily ? b.dayUsed : b.hourUsed;
    return {provider,unit:'requests',used,limit,remaining:Math.max(0,limit-used),
      interval:{unit:daily?'day':'hour',startsAt:new Date(end-(daily?24:1)*hour).toISOString(),endsAt:new Date(end).toISOString()},
      checkedAt:new Date(b.checkedAt).toISOString()};
  }
}
