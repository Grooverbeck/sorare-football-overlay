import { describe, expect, it } from 'vitest';
import { buildRoster, deriveMarkets, deriveHistorySample, quantile, summarize } from '../../scripts/lib/european-market-calibration.mjs';

const league = 'bundesliga-de';
const player = (slug = 'player-one', position = 'Defender', club = 'home') => ({
  slug, displayName: slug.replaceAll('-', ' '), position: 'Forward', cardPositions: ['Forward'],
  activeClub: { slug: club, name: club, shortName: club, domesticLeague: { slug: league } },
  commonPlayer: { positions: [position], anyTeam: { slug: club } },
});
const roster = () => buildRoster([{ complete: true, league, players: [player(), player('opponent', 'Defender', 'away')] }]);
const snapshot = (name = 'player one', price = 10, capturedAt = '2026-09-12T09:00:00Z') => ({
  cache_key: `market-odds:v1:${encodeURIComponent('odds-api-io|2026-09-12T14:00:00.000Z|home|away')}:player_assists`,
  value: { capturedAt, players: { [name]: { bookmakerQuotes: [{ title: 'Bet365', decimalOdds: price, probability: 1 / price }] } } },
});
const derive = (markets: unknown[]) => deriveMarkets({ groups: { fixtures: [], markets } }, roster(), { from: '2026-09-01', to: '2026-09-14' });

describe('offline European market calibration', () => {
  it('requires a common card belonging to the confirmed current club and uses its position', () => {
    expect(roster().get('player-one')?.positions).toEqual(['Defender']);
    const oldTeam = player(); oldTeam.commonPlayer.anyTeam.slug = 'old-team';
    expect(buildRoster([{ complete: true, league, players: [oldTeam] }]).size).toBe(0);
    expect(() => buildRoster([{ complete: false, league, players: [] }])).toThrow();
  });
  it('deduplicates aliases/captures per player, fixture, position and market', () => {
    const result = derive([snapshot(), snapshot('Player One', 5, '2026-09-12T10:00:00Z')]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ position: 'Defender', probability: .2, market: 'assist' });
  });
  it('does not reuse a player probability for a namesake or an unknown team', () => {
    expect(derive([snapshot('unrelated name')]).rows).toHaveLength(0);
    const unknown = snapshot(); unknown.cache_key = unknown.cache_key.replace('away', 'unknown');
    expect(derive([unknown]).rows).toHaveLength(0);
  });
  it('excludes live, too-early and out-of-window captures', () => {
    expect(derive([snapshot('player one', 10, '2026-09-12T14:00:01Z')]).rows).toHaveLength(0);
    expect(derive([snapshot('player one', 10, '2026-09-08T09:00:00Z')]).rows).toHaveLength(0);
  });
  it('never mixes other bookmaker conventions or treats absent markets as zero', () => {
    const different = snapshot(); different.value.players['player one']!.bookmakerQuotes[0]!.probability = .09;
    expect(derive([different]).rows).toHaveLength(0);
    different.value.players['player one']!.bookmakerQuotes[0]!.probability = Number.NaN;
    expect(derive([different]).rows).toHaveLength(0);
    const missing = snapshot(); missing.value.players = {};
    expect(derive([missing]).rows).toHaveLength(0);
    expect(summarize([]).assist.Defender.rounded).toEqual([null, null, null, null, null]);
  });
  it('keeps repeated fixtures on different dates separate', () => {
    const later = snapshot('player one', 8, '2026-09-13T09:00:00Z');
    later.cache_key = later.cache_key.replace('2026-09-12', '2026-09-13');
    expect(derive([snapshot(), later]).rows).toHaveLength(2);
  });
  it('rejects conflicting prices for aliases at the same capture time', () => {
    expect(derive([snapshot(), snapshot('Player One', 5)]).rows).toHaveLength(0);
    expect(derive([snapshot('Player One', 5), snapshot()]).rows).toHaveLength(0);
  });
  it('computes reproducible quantiles without fabricating empty samples', () => {
    expect(quantile([1, 0], .2)).toBe(.2);
    expect(quantile([], .9)).toBeNull();
    expect(quantile([.1, .1, .1], .9)).toBe(.1);
  });
  it('requires complete, unique history samples and excludes insufficient histories', () => {
    const row = { slug: 'player-one', position: 'Defender', league,
      historicalGoals: { l40: { value: 0, sampleSize: 30 } },
      historicalAssists: { l40: { value: .2, sampleSize: 19 } } };
    const sample = { complete: true, selection: [row], rows: [row] };
    expect(deriveHistorySample(sample, roster())).toEqual([expect.objectContaining({ market: 'goal', probability: 0 })]);
    expect(() => deriveHistorySample({ ...sample, complete: false }, roster())).toThrow();
    expect(() => deriveHistorySample({ ...sample, rows: [row, row] }, roster())).toThrow();
    expect(() => deriveHistorySample({ ...sample, rows: [] }, roster())).toThrow();
  });
});
