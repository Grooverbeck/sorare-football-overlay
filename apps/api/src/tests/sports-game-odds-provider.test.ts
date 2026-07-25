import type {
  PlayerMarketOdds,
  PlayerStats,
} from '@sorare-overlay/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../logger.js';
import {
  InMemoryMarketSnapshotStore,
  playerMarketOddsKey,
  type PlayerMarketOddsProvider,
} from '../providers/market-odds-provider.js';
import {
  SportsGameOddsPlayerMarketOddsProvider,
  SupplementingPlayerMarketOddsProvider,
} from '../providers/sports-game-odds-provider.js';

const logger: AppLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const now = Date.parse('2026-07-25T10:00:00.000Z');
const kickoff = '2026-07-25T23:30:00.000Z';

function player(overrides: Partial<PlayerStats> = {}): PlayerStats {
  return {
    slug: 'timo-werner',
    displayName: 'Timo Werner',
    position: 'Forward',
    aaL10: { value: 12, sampleSize: 10 },
    cleanSheetL10: { value: 0, sampleSize: 10 },
    goalL10: { value: 0.2, sampleSize: 10 },
    nextGame: {
      date: kickoff,
      homeTeamName: 'Chicago Fire',
      awayTeamName: 'Atlanta United',
      playerTeamName: 'Chicago Fire',
      opponentTeamName: 'Atlanta United',
      cleanSheetProbability: null,
      matchProbabilities: { win: 0.4, draw: 0.3, loss: 0.3 },
    },
    excludedLowCoverage: 0,
    ...overrides,
  };
}

function market(
  oddID: string,
  opposingOddID: string,
  statID: string,
  sideID: 'yes' | 'no',
  odds: string,
) {
  return {
    oddID,
    opposingOddID,
    statID,
    statEntityID: 'TIMO_WERNER_1_MLS',
    periodID: 'game',
    betTypeID: 'yn',
    sideID,
    playerID: 'TIMO_WERNER_1_MLS',
    byBookmaker: {
      fanduel: { odds, available: true },
    },
  };
}

function eventsEnvelope() {
  const pairs = [
    ['points', '+150', '-200'],
    ['assists', '+400', '-600'],
    ['goals+assists', '+120', '-150'],
  ] as const;
  const odds = Object.fromEntries(
    pairs.flatMap(([statID, yesOdds, noOdds]) => {
      const yes = `${statID}-TIMO_WERNER_1_MLS-game-yn-yes`;
      const no = `${statID}-TIMO_WERNER_1_MLS-game-yn-no`;
      return [
        [yes, market(yes, no, statID, 'yes', yesOdds)],
        [no, market(no, yes, statID, 'no', noOdds)],
      ];
    }),
  );
  return {
    success: true,
    data: [
      {
        eventID: 'sgo-fixture-1',
        leagueID: 'MLS',
        teams: {
          home: {
            teamID: 'CHICAGO_FIRE_MLS',
            names: { long: 'Chicago Fire FC' },
          },
          away: {
            teamID: 'ATLANTA_UNITED_MLS',
            names: { long: 'Atlanta United FC' },
          },
        },
        status: { startsAt: kickoff },
        players: {
          TIMO_WERNER_1_MLS: {
            playerID: 'TIMO_WERNER_1_MLS',
            name: 'Timo Werner',
          },
        },
        odds,
      },
    ],
  };
}

