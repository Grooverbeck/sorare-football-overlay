import { PlayerStatsRequestSchema, type PlayerStats } from '@sorare-overlay/shared';
import { expect, it, vi } from 'vitest';
import { TtlCache, SplitPlayerStatsCache, type Cache, type PlayerFormStats, type PlayerFixtureStats } from '../cache.js';
import { MockDataSource } from '../mock/mock-data-source.js';
import { HistoricalGoalscorerProvider } from '../providers/goalscorer-provider.js';
import { UnavailablePlayerMarketOddsProvider } from '../providers/market-odds-provider.js';
import { StatsService } from '../services/stats-service.js';
import type { PlayerLoadLeases } from '../services/player-load-leases.js';

function leases(): PlayerLoadLeases {
  const owners = new Map<string,string>();
  return {
    async claim(key, owner) { if (owners.has(key)) return false; owners.set(key,owner); return true; },
    async release(key,owner) { if (owners.get(key) === owner) owners.delete(key); },
  };
}
const request = (slugs: string[]) => PlayerStatsRequestSchema.parse({slugs});
function service(source: MockDataSource, cache: Cache<PlayerStats>, claims?: PlayerLoadLeases, background?: (p:Promise<void>) => void) {
  return new StatsService(source,new HistoricalGoalscorerProvider(),cache,true,
    new UnavailablePlayerMarketOddsProvider(),background,650,undefined,50,25,claims);
}

it('returns a warm player at the deadline and defers only the blocked cold player', async () => {
  const source = new MockDataSource();
  const cache = new TtlCache<PlayerStats>(60_000);
  await service(source,cache).getPlayerStats(request(['warm']));
  let finish!: () => void;
  const gate = new Promise<void>(resolve => {finish = resolve;});
  const fetch = source.fetchPlayers.bind(source);
  vi.spyOn(source,'fetchPlayers').mockImplementation(async requests => {await gate; return fetch(requests);});
  const background: Promise<void>[] = [];
  const result = await service(source,cache,undefined,p => background.push(p)).getPlayerStats(request(['warm','cold']));
  expect(result.data.map(p => p.slug)).toEqual(['warm']);
  expect(result.cacheHits).toBe(1);
  expect(result.deferredPlayerSlugs).toEqual(['cold']);
  expect(result.diagnostics.responseBudgetExceeded).toBe(true);
  finish();
  await Promise.all(background);
});

it('deduplicates cold loads across services and lets followers read the completed cache', async () => {
  const source = new MockDataSource();
  const cache = new TtlCache<PlayerStats>(60_000);
  const claims = leases();
  let finish!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => {started = resolve;});
  const gate = new Promise<void>(resolve => {finish = resolve;});
  const fetch = source.fetchPlayers.bind(source);
  const spy = vi.spyOn(source,'fetchPlayers').mockImplementation(async requests => {started(); await gate; return fetch(requests);});
  const first = service(source,cache,claims).getPlayerStats(request(['cold']));
  await entered;
  const follower = service(source,cache,claims);
  const waiting = await follower.getPlayerStats(request(['cold']));
  expect(waiting.deferredPlayerSlugs).toEqual(['cold']);
  expect(spy).toHaveBeenCalledTimes(1);
  finish();
  await first;
  expect((await follower.getPlayerStats(request(['cold']))).data).toHaveLength(1);
  expect(spy).toHaveBeenCalledTimes(1);
});

it('releases a failed cold load so a later request can retry', async () => {
  const source = new MockDataSource();
  const cache = new TtlCache<PlayerStats>(60_000);
  const claims = leases();
  vi.spyOn(source,'fetchPlayers').mockRejectedValueOnce(new Error('temporary'));
  await expect(service(source,cache,claims).getPlayerStats(request(['cold']))).rejects.toThrow('temporary');
  expect((await service(source,cache,claims).getPlayerStats(request(['cold']))).data).toHaveLength(1);
});

it('preserves resolved name hits and defers only the missing name at the deadline', async () => {
  const source = new MockDataSource();
  const cache = new TtlCache<PlayerStats>(60_000);
  await service(source,cache).getPlayerStats(request(['warm-name']));
  let finish!: () => void;
  const gate = new Promise<void>(resolve => {finish = resolve;});
  const fetch = source.fetchPlayers.bind(source);
  vi.spyOn(source,'fetchPlayers').mockImplementation(async targets => {await gate; return fetch(targets);});
  const background: Promise<void>[] = [];
  const result = await service(source,cache,undefined,p => background.push(p)).getPlayerStats(
    PlayerStatsRequestSchema.parse({playerNames:['Warm Name','Cold Name']}));
  expect(result.data.map(p => p.slug)).toEqual(['warm-name']);
  expect(result.deferredPlayerNames).toEqual(['Cold Name']);
  expect(result.deferredPlayerSlugs).toEqual([]);
  finish();
  await Promise.all(background);
});

