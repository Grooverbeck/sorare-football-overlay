import { MetricSchema, type PlayerStats } from '@sorare-overlay/shared';
import * as z from 'zod';
import type { AppLogger } from '../logger.js';
import { mapSettledWithConcurrency } from './concurrency.js';

export interface AaMembership {
  id: string;
  slug: string;
  shortName: string;
}
export interface AaMemberships { club: AaMembership | null; national: AaMembership | null }
export interface AaContextSource {
  memberships(slugs: string[]): Promise<Map<string, AaMemberships>>;
  national(stats: PlayerStats, team: AaMembership): Promise<{
    aaL10: PlayerStats['aaL10'];
    aaL10TeamWinRate: NonNullable<PlayerStats['aaL10TeamWinRate']>;
  }>;
}
export interface AaContextStore {
  get<T>(key: string, type: 'json'): Promise<T | null>;
  getMany?<T>(keys: readonly string[], type: 'json'): Promise<Map<string, T>>;
  put(key: string, value: string, options?: { expirationTtl: number }): Promise<void>;
  putIfAbsent(key: string, value: string, options: { expirationTtl: number }): Promise<boolean>;
}

const RecordSchema = z.object({
  kind: z.enum(['club', 'national']),
  teamSlug: z.string(), teamName: z.string(),
  checkedAt: z.number(), fixtureDate: z.string(),
  aaL10: MetricSchema.optional(), aaL10TeamWinRate: MetricSchema.optional(),
});
type AaRecord = z.infer<typeof RecordSchema>;
const REFRESH_MS = 24 * 60 * 60 * 1_000;
export const AA_CONTEXT_RETENTION_SECONDS = 7 * 24 * 60 * 60;

// Separate, additive storage: this service never writes to the weekly club
// form cache. Only complete successful national queries replace a snapshot.
export class AaContextService {
  constructor(
    private readonly store: AaContextStore,
    private readonly source: AaContextSource,
    private readonly excludeLowCoverage: boolean,
    private readonly schedule?: (task: Promise<void>) => void,
    private readonly logger?: Pick<AppLogger, 'warn'>,
    private readonly now: () => number = Date.now,
  ) {}

  private key(stats: PlayerStats): string {
    return `player-aa-team:v1:${stats.slug}:${stats.position}:${this.excludeLowCoverage ? 'no-low' : 'all'}:${stats.nextGame!.playerTeamSlug}`;
  }

