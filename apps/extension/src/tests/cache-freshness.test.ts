import { expect, it, vi } from 'vitest';
import type { PlayerStats } from '@sorare-overlay/shared';
import { StatsBatchCoordinator } from '../scanner.js';
import type { OverlayView } from '../overlay.js';

it.each([
  ['summer', '2026-09-10T19:00:00Z', '2026-09-11T07:00:00Z'],
  ['winter', '2026-12-10T19:00:00Z', '2026-12-11T08:00:00Z'],
])('expires fixture aliases at 09:00 Berlin in %s', (_season, kickoff, rollover) => {
  const boundary = Date.parse(rollover);
  const spy = vi.spyOn(Date, 'now').mockReturnValue(boundary - 30 * 60_000);
  const stats: PlayerStats = {
    slug: 'rollover-player', displayName: 'Rollover Player', position: 'Forward',
    aaL10: { value: 10, sampleSize: 10 }, goalL10: { value: 0.2, sampleSize: 10 },
    cleanSheetL10: { value: 0, sampleSize: 10 }, excludedLowCoverage: 0,
    nextGame: { date: kickoff, cleanSheetProbability: null, matchProbabilities: null },
  };
  const coordinator = new StatsBatchCoordinator() as unknown as {
    setCachedStats(key: string, stats: PlayerStats): void;
    getCachedStats(key: string): PlayerStats | undefined;
  };
  try {
    coordinator.setCachedStats('original', stats);
    spy.mockReturnValue(boundary - 1);
    coordinator.setCachedStats('alias', stats);
    expect(coordinator.getCachedStats('original')).toBe(stats);
    expect(coordinator.getCachedStats('alias')).toBe(stats);
    spy.mockReturnValue(boundary);
    expect(coordinator.getCachedStats('original')).toBeUndefined();
    expect(coordinator.getCachedStats('alias')).toBeUndefined();
  } finally {
    spy.mockRestore();
  }
});

it('replaces a paused market refresh with a full fetch when cached data expired', () => {
  const c = new StatsBatchCoordinator();
  const internals = c as unknown as {
    trackedViews: Map<OverlayView, {slug:string}>;
    cachedStatsForTarget: () => PlayerStats | undefined;
    clearPendingRefresh: (key:string) => void;
    queueTarget: (...args:unknown[]) => void;
  };
  const view = {} as OverlayView;
  const target = {slug:'expired-player'};
  internals.trackedViews.set(view,target);
  vi.spyOn(internals,'cachedStatsForTarget').mockReturnValue(undefined);
  const clear = vi.spyOn(internals,'clearPendingRefresh').mockImplementation(() => {});
  const queue = vi.spyOn(internals,'queueTarget').mockImplementation(() => {});
  c.setViewViewportActive(target,view,true,1);
  expect(clear).toHaveBeenCalledTimes(1);
  expect(queue).toHaveBeenCalledWith(target,[view],1);
});

it('expires actively accessed data and does not renew it when creating aliases', () => {
  const spy = vi.spyOn(Date, 'now');
  const start = Date.parse('2026-09-08T10:00:00Z');
  spy.mockReturnValue(start);
  const stats: PlayerStats = {slug:'test-player',displayName:'Test Player',position:'Forward',
    aaL10:{value:10,sampleSize:10},goalL10:{value:0.2,sampleSize:10},cleanSheetL10:{value:0,sampleSize:10},
    nextGame:{date:'2026-09-10T18:00:00Z',cleanSheetProbability:null,matchProbabilities:null},excludedLowCoverage:0};
  const coordinator = new StatsBatchCoordinator() as unknown as {
    setCachedStats(key:string, stats:PlayerStats):void;
    getCachedStats(key:string):PlayerStats|undefined;
  };
  try {
    coordinator.setCachedStats('original',stats);
    for (let h=1;h<4;h++) {
      spy.mockReturnValue(start+h*3_600_000);
      expect(coordinator.getCachedStats('original')).toBe(stats);
      coordinator.setCachedStats('alias',stats);
    }
    spy.mockReturnValue(start+4*3_600_000);
    expect(coordinator.getCachedStats('original')).toBeUndefined();
    expect(coordinator.getCachedStats('alias')).toBeUndefined();
  } finally { spy.mockRestore(); }
});

it('keeps the original expiry when a partial response retains complete form values', () => {
  const spy = vi.spyOn(Date, 'now');
  const start = Date.parse('2026-09-08T10:00:00Z');
  spy.mockReturnValue(start);
  const old: PlayerStats = {slug:'old-player',displayName:'Old Player',position:'Forward',
    aaL10:{value:10,sampleSize:10},goalL10:{value:0.2,sampleSize:10},cleanSheetL10:{value:0,sampleSize:10},
    nextGame:{date:'2026-09-10T18:00:00Z',cleanSheetProbability:null,matchProbabilities:null},excludedLowCoverage:0};
  const c = new StatsBatchCoordinator() as unknown as {
    cacheStatsAliases(stats:PlayerStats, batch:never[]):void;
    mergeWithCachedStats(stats:PlayerStats):PlayerStats;
    dataExpiry:WeakMap<PlayerStats,number>;
  };
  try {
    c.cacheStatsAliases(old,[]);
    const expiry = c.dataExpiry.get(old);
    spy.mockReturnValue(start+3*3_600_000);
    const merged = c.mergeWithCachedStats({...old,aaL10:{value:2,sampleSize:1},pendingRefreshes:['formHistory']});
    c.cacheStatsAliases(merged,[]);
    expect(merged.aaL10).toBe(old.aaL10);
    expect(c.dataExpiry.get(merged)).toBe(expiry);
  } finally {spy.mockRestore();}
});

it('does not let a late club fixture overwrite the current national AA projection', () => {
  const stats: PlayerStats={slug:'danso',displayName:'Danso',position:'Defender',
    aaL10:{value:17.332,sampleSize:10},aaL10TeamWinRate:{value:.5,sampleSize:10},
    aaContext:{kind:'national',teamSlug:'austria',state:'ready'},aaClub:{aaL10:{value:1.455,sampleSize:4}},
    goalL10:{value:.1,sampleSize:10},cleanSheetL10:{value:.2,sampleSize:10},excludedLowCoverage:0,
    nextGame:{date:'2030-09-26T18:45:00Z',homeTeamSlug:'austria',awayTeamSlug:'israel',playerTeamSlug:'austria',
      cleanSheetProbability:.4,matchProbabilities:null}};
  const c=new StatsBatchCoordinator() as unknown as {
    cacheStatsAliases(stats:PlayerStats,batch:never[]):void;
    mergeWithCachedStats(stats:PlayerStats):PlayerStats;
  };
  c.cacheStatsAliases(stats,[]);
  const result=c.mergeWithCachedStats({...stats,aaL10:{value:1.455,sampleSize:4},aaContext:{kind:'club',teamSlug:'sunderland',state:'ready'},
    nextGame:{...stats.nextGame!,date:'2030-09-20T18:45:00Z',homeTeamSlug:'sunderland',awayTeamSlug:'arsenal',playerTeamSlug:'sunderland'}});
  expect(result.nextGame?.playerTeamSlug).toBe('austria');
  expect(result.aaL10.value).toBe(17.332);
  expect(result.aaContext?.kind).toBe('national');
});
