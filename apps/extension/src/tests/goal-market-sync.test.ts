import {fixtureStatusKey, lineupSortValueForPlayer, type PlayerStats, type GoalMarketSnapshot} from '@sorare-overlay/shared';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {OverlayView, applyHistoricalAssistFallbackSettings} from '../overlay.js';
import {LineupSortHydrator} from '../lineup-sort-hydrator.js';
import {goalMarketChangedEvent, readGoalMarketState, rememberGoalMarketState} from '../goal-market-state.js';
import {setLineupAaSortValue} from '../lineup-sort.js';

let view: OverlayView | undefined;
let hydrator: LineupSortHydrator | undefined;
const t1 = '2030-01-01T10:00:00Z', t2 = '2030-01-01T11:00:00Z', t3 = '2030-01-01T12:00:00Z';
const historical: PlayerStats = {
  slug: 'sync-player', displayName: 'Sync Player', position: 'Forward',
  aaL10: {value: 12, sampleSize: 10}, goalL10: {value: .2, sampleSize: 10},
  cleanSheetL10: {value: 0, sampleSize: 10}, excludedLowCoverage: 0,
  historicalGoals: {l10: {value: .2, sampleSize: 10}, l15: {value: 2 / 15, sampleSize: 15}, l40: {value: .1, sampleSize: 40}},
  nextGame: {date: '2030-01-02T18:00:00Z', homeTeamSlug: 'home-fc', awayTeamSlug: 'away-fc', playerTeamSlug: 'home-fc',
    homeTeamName: 'Home FC', awayTeamName: 'Away FC', playerTeamName: 'Home FC', opponentTeamName: 'Away FC',
    cleanSheetProbability: null, matchProbabilities: null, marketOdds: null},
};

function market(probability: number, capturedAt: string): GoalMarketSnapshot {
  return {source: 'odds-api-io', capturedAt, goal: {probability, bookmakerCount: 1,
    bookmakerQuotes: [{key: 'test-book', title: 'Test Book', decimalOdds: 1 / probability, probability}]}};
}
function priced(probability: number, capturedAt = t2): PlayerStats {
  return {...historical, nextGame: {...historical.nextGame!, marketOdds: {...market(probability, capturedAt), assist: null}}};
}
function compact(stats: PlayerStats) {
  return {data: [lineupSortValueForPlayer(stats, 15)], meta: {requested: 1, returned: 1, cacheHits: 1, source: 'sorare' as const, durationMs: 1}};
}
function setup() {
  document.body.innerHTML = '<section><article><img alt="Sync Player - common"></article></section>';
  const grid = document.querySelector('section')!, card = document.querySelector('article')!;
  return {grid, card, target: {container: card, slug: historical.slug, position: historical.position}};
}
function mount(card: HTMLElement) {view = new OverlayView(card, {slug: historical.slug}, 'Forward'); return view;}
function expectMarket(card: HTMLElement, probability: number) {
  expect(card.getAttribute('data-sorare-overlay-goal-sort-source')).toBe('market');
  expect(Number(card.getAttribute('data-sorare-overlay-goal-sort-probability'))).toBe(probability);
  const cell = view!.host.shadowRoot!.querySelector('[data-market="goal"]')!;
  expect(cell.getAttribute('data-source')).not.toBe('historical');
  expect(cell.querySelector('.market-value')?.textContent).toBe(`${Math.round(probability * 100)}%`);
  expect(view!.host.shadowRoot!.querySelector('.bookmaker-markets')?.textContent).toContain('Test Book');
  expect(view!.host.shadowRoot!.querySelector('.bookmaker-markets')?.textContent).not.toContain('Historisches Tor');
}

beforeEach(() => {applyHistoricalAssistFallbackSettings(true, 15); window.history.replaceState({}, '', '/football');});
afterEach(() => {hydrator?.stop(); hydrator = undefined; view?.destroy(); view = undefined; document.body.replaceChildren(); applyHistoricalAssistFallbackSettings(false, 15); vi.useRealTimers();});

