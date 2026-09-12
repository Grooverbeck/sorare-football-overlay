import { PlayerStatsRequestSchema } from '@sorare-overlay/shared';
import { describe, expect, it, vi } from 'vitest';
import { SplitPlayerStatsCache, TtlCache, type PlayerFixtureStats, type PlayerFormStats } from '../cache.js';
import { HistoricalGoalscorerProvider } from '../providers/goalscorer-provider.js';
import { UnavailablePlayerMarketOddsProvider } from '../providers/market-odds-provider.js';
import type { PlayerStatsDataSource, SourcePlayerFixture } from '../services/data-source.js';
import { StatsService } from '../services/stats-service.js';

const slug = 'sepe-elye-wahi';
const key = `${slug}:Forward:no-low`;
const oldFixture: NonNullable<PlayerFixtureStats> = {
  date: '2026-09-12T13:30:00Z', competitionSlug: 'bundesliga-de',
  homeTeamSlug: 'mainz-05-mainz', awayTeamSlug: 'eintracht-frankfurt-frankfurt-am-main',
  homeTeamName: 'Mainz 05', awayTeamName: 'Eintracht Frankfurt',
  playerTeamSlug: 'eintracht-frankfurt-frankfurt-am-main',
  playerTeamName: 'Eintracht Frankfurt', opponentTeamName: 'Mainz 05',
  cleanSheetProbability: 0.2, matchProbabilities: { win: 0.3, draw: 0.26, loss: 0.44 },
  marketOdds: { source: 'mock', capturedAt: '2026-09-11T12:00:00Z', goal: { probability: 0.99, bookmakerCount: 1 }, assist: null },
};
const niceFixture: NonNullable<PlayerFixtureStats> = {
  date: '2026-09-12T18:45:00Z', competitionSlug: 'ligue-1-fr',
  homeTeamSlug: 'auxerre-auxerre', awayTeamSlug: 'nice-nice',
  homeTeamName: 'Auxerre', awayTeamName: 'Nice', playerTeamSlug: 'nice-nice',
  playerTeamName: 'Nice', opponentTeamName: 'Auxerre',
  cleanSheetProbability: 1 / 3.5, matchProbabilities: { win: 0.35, draw: 0.28, loss: 0.37 },
};
const form: PlayerFormStats = {
  slug, displayName: 'Elye Wahi', position: 'Forward', aaL10: { value: 0.38, sampleSize: 10 },
  goalL10: { value: 0.3, sampleSize: 10 }, cleanSheetL10: { value: 0.2, sampleSize: 5 }, excludedLowCoverage: 0,
};
function setup(options: { cached?: NonNullable<PlayerFixtureStats>; resolvedTeam?: string; shared?: PlayerFixtureStats; fetch?: () => Promise<SourcePlayerFixture[]> } = {}) {
  const fixtureStore = Object.assign(new TtlCache<PlayerFixtureStats>(60_000), {
    getTeamFixture: vi.fn(async (_key: string, team: string) => team === 'nice-nice' ? options.shared ?? niceFixture : oldFixture),
  });
  const cache = new SplitPlayerStatsCache(new TtlCache<PlayerFormStats>(60_000), fixtureStore);
  const fetchNextGames = vi.fn(options.fetch ?? (async () => [{ slug, playerTeamSlug: 'nice-nice', nextGame: niceFixture }]));
  const source: PlayerStatsDataSource = {
    source: 'sorare',
    resolvePlayerNames: async () => [{ slug, position: 'Forward', teamSlug: options.resolvedTeam ?? 'nice-nice', resolvedFromName: 'Elye Wahi', nameResolution: 'search' }],
    fetchPlayers: vi.fn(async () => []), fetchNextGames,
  };
  const provider = new UnavailablePlayerMarketOddsProvider();
  const load = vi.spyOn(provider, 'load');
  const service = new StatsService(source, new HistoricalGoalscorerProvider(), cache, true, provider);
  const seed = cache.set(key, { ...form, nextGame: options.cached ?? oldFixture });
  const request = () => service.getPlayerStats(PlayerStatsRequestSchema.parse({
    playerNames: ['Elye Wahi'], positions: { 'Elye Wahi': 'Forward' },
    playerTeams: { 'Elye Wahi': 'nice-nice' }, oddsCacheOnly: true,
  }));
  return { cache, source, fetchNextGames, service, request, seed, load };
}

