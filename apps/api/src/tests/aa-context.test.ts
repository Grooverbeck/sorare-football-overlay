import { PlayerStatsRequestSchema, lineupSortReadinessForPlayer, type PlayerStats } from '@sorare-overlay/shared';
import { describe, expect, it, vi } from 'vitest';
import { AaContextService, InMemoryAaContextStore, type AaContextSource } from '../services/aa-context.js';
import { SorareAaContextSource, NATIONAL_AA_QUERY } from '../graphql/aa-context-source.js';
import { SorareGraphqlClient } from '../graphql/client.js';
import { SplitPlayerStatsCache, TtlCache, type PlayerFormStats, type PlayerFixtureStats } from '../cache.js';
import { StatsService } from '../services/stats-service.js';
import { MockDataSource } from '../mock/mock-data-source.js';
import { HistoricalGoalscorerProvider } from '../providers/goalscorer-provider.js';
import { UnavailablePlayerMarketOddsProvider } from '../providers/market-odds-provider.js';

const club = {id: 'club-id', slug: 'club', shortName: 'Club'};
const national = {id: 'national-id', slug: 'austria', shortName: 'Austria'};
function player(teamSlug = national.slug): PlayerStats {
  return {slug: 'test-player', displayName: 'Test Player', position: 'Defender',
    aaL10: {value: 1.455, sampleSize: 4}, aaL10TeamWinRate: {value: .25, sampleSize: 4},
    cleanSheetL10: {value: .5, sampleSize: 10}, goalL10: {value: .1, sampleSize: 10}, excludedLowCoverage: 0,
    nextGame: {date: '2030-09-24T18:45:00Z', playerTeamSlug: teamSlug, cleanSheetProbability: .45, matchProbabilities: null}};
}
function source(): AaContextSource {
  return {memberships: vi.fn(async slugs => new Map(slugs.map(slug => [slug, {club, national}]))),
    national: vi.fn(async () => ({aaL10: {value: 17.332, sampleSize: 10}, aaL10TeamWinRate: {value: .5, sampleSize: 10}}))};
}

describe('independent club and national AA', () => {
  it('preserves club form and returns to it across club -> national -> club -> national', async () => {
    const store = new InMemoryAaContextStore(); const src = source();
    const service = new AaContextService(store, src, true);
    const before = player();
    const nationalStats = (await service.decorate([before]))[0]!;
    expect(nationalStats.aaL10.value).toBe(17.332);
    expect(nationalStats.aaL10TeamWinRate?.value).toBe(.5);
    expect(nationalStats.aaClub?.aaL10).toEqual(before.aaL10);
    expect(before.aaL10.value).toBe(1.455);
    expect((await service.decorate([player(club.slug)]))[0]?.aaL10.value).toBe(1.455);
    expect((await service.decorate([before]))[0]?.aaL10.value).toBe(17.332);
    expect(src.national).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous national snapshot on failed and unexpectedly empty refreshes', async () => {
    const store = new InMemoryAaContextStore(); const src = source();
    let now = Date.now(); const service = new AaContextService(store, src, true, undefined, undefined, () => now);
    await service.decorate([player()]);
    now += 2 * 86_400_000;
    // A separate fixture gets its own source refresh after the shared lease.
    const key = 'player-aa-team:v1:test-player:Defender:no-low:austria:lease';
    await store.put(key, '{}', {expirationTtl: -1});
    vi.mocked(src.national).mockRejectedValueOnce(new Error('Sorare timeout'));
    expect((await service.decorate([player()]))[0]?.aaL10.value).toBe(17.332);
    await store.put(key, '{}', {expirationTtl: -1});
    vi.mocked(src.national).mockResolvedValueOnce({aaL10:{value:null,sampleSize:0},aaL10TeamWinRate:{value:null,sampleSize:0}});
    expect((await service.decorate([player()]))[0]?.aaL10.value).toBe(17.332);
  });

  it('does not fill a genuinely empty national history with club scores', async () => {
    const src = source();
    vi.mocked(src.national).mockResolvedValue({aaL10:{value:null,sampleSize:0},aaL10TeamWinRate:{value:null,sampleSize:0}});
    const result = (await new AaContextService(new InMemoryAaContextStore(),src,true).decorate([player()]))[0]!;
    expect(result.aaL10.value).toBeNull();
    expect(result.aaContext).toMatchObject({kind:'national',state:'ready'});
    expect(result.aaClub?.aaL10.value).toBe(1.455);
  });

  it('coalesces duplicate cards and isolates card positions, teams and coverage policy', async () => {
    const store = new InMemoryAaContextStore(); const src = source();
    const a = new AaContextService(store,src,true);
    await a.decorate([player(), player(), {...player(),position:'Midfielder'}]);
    expect(src.national).toHaveBeenCalledTimes(2);
    await new AaContextService(store,src,false).decorate([player()]);
    expect(src.national).toHaveBeenCalledTimes(3);
    const unknown = (await a.decorate([player('unknown-team')]))[0]!;
    expect(unknown.aaContext?.state).toBe('loading');
    expect(unknown.aaL10.value).toBe(1.455);
    expect(src.national).toHaveBeenCalledTimes(3);
  });

  it('keeps AA pending while the matching context loads, without blocking goal or CS', async () => {
    const src = source(); const work: Promise<void>[] = [];
    let resolve!: (v: Awaited<ReturnType<AaContextSource['national']>>) => void;
    vi.mocked(src.national).mockImplementation(() => new Promise(r => {resolve=r;}));
    const service = new AaContextService(new InMemoryAaContextStore(),src,true,t=>work.push(t));
    const first = (await service.decorate([player()]))[0]!;
    expect(first.aaL10.value).toBe(1.455);
    expect(lineupSortReadinessForPlayer(first)).toMatchObject({aa:'pending',goal:'ready',cleanSheet:'ready'});
    resolve({aaL10:{value:17.332,sampleSize:10},aaL10TeamWinRate:{value:.5,sampleSize:10}});
    await Promise.all(work);
    const second = (await service.decorate([player()]))[0]!;
    expect(second.aaL10.value).toBe(17.332);
    expect(second.pendingRefreshes).toBeUndefined();
  });

  it('waits for an unresolved next fixture before certifying the club AA for sorting', async () => {
    const src=source();
    const stats={...player(),nextGame:null,pendingRefreshes:['fixture' as const]};
    const result=(await new AaContextService(new InMemoryAaContextStore(),src,true).decorate([stats]))[0]!;
    expect(result.aaL10.value).toBe(1.455);
    expect(lineupSortReadinessForPlayer(result).aa).toBe('pending');
    expect(src.memberships).not.toHaveBeenCalled();
  });

  it('projects only for new clients and never overwrites the cached club form', async () => {
    const form = new TtlCache<PlayerFormStats>(60_000);
    const cache = new SplitPlayerStatsCache(form, new TtlCache<PlayerFixtureStats>(60_000));
    const key = 'test-player:Defender:no-low';
    await cache.set(key, player());
    const src=source();
    const service = new StatsService(new MockDataSource(),new HistoricalGoalscorerProvider(),cache,true,
      new UnavailablePlayerMarketOddsProvider(),undefined,undefined,undefined,undefined,undefined,undefined,undefined,
      new AaContextService(new InMemoryAaContextStore(),src,true));
    const request={slugs:['test-player'],positions:{'test-player':'Defender'},oddsCacheOnly:true};
    const modern=await service.getPlayerStats(PlayerStatsRequestSchema.parse({...request,supportsAaContext:true}));
    expect(modern.data[0]?.aaL10.value).toBe(17.332);
    expect(form.get(key)?.aaL10.value).toBe(1.455);
    const legacy=await service.getPlayerStats(PlayerStatsRequestSchema.parse(request));
    expect(legacy.data[0]?.aaL10.value).toBe(1.455);
    expect(legacy.data[0]?.aaContext).toBeUndefined();
  });
});