describe('goal market snapshot synchronization', () => {
  it('uses the compact market snapshot for the bracket and tooltip when a historical full response arrives later', async () => {
    const {grid, card, target} = setup();
    hydrator = new LineupSortHydrator(async () => compact(priced(.4)), 50, [], 0);
    await hydrator.hydrate(grid, [target]);
    mount(card).render(historical);
    expectMarket(card, .4);
  });

  it('updates an already rendered historical bracket on the final cache read without another request', async () => {
    const {grid, card, target} = setup();
    mount(card).render(historical);
    expect(view!.host.shadowRoot!.querySelector('[data-market="goal"] .market-value')?.textContent).toBe('(13%)');
    const fetcher = vi.fn(async () => compact(priced(.4)));
    hydrator = new LineupSortHydrator(fetcher, 50, [], 0);
    await hydrator.hydrate(grid, [target]);
    hydrator.finalizePool(grid);
    await vi.waitFor(() => expectMarket(card, .4));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([.6, .25])('accepts a newer compact price of %s even though a market value already exists', async probability => {
    const {grid, card, target} = setup();
    mount(card).render({...priced(.4, t1), pendingRefreshes: ['formHistory']});
    hydrator = new LineupSortHydrator(async () => compact(priced(probability, t2)), 50, [], 0);
    hydrator.configureMode('aa');
    await hydrator.hydrate(grid, [target]);
    expectMarket(card, probability);
  });

  it.each([t1, t3])('does not replace a newer full price with an older or equally dated conflicting compact result (%s)', async capturedAt => {
    const {grid, card, target} = setup();
    mount(card).render(historical);
    hydrator = new LineupSortHydrator(async () => {
      view!.render(priced(.6, t3));
      return compact(priced(.4, capturedAt));
    }, 50, [], 0);
    await hydrator.hydrate(grid, [target]);
    hydrator.finalizePool(grid);
    await vi.waitFor(() => expectMarket(card, .6));
  });

  it('keeps a newer snapshot through historical and older full renders, but accepts the next fresh full quote', () => {
    const {card} = setup();
    mount(card).render(priced(.4, t2));
    view!.render(historical); expectMarket(card, .4);
    view!.render(priced(.2, t1)); expectMarket(card, .4);
    view!.render(priced(.3, t3)); expectMarket(card, .3);
  });

  it('accepts a more recently captured compact quote even if the full response arrived after its request started', async () => {
    const {grid, card, target} = setup();
    mount(card).render(historical);
    hydrator = new LineupSortHydrator(async () => {
      view!.render(priced(.4, t1));
      return compact(priced(.5, t2));
    }, 50, [], 0);
    await hydrator.hydrate(grid, [target]);
    hydrator.finalizePool(grid);
    await vi.waitFor(() => expectMarket(card, .5));
  });

  it('adds a newly available goal slot with exactly one folded bracket end', () => {
    const {card} = setup();
    applyHistoricalAssistFallbackSettings(false, 15);
    mount(card).render(historical);
    rememberGoalMarketState(card, {slug: historical.slug, position: 'Forward', fixtureIdentity: fixtureStatusKey(historical.nextGame!)!, market: market(.4, t2)});
    card.dispatchEvent(new Event(goalMarketChangedEvent));
    expectMarket(card, .4);
    expect(view!.host.shadowRoot!.querySelectorAll('.market-fold-end')).toHaveLength(1);
    expect(view!.host.shadowRoot!.querySelector('.market-fold-end')?.getAttribute('data-market')).toBe('goal');
  });

  it('does not repaint already rendered AA when only a goal snapshot changes', () => {
    const {card} = setup(); mount(card).render(historical);
    const aa = view!.host.shadowRoot!.querySelector('.aa-bracket-cell');
    setLineupAaSortValue(card, 30);
    rememberGoalMarketState(card, {slug: historical.slug, position: 'Forward', fixtureIdentity: fixtureStatusKey(historical.nextGame!)!, market: market(.4, t2)});
    card.dispatchEvent(new Event(goalMarketChangedEvent));
    expectMarket(card, .4);
    expect(view!.host.shadowRoot!.querySelector('.aa-bracket-cell')).toBe(aa);
    expect(card.getAttribute('data-sorare-overlay-aa-sort-value')).toBe('30');
  });

  it('restores the same market details on a remounted copy without another fetch', async () => {
    const {grid, card, target} = setup();
    const fetcher = vi.fn(async () => compact(priced(.4)));
    hydrator = new LineupSortHydrator(fetcher, 50, [], 0);
    await hydrator.hydrate(grid, [target]);
    const replacement = document.createElement('article'); card.replaceWith(replacement);
    await hydrator.hydrate(grid, [{...target, container: replacement}]);
    mount(replacement).render(historical);
    expectMarket(replacement, .4);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not borrow a snapshot for another player or fixture', () => {
    const {card} = setup(); mount(card).render(priced(.4));
    view!.render({...historical, slug: 'another-player', displayName: 'Another Player'});
    expect(card.getAttribute('data-sorare-overlay-goal-sort-source')).toBe('historical');
    expect(view!.host.shadowRoot!.querySelector('[data-market="goal"]')?.getAttribute('data-source')).toBe('historical');
    view!.render({...historical, nextGame: {...historical.nextGame!, date: '2030-01-10T18:00:00Z'}});
    expect(view!.host.shadowRoot!.querySelector('[data-market="goal"]')?.getAttribute('data-source')).toBe('historical');
    expect(readGoalMarketState(card)).toBeUndefined();
  });

  it('does not leak a held market onto a different visible team matchup', async () => {
    const {grid, card, target} = setup();
    grid.insertAdjacentHTML('beforeend', '<div><span aria-label="Team"><img alt="other-home"></span><span aria-label="Team"><img alt="other-away"></span></div>');
    hydrator = new LineupSortHydrator(async () => compact(priced(.4)), 50, [], 0);
    await hydrator.hydrate(grid, [target]);
    mount(card).render(historical);
    expect(card.getAttribute('data-sorare-overlay-goal-sort-source')).toBe('historical');
    expect(view!.host.shadowRoot!.querySelector('[data-market="goal"]')?.getAttribute('data-source')).toBe('historical');
  });

  it('keeps the latest own quote when team probabilities are borrowed from a teammate', () => {
    const {grid, card} = setup();
    grid.insertAdjacentHTML('beforeend', '<div><span aria-label="Team"><img alt="home-fc"></span><span aria-label="Team"><img alt="away-fc"></span></div>');
    mount(card).render(priced(.4, t1));
    const teammate = {...priced(.8, t3), slug: 'teammate', displayName: 'Teammate'};
    teammate.nextGame = {...teammate.nextGame!, matchProbabilities: {win: .6, draw: .2, loss: .2}};
    view!.render(priced(.5, t2), [teammate]);
    expectMarket(card, .5);
  });
});
