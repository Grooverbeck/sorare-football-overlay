import type { PlayerMarketOdds, PlayerStats } from '@sorare-overlay/shared';
import {
  playerMarketFieldDrivesRequest,
  playerMarketFieldSupported,
  playerMarketOddsKey,
  playerMarketOddsSupported,
  type PlayerMarketField,
  type PlayerMarketOddsLoadOptions,
  type PlayerMarketOddsProvider,
} from './market-odds-provider.js';
import type {
  FixtureMatchOddsProvider,
  FixtureOdds,
} from './match-odds-provider.js';
import type { ProviderQuotaUsage } from './odds-usage.js';

export function createCompetitionRouteIndex(
  competitionGroups: readonly (readonly string[])[],
): ReadonlyMap<string, number> {
  const index = new Map<string, number>();
  competitionGroups.forEach((competitionSlugs, providerIndex) => {
    for (const competitionSlug of competitionSlugs) {
      const normalized = competitionSlug.trim().toLocaleLowerCase();
      if (!normalized) continue;
      if (index.has(normalized)) {
        throw new Error(`Duplicate competition provider route: ${normalized}`);
      }
      index.set(normalized, providerIndex);
    }
  });
  return index;
}

function configuredProvider<T>(
  player: PlayerStats,
  providers: readonly T[],
  routeIndex: ReadonlyMap<string, number>,
  supports: (provider: T, player: PlayerStats) => boolean,
): { index: number; provider: T } | undefined {
  const competitionSlug = player.nextGame?.competitionSlug;
  if (competitionSlug === undefined) {
    // Legacy fixture snapshots predate the competition slug. Preserve their
    // deliberately narrow provider-level fallback (currently known MLS teams)
    // without making every normal request scan the provider list.
    const index = providers.findIndex((provider) => supports(provider, player));
    const provider = providers[index];
    return index >= 0 && provider ? { index, provider } : undefined;
  }
  if (competitionSlug === null) return undefined;
  const index = routeIndex.get(competitionSlug.trim().toLocaleLowerCase());
  if (index === undefined) return undefined;
  const provider = providers[index];
  return provider && supports(provider, player)
    ? { index, provider }
    : undefined;
}

/**
 * Directly dispatches mutually exclusive competition routes. This replaces a
 * deep fallback chain whose every layer repeatedly filtered the complete card
 * batch even though only one provider can own a competition.
 */
