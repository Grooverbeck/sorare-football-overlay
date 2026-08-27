import type { PlayerMarketOdds, PlayerStats } from '@sorare-overlay/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  CompetitionRoutedFixtureMatchOddsProvider,
  CompetitionRoutedPlayerMarketOddsProvider,
  createCompetitionRouteIndex,
} from '../providers/competition-routed-provider.js';
import {
  playerMarketOddsKey,
  type PlayerMarketOddsProvider,
} from '../providers/market-odds-provider.js';
import type { FixtureMatchOddsProvider } from '../providers/match-odds-provider.js';

function player(slug: string, competitionSlug: string): PlayerStats {
  return {
    slug,
    displayName: slug,
    position: 'Forward',
    aaL10: { value: 10, sampleSize: 10 },
    cleanSheetL10: { value: 0, sampleSize: 0 },
    goalL10: { value: 0.2, sampleSize: 10 },
    nextGame: {
      date: '2026-08-29T18:00:00.000Z',
      competitionSlug,
      homeTeamName: 'Home FC',
      awayTeamName: 'Away FC',
      playerTeamName: 'Home FC',
      opponentTeamName: 'Away FC',
      cleanSheetProbability: null,
      matchProbabilities: null,
    },
    excludedLowCoverage: 0,
  };
}

function marketOdds(probability: number): PlayerMarketOdds {
  return {
    source: 'mock',
    capturedAt: '2026-08-27T12:00:00.000Z',
    goal: { probability, bookmakerCount: 1 },
    assist: null,
  };
}

describe('competition-routed providers', () => {
  it('loads each player-market competition through only its direct provider', async () => {
    const firstLoad = vi.fn<PlayerMarketOddsProvider['load']>(
      async (players, options) => {
        options?.refreshDueState && (options.refreshDueState.complete = true);
        for (const value of players) {
          options?.refreshDuePlayerKeys?.add(playerMarketOddsKey(value));
        }
        return new Map(
          players.map((value) => [playerMarketOddsKey(value), marketOdds(0.3)]),
        );
      },
    );
    const secondLoad = vi.fn<PlayerMarketOddsProvider['load']>(
      async (players, options) => {
        options?.refreshDueState && (options.refreshDueState.complete = true);
        for (const value of players) {
          options?.refreshDuePlayerKeys?.add(playerMarketOddsKey(value));
        }
        return new Map(
          players.map((value) => [playerMarketOddsKey(value), marketOdds(0.4)]),
        );
      },
    );
    const provider = (load: PlayerMarketOddsProvider['load']): PlayerMarketOddsProvider => ({
      reportsRefreshDue: true,
      supports: () => true,
      supportsMarket: () => true,
      drivesMarketRequest: () => true,
      load,
    });
    const routed = new CompetitionRoutedPlayerMarketOddsProvider(
      [provider(firstLoad), provider(secondLoad)],
      createCompetitionRouteIndex([['league-a'], ['league-b']]),
    );
    const players = [
      player('first', 'league-a'),
      player('second', 'league-b'),
      player('unsupported', 'league-c'),
    ];
    const refreshDuePlayerKeys = new Set<string>();
    const refreshDueState = { complete: false };

    const values = await routed.load(players, {
      cacheOnly: true,
      refreshDuePlayerKeys,
      refreshDueState,
    });

    expect(firstLoad).toHaveBeenCalledWith(
      [players[0]],
      expect.objectContaining({ cacheOnly: true }),
    );
    expect(secondLoad).toHaveBeenCalledWith(
      [players[1]],
      expect.objectContaining({ cacheOnly: true }),
    );
    expect(values.get('first:Forward')?.goal?.probability).toBe(0.3);
    expect(values.get('second:Forward')?.goal?.probability).toBe(0.4);
    expect(values.get('unsupported:Forward')).toBeNull();
    expect(refreshDuePlayerKeys).toEqual(
      new Set(['first:Forward', 'second:Forward']),
    );
    expect(refreshDueState.complete).toBe(true);
  });

  it('dispatches match odds through the same competition index', async () => {
    const firstLoad = vi.fn<FixtureMatchOddsProvider['load']>(async (players) =>
      new Map(
        players.map((value) => [
          playerMarketOddsKey(value),
          { win: 0.5, draw: 0.3, loss: 0.2 },
        ]),
      ),
    );
    const secondLoad = vi.fn<FixtureMatchOddsProvider['load']>(async (players) =>
      new Map(
        players.map((value) => [
          playerMarketOddsKey(value),
          { win: 0.4, draw: 0.3, loss: 0.3 },
        ]),
      ),
    );
    const provider = (load: FixtureMatchOddsProvider['load']): FixtureMatchOddsProvider => ({
      supports: () => true,
      load,
    });
    const routed = new CompetitionRoutedFixtureMatchOddsProvider(
      [provider(firstLoad), provider(secondLoad)],
      createCompetitionRouteIndex([['league-a'], ['league-b']]),
    );
    const players = [player('first', 'league-a'), player('second', 'league-b')];

    const values = await routed.load(players, { cacheOnly: true });

    expect(firstLoad).toHaveBeenCalledWith([players[0]], { cacheOnly: true });
    expect(secondLoad).toHaveBeenCalledWith([players[1]], { cacheOnly: true });
    expect(values.get('first:Forward')?.win).toBe(0.5);
    expect(values.get('second:Forward')?.win).toBe(0.4);
  });

  it('keeps normal provider requests sequential across competitions', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstLoad = vi.fn<PlayerMarketOddsProvider['load']>(
      async (players) => {
        await firstPending;
        return new Map(
          players.map((value) => [playerMarketOddsKey(value), marketOdds(0.3)]),
        );
      },
    );
    const secondLoad = vi.fn<PlayerMarketOddsProvider['load']>(async (players) =>
      new Map(
        players.map((value) => [playerMarketOddsKey(value), marketOdds(0.4)]),
      ),
    );
    const provider = (load: PlayerMarketOddsProvider['load']): PlayerMarketOddsProvider => ({
      reportsRefreshDue: true,
      supports: () => true,
      load,
    });
    const routed = new CompetitionRoutedPlayerMarketOddsProvider(
      [provider(firstLoad), provider(secondLoad)],
      createCompetitionRouteIndex([['league-a'], ['league-b']]),
    );

    const pending = routed.load([
      player('first', 'league-a'),
      player('second', 'league-b'),
    ]);
    expect(firstLoad).toHaveBeenCalledTimes(1);
    expect(secondLoad).not.toHaveBeenCalled();

    releaseFirst?.();
    await pending;

    expect(secondLoad).toHaveBeenCalledTimes(1);
  });
});