it('preserves deferral metadata for two requests sharing one service', async () => {
  const source = new MockDataSource();
  const cache = new TtlCache<PlayerStats>(60_000);
  const claims: PlayerLoadLeases = {claim: async () => false, release: async () => {}};
  const fetch = vi.spyOn(source,'fetchPlayers');
  const shared = service(source,cache,claims);
  const results = await Promise.all([shared.getPlayerStats(request(['cold'])),shared.getPlayerStats(request(['cold']))]);
  for (const result of results) expect(result.deferredPlayerSlugs).toEqual(['cold']);
  expect(fetch).not.toHaveBeenCalled();
});

it('does not start Sorare work when atomic admission fails', async () => {
  const source = new MockDataSource();
  const fetch = vi.spyOn(source,'fetchPlayers');
  const claims: PlayerLoadLeases = {claim: async () => {throw new Error('D1 down');},release:async () => {}};
  await expect(service(source,new TtlCache<PlayerStats>(60_000),claims).getPlayerStats(request(['cold']))).rejects.toThrow('D1 down');
  expect(fetch).not.toHaveBeenCalled();
});

it('defers every original name alias for one claimed player', async () => {
  const source = new MockDataSource();
  const claims: PlayerLoadLeases = {claim:async () => false,release:async () => {}};
  const result = await service(source,new TtlCache<PlayerStats>(60_000),claims).getPlayerStats(
    PlayerStatsRequestSchema.parse({playerNames:['Álex Smith','Alex Smith']}));
  expect(result.deferredPlayerNames).toEqual(['Álex Smith','Alex Smith']);
});

it('allows partial-history recovery after the first completion fails', async () => {
  const source = new MockDataSource();
  const fetch = source.fetchPlayers.bind(source);
  const extended = Object.assign(source, {
    fetchPlayersBase: vi.fn(async (requests: Parameters<typeof fetch>[0]) =>
      (await fetch(requests)).map(player => ({...player,historyStatus:'partial' as const}))),
  });
  vi.spyOn(source,'fetchPlayers').mockRejectedValueOnce(new Error('history failed'));
  const cache = new SplitPlayerStatsCache(new TtlCache<PlayerFormStats>(60_000),new TtlCache<PlayerFixtureStats>(60_000));
  const claims = leases();
  const tasks: Promise<void>[] = [];
  const req = PlayerStatsRequestSchema.parse({slugs:['partial'],supportsPartialFormHistory:true});
  await service(extended,cache,claims,p => tasks.push(p.catch(() => {}))).getPlayerStats(req);
  await Promise.all(tasks);
  const next = await service(extended,cache,claims,p => tasks.push(p.catch(() => {}))).getPlayerStats(req);
  expect(next.data).toHaveLength(1);
  expect(next.deferredPlayerSlugs).toEqual([]);
  expect(extended.fetchPlayersBase).toHaveBeenCalledTimes(2);
  await Promise.all(tasks);
});

it('returns the corrected identity if the deadline expires during odds enrichment', async () => {
  const source = new MockDataSource();
  const cache = new TtlCache<PlayerStats>(60_000);
  const old = (await service(source,cache).getPlayerStats(request(['wrong']))).data[0]!;
  cache.set('wrong:auto-v3:no-low', {...old,nextGame:null,aaL10:{value:null,sampleSize:0},goalL10:{value:null,sampleSize:0},cleanSheetL10:{value:null,sampleSize:0}});
  vi.spyOn(source,'resolvePlayerNames').mockImplementation(async (names, _positions, ...rest: unknown[]) => {
    const options = rest[0] as {forceSearch?:boolean} | undefined;
    return names.map(name => ({slug:options?.forceSearch?'right':'wrong',resolvedFromName:name,nameResolution:options?.forceSearch?'search' as const:'direct' as const}));
  });
  const odds = new UnavailablePlayerMarketOddsProvider();
  let finish!: () => void;
  const gate = new Promise<void>(resolve => {finish = resolve;});
  vi.spyOn(odds,'load').mockImplementation(async () => {await gate; return new Map();});
  const tasks: Promise<void>[] = [];
  const s = new StatsService(source,new HistoricalGoalscorerProvider(),cache,true,odds,p => tasks.push(p),650,undefined,200,25,leases());
  const result = await s.getPlayerStats(PlayerStatsRequestSchema.parse({playerNames:['Alex Smith']}));
  expect(result.data.map(player => player.slug)).toEqual(['right']);
  expect(result.deferredPlayerNames).toEqual([]);
  finish();
  await Promise.all(tasks);
});
