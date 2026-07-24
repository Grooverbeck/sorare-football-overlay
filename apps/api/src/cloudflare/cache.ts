import {
  FootballPositionSchema,
  PlayerStatsSchema,
  type FootballPosition,
  type PlayerStats,
} from '@sorare-overlay/shared';
import { z } from 'zod';
import {
  SplitPlayerStatsCache,
  type Cache,
  type PlayerFixtureStats,
  type PlayerFormStats,
  type ReadonlyCache,
} from '../cache.js';
import type {
  PlayerNameResolutionCache,
  SourcePlayerRequest,
} from '../services/data-source.js';

const SourcePlayerRequestSchema = z.object({
  slug: z.string().trim().min(1).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i),
  position: FootballPositionSchema.optional(),
});

const NameResolutionEnvelopeSchema = z.discriminatedUnion('found', [
  z.object({ found: z.literal(true), value: SourcePlayerRequestSchema }),
  z.object({ found: z.literal(false) }),
]);

const PlayerFormStatsSchema = PlayerStatsSchema.omit({ nextGame: true });
const PlayerFixtureEnvelopeSchema = z.object({
  nextGame: PlayerStatsSchema.shape.nextGame,
});

function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase();
}

abstract class CloudflareKvCache {
  constructor(
    protected readonly namespace: KVNamespace,
    protected readonly context: ExecutionContext,
  ) {}

  protected removeInvalid(key: string): void {
    this.context.waitUntil(this.namespace.delete(key));
  }

  protected persist(key: string, value: unknown, ttlSeconds: number): void {
    this.context.waitUntil(
      this.namespace.put(key, JSON.stringify(value), {
        expirationTtl: ttlSeconds,
      }),
    );
  }
}

class CloudflarePlayerFormCache
  extends CloudflareKvCache
  implements Cache<PlayerFormStats>
{
  constructor(
    namespace: KVNamespace,
    private readonly ttlSeconds: number,
    context: ExecutionContext,
  ) {
    super(namespace, context);
  }

  async get(key: string): Promise<PlayerFormStats | undefined> {
    const cacheKey = `player-form:v1:${key}`;
    const raw = await this.namespace.get<unknown>(cacheKey, 'json');
    if (raw === null) return undefined;
    const parsed = PlayerFormStatsSchema.safeParse(raw);
    if (!parsed.success) {
      this.removeInvalid(cacheKey);
      return undefined;
    }
    return parsed.data;
  }

  set(key: string, value: PlayerFormStats): void {
    this.persist(
      `player-form:v1:${key}`,
      PlayerFormStatsSchema.parse(value),
      this.ttlSeconds,
    );
  }
}

class CloudflarePlayerFixtureCache
  extends CloudflareKvCache
  implements Cache<PlayerFixtureStats>
{
  constructor(
    namespace: KVNamespace,
    private readonly ttlSeconds: number,
    context: ExecutionContext,
  ) {
    super(namespace, context);
  }

  async get(key: string): Promise<PlayerFixtureStats | undefined> {
    const cacheKey = `player-fixture:v1:${key}`;
    const raw = await this.namespace.get<unknown>(cacheKey, 'json');
    if (raw === null) return undefined;
    const parsed = PlayerFixtureEnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      this.removeInvalid(cacheKey);
      return undefined;
    }
    const fixture = parsed.data.nextGame;
    if (
      fixture &&
      (!Object.hasOwn(fixture, 'homeTeamName') ||
        !Object.hasOwn(fixture, 'awayTeamName') ||
        !Object.hasOwn(fixture, 'playerTeamName') ||
        !Object.hasOwn(fixture, 'opponentTeamName'))
    ) {
      // Lazily refresh older v1 fixtures only when that player is requested.
      // Keeping the key avoids a bulk migration and duplicate KV populations.
      return undefined;
    }
    return fixture;
  }

  set(key: string, value: PlayerFixtureStats): void {
    this.persist(
      `player-fixture:v1:${key}`,
      PlayerFixtureEnvelopeSchema.parse({ nextGame: value }),
      this.ttlSeconds,
    );
  }
}

class CloudflareLegacyPlayerStatsCache
  extends CloudflareKvCache
  implements ReadonlyCache<PlayerStats>
{
  async get(key: string): Promise<PlayerStats | undefined> {
    const cacheKey = `player-stats:v1:${key}`;
    const raw = await this.namespace.get<unknown>(cacheKey, 'json');
    if (raw === null) return undefined;
    const parsed = PlayerStatsSchema.safeParse(raw);
    if (!parsed.success) {
      this.removeInvalid(cacheKey);
      return undefined;
    }
    return parsed.data;
  }
}

export class CloudflarePlayerStatsCache implements Cache<PlayerStats> {
  private readonly splitCache: SplitPlayerStatsCache;

  constructor(
    namespace: KVNamespace,
    formTtlSeconds: number,
    fixtureTtlSeconds: number,
    context: ExecutionContext,
  ) {
    this.splitCache = new SplitPlayerStatsCache(
      new CloudflarePlayerFormCache(namespace, formTtlSeconds, context),
      new CloudflarePlayerFixtureCache(namespace, fixtureTtlSeconds, context),
      new CloudflareLegacyPlayerStatsCache(namespace, context),
    );
  }

  get(key: string): Promise<PlayerStats | undefined> {
    return this.splitCache.get(key);
  }

  set(key: string, value: PlayerStats): Promise<void> {
    return this.splitCache.set(key, value);
  }

  fillMissing(key: string, value: PlayerStats): Promise<PlayerStats> {
    return this.splitCache.fillMissing(key, value);
  }
}

export class CloudflareNameResolutionCache
  extends CloudflareKvCache
  implements PlayerNameResolutionCache
{
  constructor(
    namespace: KVNamespace,
    private readonly positiveTtlSeconds: number,
    private readonly negativeTtlSeconds: number,
    context: ExecutionContext,
  ) {
    super(namespace, context);
  }

  async get(
    name: string,
    position: FootballPosition | undefined,
  ): Promise<SourcePlayerRequest | null | undefined> {
    const cacheKey = this.key(name, position);
    const raw = await this.namespace.get<unknown>(cacheKey, 'json');
    if (raw === null) return undefined;
    const parsed = NameResolutionEnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      this.removeInvalid(cacheKey);
      return undefined;
    }
    if (!parsed.data.found) return null;
    return parsed.data.value.position
      ? { slug: parsed.data.value.slug, position: parsed.data.value.position }
      : { slug: parsed.data.value.slug };
  }

  set(
    name: string,
    position: FootballPosition | undefined,
    value: SourcePlayerRequest | null,
  ): void {
    const envelope = value
      ? { found: true as const, value: SourcePlayerRequestSchema.parse(value) }
      : { found: false as const };
    this.persist(
      this.key(name, position),
      envelope,
      value ? this.positiveTtlSeconds : this.negativeTtlSeconds,
    );
  }

  private key(name: string, position: FootballPosition | undefined): string {
    return `player-name:v2:${encodeURIComponent(normalizeName(name))}:${position ?? 'any'}`;
  }
}