describe('national AA source filtering', () => {
  const game = (id: string, aa: number, overrides: Record<string, unknown> = {}) => ({
    id,date:`2030-01-${id.padStart(2,'0')}T18:00:00Z`,lowCoverage:false,statusTyped:'played',winner:{id:national.id},
    playerGameScore:{__typename:'PlayerGameScore',positionTyped:'Defender',allAroundScore:aa,
      footballPlayerGameStats:{anyTeam:{id:national.id},minsPlayed:90,playedInGame:true}}, ...overrides,
  });
  const page = (nodes: unknown[], hasNextPage=false) => ({data:{anyPlayer:{__typename:'Player',activeNationalTeam:{...national,
    latestGames:{nodes,pageInfo:{hasNextPage,endCursor:hasNextPage?'page-2':null}}}}}});
  function client(fetchImpl: typeof fetch) {return new SorareGraphqlClient({url:'https://api.sorare.com/graphql',requestTimeoutMs:1000,maxRetries:0,
    logger:{debug(){},info(){},warn(){},error(){}},fetchImpl});}

  it('counts only completed national games, correct position and 60+ minutes, and shares the win-rate sample', async () => {
    const short=game('4',100); short.playerGameScore.footballPlayerGameStats.minsPlayed=59;
    const wrong=game('5',100);wrong.playerGameScore.footballPlayerGameStats.anyTeam.id=club.id;
    const position=game('6',100);position.playerGameScore.positionTyped='Forward';
    const fetchImpl=vi.fn<typeof fetch>(async (_input,init)=>{
      const body=JSON.parse(String(init?.body));expect(body.query).toBe(NATIONAL_AA_QUERY);
      expect(body.variables).toMatchObject({slug:'test-player',position:'Defender'});
      return Response.json(page([game('1',10),game('1',10),game('2',20,{winner:null}),
        game('3',100,{lowCoverage:true}),short,wrong,position,game('7',100,{statusTyped:'playing'})]));
    });
    expect(await new SorareAaContextSource(client(fetchImpl),true).national(player(),national)).toEqual({
      aaL10:{value:15,sampleSize:2},aaL10TeamWinRate:{value:.5,sampleSize:2}});
  });

  it('does not return a partial value when the second national page fails', async () => {
    const fetchImpl=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(page([game('1',10)],true)))
      .mockResolvedValueOnce(new Response('',{status:503}));
    await expect(new SorareAaContextSource(client(fetchImpl),true).national(player(),national)).rejects.toThrow();
  });

  it('never uses another national membership for the requested team', async () => {
    const data=page([game('1',10)]);data.data.anyPlayer.activeNationalTeam.slug='other';
    await expect(new SorareAaContextSource(client(vi.fn().mockResolvedValue(Response.json(data))),true)
      .national(player(),national)).rejects.toThrow('membership changed');
  });
});