export class CompetitionRoutedPlayerMarketOddsProvider
  implements PlayerMarketOddsProvider
{
  readonly reportsRefreshDue: boolean;

  constructor(
    private readonly providers: readonly PlayerMarketOddsProvider[],
    private readonly routeIndex: ReadonlyMap<string, number>,
  ) {
    this.reportsRefreshDue = providers.every(
      (provider) => provider.reportsRefreshDue === true,
    );
  }

  private configuredProvider(player: PlayerStats) {
    return configuredProvider(
      player,
      this.providers,
      this.routeIndex,
      (provider, candidate) => playerMarketOddsSupported(provider, candidate),
    );
  }

  supports(player: PlayerStats): boolean {
    return this.configuredProvider(player) !== undefined;
  }

  supportsMarket(player: PlayerStats, market: PlayerMarketField): boolean {
    const configured = this.configuredProvider(player);
    return configured
      ? playerMarketFieldSupported(configured.provider, player, market)
      : false;
  }

  drivesMarketRequest(
    player: PlayerStats,
    market: PlayerMarketField,
  ): boolean {
    const configured = this.configuredProvider(player);
    return configured
      ? playerMarketFieldDrivesRequest(configured.provider, player, market)
      : false;
  }

  async load(
    players: readonly PlayerStats[],
    options?: PlayerMarketOddsLoadOptions,
  ): Promise<Map<string, PlayerMarketOdds | null>> {
    const groups = new Map<number, PlayerStats[]>();
    for (const player of players) {
      const configured = this.configuredProvider(player);
      if (!configured) continue;
      const group = groups.get(configured.index) ?? [];
      group.push(player);
      groups.set(configured.index, group);
    }
    const output = new Map<string, PlayerMarketOdds | null>(
      players.map((player) => [playerMarketOddsKey(player), null] as const),
    );
    const loadGroup = async ([providerIndex, group]: readonly [
      number,
      PlayerStats[],
    ]) => {
      const provider = this.providers[providerIndex]!;
      const refreshDuePlayerKeys = new Set<string>();
      const refreshDueState = { complete: false };
      try {
        const values = await provider.load(group, {
          ...options,
          ...(options?.refreshDuePlayerKeys
            ? { refreshDuePlayerKeys }
            : {}),
          ...(options?.refreshDueState ? { refreshDueState } : {}),
        });
        return {
          values,
          refreshDuePlayerKeys,
          fulfilled: true,
          complete: options?.cacheOnly ? refreshDueState.complete : true,
        };
      } catch {
        return {
          values: new Map<string, PlayerMarketOdds | null>(),
          refreshDuePlayerKeys,
          fulfilled: false,
          complete: false,
        };
      }
    };
    const groupedEntries = [...groups].sort(
      ([left], [right]) => left - right,
    );
    // Snapshot reads stay parallel. Normal loads preserve the old provider
    // order so paid APIs do not suddenly receive a burst of concurrent league
    // requests merely because the dispatch implementation became flatter.
    const results = options?.cacheOnly
      ? await Promise.all(groupedEntries.map(loadGroup))
      : await (async () => {
          const loaded: Awaited<ReturnType<typeof loadGroup>>[] = [];
          for (const entry of groupedEntries) loaded.push(await loadGroup(entry));
          return loaded;
        })();
    for (const result of results) {
      for (const [key, value] of result.values) output.set(key, value);
      if (options?.refreshDuePlayerKeys && result.fulfilled) {
        for (const key of result.refreshDuePlayerKeys) {
          options.refreshDuePlayerKeys.add(key);
        }
      }
    }
    if (options?.refreshDueState) {
      options.refreshDueState.complete = results.every(
        (result) => result.complete,
      );
    }
    return output;
  }

  async refreshCachedPrices(players: readonly PlayerStats[]): Promise<void> {
    const groups = new Map<number, PlayerStats[]>();
    for (const player of players) {
      const configured = this.configuredProvider(player);
      if (!configured?.provider.refreshCachedPrices) continue;
      const group = groups.get(configured.index) ?? [];
      group.push(player);
      groups.set(configured.index, group);
    }
    await Promise.allSettled(
      [...groups].map(([index, group]) =>
        this.providers[index]!.refreshCachedPrices!(group),
      ),
    );
  }

  async refreshUsage(): Promise<ProviderQuotaUsage[]> {
    const results = await Promise.allSettled(
      this.providers.map(
        (provider) => provider.refreshUsage?.() ?? Promise.resolve([]),
      ),
    );
    return results.flatMap((result) =>
      result.status === 'fulfilled' ? result.value : [],
    );
  }
}

export class CompetitionRoutedFixtureMatchOddsProvider
  implements FixtureMatchOddsProvider
{
  constructor(
    private readonly providers: readonly FixtureMatchOddsProvider[],
    private readonly routeIndex: ReadonlyMap<string, number>,
  ) {}

  private configuredProvider(player: PlayerStats) {
    return configuredProvider(
      player,
      this.providers,
      this.routeIndex,
      (provider, candidate) => provider.supports(candidate),
    );
  }

  supports(player: PlayerStats): boolean {
    return this.configuredProvider(player) !== undefined;
  }

  async load(
    players: readonly PlayerStats[],
    options?: { cacheOnly?: boolean },
  ): Promise<Map<string, FixtureOdds | null>> {
    const groups = new Map<number, PlayerStats[]>();
    for (const player of players) {
      const configured = this.configuredProvider(player);
      if (!configured) continue;
      const group = groups.get(configured.index) ?? [];
      group.push(player);
      groups.set(configured.index, group);
    }
    const output = new Map<string, FixtureOdds | null>(
      players.map((player) => [playerMarketOddsKey(player), null] as const),
    );
    const groupedEntries = [...groups].sort(
      ([left], [right]) => left - right,
    );
    const loadGroup = async ([index, group]: readonly [number, PlayerStats[]]) =>
      this.providers[index]!.load(group, options);
    const results = options?.cacheOnly
      ? await Promise.allSettled(groupedEntries.map(loadGroup))
      : await (async () => {
          const loaded: PromiseSettledResult<
            Map<string, FixtureOdds | null>
          >[] = [];
          for (const entry of groupedEntries) {
            try {
              loaded.push({ status: 'fulfilled', value: await loadGroup(entry) });
            } catch (reason) {
              loaded.push({ status: 'rejected', reason });
            }
          }
          return loaded;
        })();
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      for (const [key, value] of result.value) output.set(key, value);
    }
    return output;
  }
}