describe('cached fixture club changes', () => {
  it('revalidates Wahi and replaces the old club fixture even when Nice kicks off later', async () => {
    const test = setup(); await test.seed;
    const result = await test.request();
    expect(test.fetchNextGames).toHaveBeenCalledOnce();
    // Raw hints and cached name resolutions must not masquerade as fresh Sorare evidence.
    expect(test.fetchNextGames.mock.calls[0]?.[0]).toEqual([{ slug }]);
    expect(result.data[0]?.nextGame).toMatchObject(niceFixture);
    const cached = await test.cache.get(key);
    expect(cached?.nextGame).toMatchObject(niceFixture);
    expect(cached?.nextGame?.marketOdds).toBeUndefined();
    expect(test.source.fetchPlayers).not.toHaveBeenCalled();
    const direct = await test.service.getPlayerStats(PlayerStatsRequestSchema.parse({ slugs: [slug], positions: { [slug]: 'Forward' }, oddsCacheOnly: true }));
    expect(direct.data[0]?.nextGame?.playerTeamSlug).toBe('nice-nice');
    expect(test.fetchNextGames).toHaveBeenCalledOnce();
  });

  it('leaves an already correct team untouched without another Sorare lookup', async () => {
    const test = setup({ cached: niceFixture }); await test.seed;
    expect((await test.request()).data[0]?.nextGame).toMatchObject(niceFixture);
    expect(test.fetchNextGames).not.toHaveBeenCalled();
  });

  it('does not roll Nice back to Frankfurt from an old name-cache alias', async () => {
    const test = setup({ cached: niceFixture, resolvedTeam: oldFixture.playerTeamSlug }); await test.seed;
    expect((await test.request()).data[0]?.nextGame).toMatchObject(niceFixture);
    expect((await test.cache.get(key))?.nextGame).toMatchObject(niceFixture);
  });

  it('does not persist a made-up DOM club when Sorare confirms the cached club', async () => {
    const test = setup({ fetch: async () => [{ slug, playerTeamSlug: oldFixture.playerTeamSlug, nextGame: oldFixture }] }); await test.seed;
    const result = await test.service.getPlayerStats(PlayerStatsRequestSchema.parse({ slugs: [slug], positions: { [slug]: 'Forward' }, playerTeams: { [slug]: 'nice-nice' }, oddsCacheOnly: true }));
    expect(result.data[0]?.nextGame?.playerTeamSlug).toBe(oldFixture.playerTeamSlug);
    expect((await test.cache.get(key))?.nextGame?.playerTeamSlug).toBe(oldFixture.playerTeamSlug);
    expect(test.fetchNextGames).not.toHaveBeenCalled();
  });

  it('keeps AA but withholds a conflicting fixture when confirmation fails', async () => {
    const test = setup({ fetch: async () => { throw new Error('Sorare unavailable'); } }); await test.seed;
    const result = await test.request();
    expect(result.data[0]?.aaL10.value).toBe(0.38);
    expect(result.data[0]?.nextGame).toBeNull();
    expect(result.data[0]?.pendingRefreshes).toContain('fixture');
    expect((await test.cache.get(key))?.nextGame?.playerTeamSlug).toBe(oldFixture.playerTeamSlug);
  });

  it('borrows only the freshly confirmed club fixture when nextGame is null', async () => {
    const test = setup({
      shared: { ...niceFixture, marketOdds: oldFixture.marketOdds },
      fetch: async () => [{ slug, playerTeamSlug: 'nice-nice', nextGame: null }],
    }); await test.seed;
    expect((await test.request()).data[0]?.nextGame).toMatchObject(niceFixture);
    expect((await test.cache.get(key))?.nextGame?.marketOdds).toBeUndefined();
  });

  it('does not overwrite a fixture changed by another request while confirmation was in flight', async () => {
    let finish!: (value: SourcePlayerFixture[]) => void;
    const confirmation = new Promise<SourcePlayerFixture[]>(resolve => { finish = resolve; });
    const test = setup({ fetch: () => confirmation }); await test.seed;
    const pending = test.request();
    await vi.waitFor(() => expect(test.fetchNextGames).toHaveBeenCalledOnce());
    const newer = { ...niceFixture, date: '2026-09-19T18:45:00Z' };
    await test.cache.refreshFixture(key, newer);
    finish([{ slug, playerTeamSlug: 'nice-nice', nextGame: niceFixture }]);
    expect((await pending).data[0]?.nextGame?.date).toBe(newer.date);
    expect((await test.cache.get(key))?.nextGame?.date).toBe(newer.date);
  });

  it('retains the response deadline without leaking the disputed fixture', async () => {
    let finish!: (value: SourcePlayerFixture[]) => void;
    const confirmation = new Promise<SourcePlayerFixture[]>(resolve => { finish = resolve; });
    const test = setup({ fetch: () => confirmation }); await test.seed;
    const background: Promise<void>[] = [];
    const service = new StatsService(test.source, new HistoricalGoalscorerProvider(), test.cache, true,
      new UnavailablePlayerMarketOddsProvider(), task => background.push(task), undefined, undefined, undefined, 20);
    const result = await service.getPlayerStats(PlayerStatsRequestSchema.parse({ playerNames: ['Elye Wahi'], positions: { 'Elye Wahi': 'Forward' }, oddsCacheOnly: true }));
    expect(result.diagnostics.responseBudgetExceeded).toBe(true);
    expect(result.data[0]).toMatchObject({ aaL10: { value: 0.38 }, nextGame: null, pendingRefreshes: ['fixture'] });
    finish([{ slug, playerTeamSlug: 'nice-nice', nextGame: niceFixture }]);
    await Promise.all(background);
    expect((await test.cache.get(key))?.nextGame).toMatchObject(niceFixture);
  });
});