  async decorate(players: PlayerStats[]): Promise<PlayerStats[]> {
    const targets = new Map(players.filter(p => p.nextGame?.playerTeamSlug).map(p => [this.key(p), p]));
    const records = new Map<string, AaRecord>();
    try {
      const keys = [...targets.keys()];
      const raw = this.store.getMany
        ? await this.store.getMany<unknown>(keys, 'json')
        : new Map(await Promise.all(keys.map(async key => [key, await this.store.get(key, 'json')] as const)));
      for (const [key, value] of raw) {
        const parsed = RecordSchema.safeParse(value);
        if (parsed.success && parsed.data.teamSlug === targets.get(key)?.nextGame?.playerTeamSlug &&
          (parsed.data.kind === 'club' || (parsed.data.aaL10 && parsed.data.aaL10TeamWinRate))) records.set(key, parsed.data);
      }
    } catch {
      // Preserve existing club values while signalling that context is pending.
      return players.map(p => this.project(p, undefined));
    }
    const due = [...targets].filter(([key, p]) => {
      const record = records.get(key);
      return !record || this.now() - record.checkedAt >= REFRESH_MS ||
        (record.kind === 'national' && record.fixtureDate !== p.nextGame!.date);
    }).slice(0, 8);
    if (due.length) {
      const work = this.refresh(due, records).catch(() => {
        this.logger?.warn({event: 'aa_context_refresh_failed'}, 'Keeping existing AA history after a context refresh failure');
      });
      if (this.schedule) {
        this.schedule(work);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([work, new Promise<void>(resolve => { timer = setTimeout(resolve, 250); })]); }
        finally { if (timer !== undefined) clearTimeout(timer); }
      } else await work;
    }
    return players.map(p => this.project(p, p.nextGame?.playerTeamSlug ? records.get(this.key(p)) : undefined));
  }

  private async refresh(targets: Array<[string, PlayerStats]>, records: Map<string, AaRecord>): Promise<void> {
    const claims = await Promise.all(targets.map(async ([key, stats]) =>
      await this.store.putIfAbsent(`${key}:lease`, '{}', {expirationTtl: 60}) ? {key, stats} : null));
    const claimed = claims.filter(p => p !== null);
    if (!claimed.length) return;
    const identities = await this.source.memberships([...new Set(claimed.map(p => p.stats.slug))]);
    const settled = await mapSettledWithConcurrency(claimed, 4, async ({key, stats}) => {
      const teams = identities.get(stats.slug);
      const slug = stats.nextGame!.playerTeamSlug;
      const kind = teams?.national?.slug === slug ? 'national' : teams?.club?.slug === slug ? 'club' : null;
      if (!kind || !teams) throw new Error('Unconfirmed AA team');
      const team = teams[kind]!;
      const metrics: Partial<Awaited<ReturnType<AaContextSource['national']>>> =
        kind === 'national' ? await this.source.national(stats, team) : {};
      const previous = records.get(key);
      if (kind === 'national' && metrics.aaL10?.value === null &&
        previous?.aaL10 && previous.aaL10.sampleSize > 0) {
        throw new Error('Empty history must not erase a previously confirmed national AA');
      }
      const record: AaRecord = {
        kind, teamSlug: team.slug, teamName: team.shortName,
        checkedAt: this.now(), fixtureDate: stats.nextGame!.date, ...metrics,
      };
      // Retain the last successful value through transient refresh failures,
      // then expire it at most seven days after the last successful check.
      await this.store.put(key, JSON.stringify(record), {
        expirationTtl: AA_CONTEXT_RETENTION_SECONDS,
      });
      records.set(key, record);
    });
    if (settled.some(r => r.status === 'rejected')) throw new Error('AA context refresh incomplete');
  }

  private project(stats: PlayerStats, record: AaRecord | undefined): PlayerStats {
    const club = stats.aaClub ?? {aaL10: stats.aaL10, ...(stats.aaL10TeamWinRate ? {aaL10TeamWinRate: stats.aaL10TeamWinRate} : {})};
    const pending = new Set(stats.pendingRefreshes ?? []);
    pending.delete('aaContext');
    const loading = !record && Boolean(stats.nextGame?.playerTeamSlug || stats.pendingRefreshes?.includes('fixture'));
    if (loading) pending.add('aaContext');
    return {
      ...stats,
      aaClub: club,
      aaL10: record?.kind === 'national' ? record.aaL10! : club.aaL10,
      aaL10TeamWinRate: record?.kind === 'national' ? record.aaL10TeamWinRate! : club.aaL10TeamWinRate,
      aaContext: record
        ? {kind: record.kind, teamSlug: record.teamSlug, teamName: record.teamName, state: 'ready'}
        : {kind: 'club', state: loading ? 'loading' : 'ready'},
      pendingRefreshes: pending.size ? [...pending] : undefined,
    };
  }
}

export class InMemoryAaContextStore implements AaContextStore {
  private readonly values = new Map<string, {value: string; expires: number}>();
  constructor(private readonly now: () => number = Date.now) {}
  async get<T>(key: string): Promise<T | null> {
    const entry = this.values.get(key);
    return entry && entry.expires > this.now() ? JSON.parse(entry.value) as T : null;
  }
  async put(key: string, value: string, options?: {expirationTtl: number}): Promise<void> {
    this.values.set(key, {value, expires: options ? this.now() + options.expirationTtl * 1_000 : Infinity});
  }
  async putIfAbsent(key: string, value: string, options: {expirationTtl: number}): Promise<boolean> {
    if (await this.get(key)) return false;
    await this.put(key, value, options);
    return true;
  }
}
