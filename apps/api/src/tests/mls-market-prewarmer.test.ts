import type { PlayerStats } from '@sorare-overlay/shared';
import type { DocumentNode } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../logger.js';
import type { PlayerMarketOddsProvider } from '../providers/market-odds-provider.js';
import { MlsMarketPrewarmer } from '../services/mls-market-prewarmer.js';

const logger: AppLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

class FakeGraphqlClient {
  private index = 0;

  constructor(private readonly responses: readonly unknown[]) {}

  async request<TData, TVariables>(
    _document: DocumentNode,
    _variables: TVariables,
  ): Promise<TData> {
    const response = this.responses[this.index];
    this.index += 1;
    return response as TData;
  }
}

describe('MlsMarketPrewarmer', () => {
  it('loads one field-player representative per upcoming MLS fixture', async () => {
    const now = Date.parse('2026-07-25T05:00:00.000Z');
    const kickoff = '2026-07-25T23:30:00.000Z';
    const client = new FakeGraphqlClient([
      {
        football: {
          competition: {
            futureGames: {
              nodes: [
                {
                  id: 'fixture-1',
                  date: kickoff,
                  homeTeam: { slug: 'orlando-city', shortName: 'Orlando City' },
                  awayTeam: { slug: 'nashville-sc', shortName: 'Nashville' },
                },
              ],
            },
          },
        },
      },
      {
        football: {
          club0: {
            slug: 'orlando-city',
            activePlayers: {
              nodes: [
                {
                  slug: 'orlando-goalkeeper',
                  displayName: 'Orlando Goalkeeper',
                  position: 'Goalkeeper',
                  cardPositions: ['Goalkeeper'],
                },
                {
                  slug: 'orlando-forward',
                  displayName: 'Orlando Forward',
                  position: 'Forward',
                  cardPositions: ['Forward'],
                },
              ],
            },
          },
          club1: {
            slug: 'nashville-sc',
            activePlayers: {
              nodes: [
                {
                  slug: 'nashville-midfielder',
                  displayName: 'Nashville Midfielder',
                  position: 'Midfielder',
                  cardPositions: ['Midfielder'],
                },
              ],
            },
          },
        },
      },
    ]);
    let loadedPlayers: readonly PlayerStats[] = [];
    const marketOddsProvider: PlayerMarketOddsProvider = {
      load: vi.fn(async (players) => {
        loadedPlayers = players;
        return new Map();
      }),
    };
    const prewarmer = new MlsMarketPrewarmer({
      client,
      marketOddsProvider,
      logger,
      windowMs: 24 * 60 * 60 * 1_000,
      now: () => now,
    });

    await expect(prewarmer.run()).resolves.toEqual({
      fixtures: 1,
      representatives: 1,
    });
    expect(loadedPlayers).toHaveLength(1);
    expect(loadedPlayers[0]).toMatchObject({
      slug: 'orlando-forward',
      position: 'Forward',
      nextGame: {
        date: kickoff,
        homeTeamName: 'Orlando City',
        awayTeamName: 'Nashville',
        playerTeamName: 'Orlando City',
        opponentTeamName: 'Nashville',
      },
    });
  });

  it('does not call the odds provider when no fixture is inside the window', async () => {
    const marketOddsProvider: PlayerMarketOddsProvider = {
      load: vi.fn(async () => new Map()),
    };
    const prewarmer = new MlsMarketPrewarmer({
      client: new FakeGraphqlClient([
        {
          football: {
            competition: {
              futureGames: {
                nodes: [],
              },
            },
          },
        },
      ]),
      marketOddsProvider,
      logger,
      windowMs: 24 * 60 * 60 * 1_000,
      now: () => Date.parse('2026-07-25T05:00:00.000Z'),
    });

    await expect(prewarmer.run()).resolves.toEqual({
      fixtures: 0,
      representatives: 0,
    });
    expect(marketOddsProvider.load).not.toHaveBeenCalled();
  });
});
