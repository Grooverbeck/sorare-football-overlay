import {describe, expect, it, vi} from 'vitest';
import {PlayerStatsRequestSchema, type PlayerStats} from '@sorare-overlay/shared';
import {SorareDataSource} from '../graphql/sorare-data-source.js';
import type {SorareGraphqlClient} from '../graphql/client.js';
import {StatsService} from '../services/stats-service.js';
import {TtlCache} from '../cache.js';
import {HistoricalGoalscorerProvider} from '../providers/goalscorer-provider.js';
import {UnavailablePlayerMarketOddsProvider} from '../providers/market-odds-provider.js';
import type {PlayerNameResolutionCache, PlayerStatsDataSource, SourcePlayerRequest} from '../services/data-source.js';

describe('unconfirmed namesake resolution', () => {
  it('repairs a persistent clubless direct mapping through Sorare search and reuses the correction', async () => {
    let stored: SourcePlayerRequest = {slug: 'bruno-fernandes', position: 'Midfielder', nameResolution: 'direct'};
    const cache: PlayerNameResolutionCache = {
      get: vi.fn(async () => stored),
      set: vi.fn(async (_name, _position, value) => {if (value) stored = value;}),
    };
    const wrong = {slug: 'bruno-fernandes', displayName: 'Bruno Fernandes', position: 'Midfielder', activeClub: null};
    const right = {...wrong, slug: 'bruno-miguel-borges-fernandes', activeClub: {slug: 'manchester-united-manchester'}};
    const request = vi.fn(async (_query: string, variables: {slugs?: string[]; query?: string}) => variables.slugs
      ? {players: [wrong]} : {searchPlayers: {hits: [{player: right}]}, searchCards: {hits: [{card: {anyPlayer: right}}]}});
    const source = new SorareDataSource({request} as unknown as SorareGraphqlClient, 25, false, 60_000, true, cache);
    const positions = {'Bruno Fernandes': 'Midfielder'} as const;
    expect(await source.resolvePlayerNames(['Bruno Fernandes'], positions, {cacheOnly: true})).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    expect(await source.resolvePlayerNames(['Bruno Fernandes'], positions)).toEqual([{
      slug: right.slug, position: 'Midfielder', teamSlug: 'manchester-united-manchester',
      resolvedFromName: 'Bruno Fernandes', nameResolution: 'search',
    }]);
    expect(cache.set).toHaveBeenCalledTimes(1);
    expect(stored.slug).toBe(right.slug);
    const nextRequest = vi.fn();
    const next = new SorareDataSource({request: nextRequest} as unknown as SorareGraphqlClient, 25, false, 60_000, true, cache);
    expect((await next.resolvePlayerNames(['Bruno Fernandes'], positions, {cacheOnly: true}))[0]?.slug).toBe(right.slug);
    expect(nextRequest).not.toHaveBeenCalled();
  });

  it('still accepts a genuinely clubless player when the search confirms that identity', async () => {
    const player = {slug: 'free-player', displayName: 'Free Player', position: 'Midfielder', activeClub: null};
    const request = vi.fn(async (_query: string, variables: {slugs?: string[]; query?: string}) => variables.slugs
      ? {players: [player]} : {searchPlayers: {hits: [{player}]}, searchCards: {hits: []}});
    const source = new SorareDataSource({request} as unknown as SorareGraphqlClient, 25);
    const result = await source.resolvePlayerNames(['Free Player']);
    expect(result).toEqual([{slug: 'free-player', resolvedFromName: 'Free Player', nameResolution: 'search'}]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(await source.resolvePlayerNames(['Free Player'])).toEqual(result);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not publish the unconfirmed guess when the search fails', async () => {
    const cache: PlayerNameResolutionCache = {get: async () => undefined, set: vi.fn()};
    const request = vi.fn(async (_query: string, variables: {slugs?: string[]}) => {
      if (variables.slugs) return {players: [{slug: 'old-player', displayName: 'Old Player', position: 'Midfielder', activeClub: null}]};
      throw new Error('Search temporarily unavailable');
    });
    const source = new SorareDataSource({request} as unknown as SorareGraphqlClient, 25, false, 60_000, true, cache);
    expect(await source.resolvePlayerNames(['Old Player'])).toEqual([]);
    expect(cache.set).not.toHaveBeenCalled();
  });
});

const sparse: PlayerStats = {
  slug: 'old-player', displayName: 'Same Name', position: 'Midfielder', excludedLowCoverage: 0,
  aaL10: {value: null, sampleSize: 0}, cleanSheetL10: {value: null, sampleSize: 0},
  goalL10: {value: 0, sampleSize: 3}, nextGame: null,
};

describe('legacy namesake recovery with existing history', () => {
  it('revalidates a legacy name mapping even with three old appearances', async () => {
    const cache = new TtlCache<PlayerStats>(60_000);
    cache.set('old-player:Midfielder:no-low', sparse);
    const source: PlayerStatsDataSource = {
      source: 'sorare',
      resolvePlayerNames: vi.fn(async (names, positions, options) => names.map(name => ({
        slug: options?.forceSearch ? 'correct-player' : 'old-player', resolvedFromName: name,
        ...(positions?.[name] ? {position: positions[name]} : {}),
        ...(options?.forceSearch ? {teamSlug: 'confirmed-club', nameResolution: 'search' as const} : {}),
      }))),
      fetchPlayers: vi.fn(async requests => requests.map(request => ({slug: request.slug, displayName: 'Same Name',
        position: 'Midfielder', appearances: [{date: '2030-01-01T12:00:00Z', position: 'Midfielder', allAroundScore: 21.44,
          minsPlayed: 90, goals: 0, assists: 0, cleanSheet60: 0, lowCoverage: false}], nextGame: null}))),
      fetchNextGames: async () => [],
    };
    const service = new StatsService(source, new HistoricalGoalscorerProvider(), cache, true, new UnavailablePlayerMarketOddsProvider());
    const result = await service.getPlayerStats(PlayerStatsRequestSchema.parse({playerNames: ['Same Name'], positions: {'Same Name': 'Midfielder'}}));
    expect(result.data).toMatchObject([{slug: 'correct-player', aaL10: {value: 21.44, sampleSize: 1}}]);
    expect(source.resolvePlayerNames).toHaveBeenLastCalledWith(['Same Name'], {'Same Name': 'Midfielder'}, {forceSearch: true});
    expect(source.fetchPlayers).toHaveBeenCalledTimes(1);
  });

  it.each(['confirmed-club', 'searched', 'explicit-slug', 'partial-history'] as const)('keeps sparse data without revalidation for %s', kind => {
    const cache = new TtlCache<PlayerStats>(60_000);
    cache.set('old-player:Midfielder:no-low', {...sparse, ...(kind === 'partial-history' ? {pendingRefreshes: ['formHistory' as const]} : {})});
    const resolvePlayerNames: PlayerStatsDataSource['resolvePlayerNames'] = vi.fn(async names => names.map(name => ({
      slug: 'old-player', position: 'Midfielder', resolvedFromName: name,
      ...(kind === 'confirmed-club' ? {teamSlug: 'known-club', nameResolution: 'direct' as const} : {}),
      ...(kind === 'searched' ? {nameResolution: 'search' as const} : {}),
    })));
    const source: PlayerStatsDataSource = {source: 'sorare', resolvePlayerNames, fetchPlayers: vi.fn(async () => []), fetchNextGames: async () => []};
    const service = new StatsService(source, new HistoricalGoalscorerProvider(), cache, true, new UnavailablePlayerMarketOddsProvider());
    return service.getPlayerStats(PlayerStatsRequestSchema.parse(kind === 'explicit-slug'
      ? {slugs: ['old-player'], positions: {'old-player': 'Midfielder'}}
      : {playerNames: ['Same Name'], positions: {'Same Name': 'Midfielder'}})).then(result => {
      expect(result.data[0]?.slug).toBe('old-player');
      expect(vi.mocked(resolvePlayerNames).mock.calls.some(([, , options]) => options?.forceSearch)).toBe(false);
      expect(source.fetchPlayers).not.toHaveBeenCalled();
    });
  });
});