describe('SportsGameOddsPlayerMarketOddsProvider', () => {
  it('loads direct goal, assist and goals-or-assists markets with no-vig bookmaker probabilities', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('x-api-key')).toBe('secret-test-key');
      return new Response(JSON.stringify(eventsEnvelope()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const stats = player();
    const provider = new SportsGameOddsPlayerMarketOddsProvider({
      apiKey: 'secret-test-key',
      baseUrl: 'https://api.sportsgameodds.com/v2',
      leagueId: 'MLS',
      fetchWindowMs: 24 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(60_000, () => now),
      logger,
      fetchImpl,
      now: () => now,
    });

    const result = await provider.load([stats]);
    const odds = result.get(playerMarketOddsKey(stats));

    expect(odds).toMatchObject({
      source: 'sports-game-odds',
      goal: {
        probability: 0.375,
        bookmakerCount: 1,
        bookmakerQuotes: [{ key: 'fanduel', title: 'FanDuel' }],
      },
      assist: {
        bookmakerCount: 1,
      },
      decisive: {
        bookmakerCount: 1,
      },
    });
    expect(odds?.assist?.probability).toBeCloseTo(0.1895, 3);
    expect(odds?.decisive?.probability).toBeCloseTo(0.431, 3);
    const requestUrl = String(fetchImpl.mock.calls[0]?.[0]);
    expect(requestUrl).toContain('leagueID=MLS');
    expect(requestUrl).not.toContain('apiKey');
  });

  it('freezes a successful event snapshot instead of spending another object', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(eventsEnvelope()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const stats = player();
    const provider = new SportsGameOddsPlayerMarketOddsProvider({
      apiKey: 'secret-test-key',
      baseUrl: 'https://api.sportsgameodds.com/v2',
      leagueId: 'MLS',
      fetchWindowMs: 24 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(60_000, () => now),
      logger,
      fetchImpl,
      now: () => now,
    });

    await provider.load([stats]);
    await provider.load([stats]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('SupplementingPlayerMarketOddsProvider', () => {
  it('keeps the direct decisive market and fills missing split markets from the fallback', async () => {
    const stats = player();
    const primaryOdds: PlayerMarketOdds = {
      source: 'sports-game-odds',
      capturedAt: '2026-07-25T10:00:00.000Z',
      goal: null,
      assist: { probability: 0.2, bookmakerCount: 1 },
      decisive: { probability: 0.43, bookmakerCount: 1 },
    };
    const fallbackOdds: PlayerMarketOdds = {
      source: 'the-odds-api',
      capturedAt: '2026-07-25T10:05:00.000Z',
      goal: { probability: 0.35, bookmakerCount: 2 },
      assist: null,
      decisive: null,
    };
    const provider = (
      values: PlayerMarketOdds | null,
    ): PlayerMarketOddsProvider => ({
      load: vi.fn(async (players) =>
        new Map(
          players.map((candidate) => [
            playerMarketOddsKey(candidate),
            values,
          ]),
        ),
      ),
    });
    const combined = new SupplementingPlayerMarketOddsProvider(
      provider(primaryOdds),
      provider(fallbackOdds),
    );

    const result = await combined.load([stats]);

    expect(result.get(playerMarketOddsKey(stats))).toMatchObject({
      source: 'mixed',
      capturedAt: '2026-07-25T10:05:00.000Z',
      goal: { probability: 0.35 },
      assist: { probability: 0.2 },
      decisive: { probability: 0.43 },
    });
  });

  it('keeps the primary source when the fallback adds no missing market', async () => {
    const stats = player();
    const primaryOdds: PlayerMarketOdds = {
      source: 'sports-game-odds',
      capturedAt: '2026-07-25T10:00:00.000Z',
      goal: { probability: 0.35, bookmakerCount: 1 },
      assist: null,
      decisive: null,
    };
    const fallbackOdds: PlayerMarketOdds = {
      source: 'the-odds-api',
      capturedAt: '2026-07-25T10:05:00.000Z',
      goal: { probability: 0.34, bookmakerCount: 2 },
      assist: null,
      decisive: null,
    };
    const provider = (
      values: PlayerMarketOdds | null,
    ): PlayerMarketOddsProvider => ({
      load: vi.fn(async (players) =>
        new Map(
          players.map((candidate) => [
            playerMarketOddsKey(candidate),
            values,
          ]),
        ),
      ),
    });
    const combined = new SupplementingPlayerMarketOddsProvider(
      provider(primaryOdds),
      provider(fallbackOdds),
    );

    const result = await combined.load([stats]);

    expect(result.get(playerMarketOddsKey(stats))).toEqual(primaryOdds);
  });
});
