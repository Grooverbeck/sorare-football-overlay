import { calculatePlayerMetrics } from '@sorare-overlay/shared';
import { describe, expect, it, vi } from 'vitest';
import type { SorareGraphqlClient } from '../graphql/client.js';
import { SorareDataSource } from '../graphql/sorare-data-source.js';
import type {
  PlayerNameResolutionCache,
  SourcePlayerRequest,
} from '../services/data-source.js';

describe('SorareDataSource player-name resolution', () => {
  it('resolves direct slug candidates before using individual Sorare searches and caches them', async () => {
    const players = {
      'Tim Ream': { slug: 'tim-ream', displayName: 'Tim Ream', position: 'Defender' },
      'Sam Surridge': {
        slug: 'sam-surridge',
        displayName: 'Samuel Surridge',
        position: 'Forward',
      },
    } as const;
    const request = vi.fn(async (_document: unknown, variables: { query?: string; slugs?: string[] }) => {
      if (variables.slugs) {
        return { players: [{ __typename: 'Player', ...players['Tim Ream'] }] };
      }
      return {
        searchPlayers: {
          hits: [{ player: players[variables.query as keyof typeof players] }],
        },
      };
    });
    const client = { request } as unknown as SorareGraphqlClient;
    const source = new SorareDataSource(client, 25);

    await expect(source.resolvePlayerNames(['Tim Ream', 'Sam Surridge'])).resolves.toEqual([
      { slug: 'tim-ream' },
      { slug: 'sam-surridge' },
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(([, variables]) => variables)).toEqual([
      { slugs: ['tim-ream', 'sam-surridge'] },
      { query: 'Sam Surridge' },
    ]);

    await source.resolvePlayerNames(['Tim Ream', 'Sam Surridge']);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('resolves accented Sorare card names through a diacritic-safe slug candidate', async () => {
    const request = vi.fn(
      async (_document: unknown, variables: { query?: string; slugs?: string[] }) => {
        if (variables.query) throw new Error('Full-text search must not run');
        return {
          players: [
            {
              __typename: 'Player',
              slug: 'nicolas-fernandez-mercau',
              displayName: 'Nicolás Fernández-Mercau',
              position: 'Midfielder',
            },
          ],
        };
      },
    );
    const source = new SorareDataSource(
      { request } as unknown as SorareGraphqlClient,
      25,
    );

    await expect(
      source.resolvePlayerNames(['Nicolás Fernández-Mercau']),
    ).resolves.toEqual([{ slug: 'nicolas-fernandez-mercau' }]);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1]).toEqual({
      slugs: ['nicolas-fernandez-mercau'],
    });
  });

  it('keeps resolved players when another full-text fallback times out', async () => {
    const request = vi.fn(
      async (_document: unknown, variables: { query?: string; slugs?: string[] }) => {
        if (variables.slugs) {
          return {
            players: [
              {
                __typename: 'Player',
                slug: 'tim-ream',
                displayName: 'Tim Ream',
                position: 'Defender',
              },
            ],
          };
        }
        throw new Error('Sorare search timed out');
      },
    );
    const source = new SorareDataSource(
      { request } as unknown as SorareGraphqlClient,
      25,
    );

    await expect(
      source.resolvePlayerNames(['Tim Ream', 'Slow Player']),
    ).resolves.toEqual([{ slug: 'tim-ream' }]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('uses Sorare search and the concrete card position for ambiguous names', async () => {
    const request = vi.fn(async (_document: unknown, variables: { query?: string }) => {
      if (variables.query === 'Diego Luna') {
        return {
          searchPlayers: {
            hits: [
              {
                player: {
                  slug: 'diego-luna-2003-09-07',
                  displayName: 'Diego Luna',
                  position: 'Midfielder',
                },
              },
            ],
          },
        };
      }
      return {
        searchPlayers: {
          hits: [
            {
              player: {
                slug: 'joaquin-pereyra',
                displayName: 'Joaquín Pereyra',
                position: 'Defender',
              },
            },
            {
              player: {
                slug: 'joaquin-nicolas-pereyra',
                displayName: 'Joaquín Pereyra',
                position: 'Midfielder',
              },
            },
          ],
        },
      };
    });
    const client = { request } as unknown as SorareGraphqlClient;
    const source = new SorareDataSource(client, 25);
    const positions = {
      'Diego Luna': 'Midfielder',
      'Joaquin Pereyra': 'Midfielder',
    } as const;

    await expect(
      source.resolvePlayerNames(['Diego Luna', 'Joaquin Pereyra'], positions),
    ).resolves.toEqual([
      { slug: 'diego-luna-2003-09-07', position: 'Midfielder' },
      { slug: 'joaquin-nicolas-pereyra', position: 'Midfielder' },
    ]);
    expect(request).toHaveBeenCalledTimes(3);

    await source.resolvePlayerNames(['Diego Luna', 'Joaquin Pereyra'], positions);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('keeps the card position when Sorare search only exposes another profile position', async () => {
    const request = vi.fn(async () => ({
      searchPlayers: {
        hits: [
          {
            player: {
              slug: 'ivan-dario-angulo-cortes',
              displayName: 'Iván Angulo',
              position: 'Midfielder',
            },
          },
        ],
      },
      searchCards: { hits: [] },
    }));
    const source = new SorareDataSource(
      { request } as unknown as SorareGraphqlClient,
      25,
    );

    await expect(
      source.resolvePlayerNames(
        ['Ivan Angulo'],
        { 'Ivan Angulo': 'Forward' },
      ),
    ).resolves.toEqual([
      { slug: 'ivan-dario-angulo-cortes', position: 'Forward' },
    ]);
  });

  it('reuses a generic cached name after a stale position-specific miss', async () => {
    const cache: PlayerNameResolutionCache = {
      get: vi.fn(async (_name, position) =>
        position
          ? null
          : { slug: 'bryan-josias-ramirez-leon', position: 'Midfielder' },
      ),
      set: vi.fn(),
    };
    const request = vi.fn();
    const source = new SorareDataSource(
      { request } as unknown as SorareGraphqlClient,
      25,
      false,
      86_400_000,
      true,
      cache,
    );

    await expect(
      source.resolvePlayerNames(
        ['Bryan Ramirez'],
        { 'Bryan Ramirez': 'Forward' },
      ),
    ).resolves.toEqual([
      { slug: 'bryan-josias-ramirez-leon', position: 'Forward' },
    ]);
    expect(request).not.toHaveBeenCalled();
  });

  it('falls back to card search when player search misses a shortened display name', async () => {
    const request = vi.fn(async () => ({
      searchPlayers: {
        hits: [
          {
            player: {
              slug: 'luca-koleosho',
              displayName: 'Luca Koleosho',
              position: 'Forward',
            },
          },
        ],
      },
      searchCards: {
        hits: [
          {
            card: {
              __typename: 'Card',
              anyPlayer: {
                __typename: 'Player',
                slug: 'lucas-adrian-hoyos',
                displayName: 'Lucas Hoyos',
                position: 'Goalkeeper',
              },
            },
          },
        ],
      },
    }));
    const client = { request } as unknown as SorareGraphqlClient;
    const source = new SorareDataSource(client, 25);

    await expect(
      source.resolvePlayerNames(
        ['Lucas Hoyos'],
        { 'Lucas Hoyos': 'Goalkeeper' },
      ),
    ).resolves.toEqual([
      { slug: 'lucas-adrian-hoyos', position: 'Goalkeeper' },
    ]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('keeps anonymous L10 batches below Sorare\'s complexity limit', async () => {
    const request = vi.fn(async () => ({ players: [] }));
    const client = { request } as unknown as SorareGraphqlClient;
    const source = new SorareDataSource(client, 25);
    const players = Array.from({ length: 7 }, (_, index) => ({
      slug: `forward-${index + 1}`,
      position: 'Forward' as const,
    }));

    await source.fetchPlayers(players);

    expect(request).toHaveBeenCalledTimes(3);
    expect(
      request.mock.calls.map(([, variables]) =>
        (variables as { slugs: string[] }).slugs.length,
      ),
    ).toEqual([3, 3, 1]);
  });

  it('temporarily caches unresolved names to avoid repeated anonymous requests', async () => {
    const request = vi.fn(async (_document: unknown, variables: { slugs?: string[] }) =>
      variables.slugs ? { players: [] } : { searchPlayers: { hits: [] } },
    );
    const client = { request } as unknown as SorareGraphqlClient;
    const source = new SorareDataSource(client, 25);

    await expect(source.resolvePlayerNames(['Unknown Player'])).resolves.toEqual([]);
    expect(request).toHaveBeenCalledTimes(2);

    await expect(source.resolvePlayerNames(['Unknown Player'])).resolves.toEqual([]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('reuses a persistent name resolution across stateless data-source instances', async () => {
    let stored: SourcePlayerRequest | null | undefined;
    const cache: PlayerNameResolutionCache = {
      get: vi.fn(async () => stored),
      set: vi.fn(async (_name, _position, value) => {
        stored = value;
      }),
    };
    const firstRequest = vi.fn(async () => ({
      searchPlayers: {
        hits: [
          {
            player: {
              slug: 'diego-luna-2003-09-07',
              displayName: 'Diego Luna',
              position: 'Midfielder',
            },
          },
        ],
      },
    }));
    const positions = { 'Diego Luna': 'Midfielder' } as const;
    const first = new SorareDataSource(
      { request: firstRequest } as unknown as SorareGraphqlClient,
      25,
      false,
      86_400_000,
      true,
      cache,
    );

    await expect(first.resolvePlayerNames(['Diego Luna'], positions)).resolves.toEqual([
      { slug: 'diego-luna-2003-09-07', position: 'Midfielder' },
    ]);
    expect(firstRequest).toHaveBeenCalledTimes(2);

    const secondRequest = vi.fn();
    const second = new SorareDataSource(
      { request: secondRequest } as unknown as SorareGraphqlClient,
      25,
      false,
      86_400_000,
      true,
      cache,
    );
    await expect(second.resolvePlayerNames(['Diego Luna'], positions)).resolves.toEqual([
      { slug: 'diego-luna-2003-09-07', position: 'Midfielder' },
    ]);
    expect(secondRequest).not.toHaveBeenCalled();
  });

  it('converts Sorare clean-sheet decimal odds to implied probability', async () => {
    const request = vi.fn(async () => ({
      players: [
        {
          __typename: 'Player',
          slug: 'angus-gunn',
          displayName: 'Angus Gunn',
          position: 'Goalkeeper',
          activeClub: { id: 'san-jose' },
          nextGame: {
            __typename: 'Game',
            date: '2026-07-23T02:30:00Z',
            homeTeam: { id: 'san-jose', shortName: 'San Jose' },
            awayTeam: { id: 'orlando', shortName: 'Orlando' },
            homeStats: {
              __typename: 'FootballTeamGameStats',
              cleanSheetOdds: 3.45,
              winOddsBasisPoints: 5699,
              drawOddsBasisPoints: 2201,
              loseOddsBasisPoints: 2100,
            },
            awayStats: null,
          },
          playerGameScores: [],
        },
      ],
    }));
    const client = { request } as unknown as SorareGraphqlClient;
    const source = new SorareDataSource(client, 25);

    const [stats] = await source.fetchPlayers([
      { slug: 'angus-gunn', position: 'Goalkeeper' },
    ]);

    expect(stats?.nextGame?.cleanSheetProbability).toBeCloseTo(1 / 3.45, 6);
    expect(stats?.nextGame?.matchProbabilities).toEqual({
      win: 0.5699,
      draw: 0.2201,
      loss: 0.21,
    });
    expect(stats?.nextGame).toMatchObject({
      homeTeamName: 'San Jose',
      awayTeamName: 'Orlando',
      playerTeamName: 'San Jose',
      opponentTeamName: 'Orlando',
    });
  });

  it('orders fixture names from an away player team perspective', async () => {
    const request = vi.fn(async () => ({
      players: [
        {
          __typename: 'Player',
          slug: 'adrian-andres-cubas',
          displayName: 'Andrés Cubas',
          position: 'Midfielder',
          activeClub: { id: 'vancouver' },
          nextGame: {
            __typename: 'Game',
            date: '2026-07-27T01:00:00Z',
            homeTeam: { id: 'minnesota', shortName: 'Minnesota United' },
            awayTeam: { id: 'vancouver', shortName: 'Vancouver Whitecaps' },
            homeStats: null,
            awayStats: {
              __typename: 'FootballTeamGameStats',
              cleanSheetOdds: 4,
              winOddsBasisPoints: 4900,
              drawOddsBasisPoints: 2500,
              loseOddsBasisPoints: 2600,
            },
          },
          playerGameScores: [],
        },
      ],
    }));
    const source = new SorareDataSource(
      { request } as unknown as SorareGraphqlClient,
      25,
    );

    const [stats] = await source.fetchPlayers([
      { slug: 'adrian-andres-cubas', position: 'Midfielder' },
    ]);

    expect(stats?.nextGame).toMatchObject({
      homeTeamName: 'Minnesota United',
      awayTeamName: 'Vancouver Whitecaps',
      playerTeamName: 'Vancouver Whitecaps',
      opponentTeamName: 'Minnesota United',
      matchProbabilities: { win: 0.49, draw: 0.25, loss: 0.26 },
    });
  });

  it('prefers the primary card position over other player position fields', async () => {
    const request = vi.fn(async () => ({
      players: [
        {
          __typename: 'Player',
          slug: 'nicolas-fernandez-mercau',
          displayName: 'Nicolás Fernández-Mercau',
          position: 'Defender',
          cardPositions: ['Midfielder', 'Defender'],
          anyPositions: ['Defender'],
          activeClub: { id: 'new-york-city' },
          nextGame: null,
          playerGameScores: [
            {
              __typename: 'PlayerGameScore',
              positionTyped: 'Midfielder',
              allAroundScore: 15.13,
              footballGame: {
                date: '2026-07-22T23:30:00Z',
                lowCoverage: false,
              },
              footballPlayerGameStats: {
                goals: 0,
                minsPlayed: 90,
                cleanSheet60: 0,
                playedInGame: true,
              },
            },
          ],
        },
      ],
    }));
    const source = new SorareDataSource(
      { request } as unknown as SorareGraphqlClient,
      25,
    );

    const [player] = await source.fetchPlayers([
      { slug: 'nicolas-fernandez-mercau' },
    ]);

    expect(request).toHaveBeenCalledWith(
      expect.anything(),
      { slugs: ['nicolas-fernandez-mercau'], position: null },
    );
    expect(player?.position).toBe('Midfielder');
    expect(player?.appearances[0]?.position).toBe('Midfielder');
    expect(player?.appearances[0]?.allAroundScore).toBe(15.13);
  });

  it('reloads scores for the primary card position when the default score window differs', async () => {
    const request = vi.fn(
      async (_document: unknown, variables: { slug?: string }) =>
        variables.slug
          ? {
              anyPlayer: {
                __typename: 'Player',
                slug: 'matti-peltola',
                pastGames: {
                  nodes: [
                    {
                      id: 'midfielder-game',
                      date: '2026-07-23T00:30:00Z',
                      lowCoverage: false,
                      playerGameScore: {
                        __typename: 'PlayerGameScore',
                        positionTyped: 'Midfielder',
                        allAroundScore: 6.2,
                        footballPlayerGameStats: {
                          goals: 0,
                          minsPlayed: 37,
                          cleanSheet60: 0,
                          playedInGame: true,
                        },
                      },
                    },
                  ],
                },
              },
            }
          : {
              players: [
                {
                  __typename: 'Player',
                  slug: 'matti-peltola',
                  displayName: 'Matti Peltola',
                  position: 'Defender',
                  cardPositions: ['Midfielder', 'Defender'],
                  anyPositions: ['Defender'],
                  activeClub: null,
                  nextGame: null,
                  playerGameScores: [
                    {
                      __typename: 'PlayerGameScore',
                      positionTyped: 'Defender',
                      allAroundScore: 99,
                      footballGame: {
                        id: 'defender-game',
                        date: '2026-07-20T00:30:00Z',
                        lowCoverage: false,
                      },
                      footballPlayerGameStats: {
                        goals: 0,
                        minsPlayed: 90,
                        cleanSheet60: 1,
                        playedInGame: true,
                      },
                    },
                  ],
                },
              ],
            },
    );
    const source = new SorareDataSource(
      { request } as unknown as SorareGraphqlClient,
      25,
    );

    const [player] = await source.fetchPlayers([{ slug: 'matti-peltola' }]);

    expect(request).toHaveBeenCalledTimes(2);
    expect(player?.position).toBe('Midfielder');
    expect(player?.appearances).toEqual([
      expect.objectContaining({
        position: 'Midfielder',
        allAroundScore: 6.2,
        minsPlayed: 37,
      }),
    ]);
  });

  it('expands a DNP-heavy score window to the last ten actual appearances', async () => {
    const recentScores = Array.from({ length: 15 }, (_, index) => {
      const played = index >= 5 && index <= 11;
      return {
        __typename: 'PlayerGameScore',
        positionTyped: 'Forward',
        allAroundScore: played ? 99 : 0,
        footballGame: {
          date: `2026-05-${String(24 - index).padStart(2, '0')}T00:00:00Z`,
          lowCoverage: false,
        },
        footballPlayerGameStats: {
          goals: played ? 1 : null,
          minsPlayed: played ? 90 : null,
          cleanSheet60: 0,
          playedInGame: played,
        },
      };
    });
    const historyNodes = Array.from({ length: 10 }, (_, index) => ({
      date: `2026-04-${String(30 - index).padStart(2, '0')}T00:00:00Z`,
      lowCoverage: false,
      playerGameScore: {
        __typename: 'PlayerGameScore',
        positionTyped: 'Forward',
        allAroundScore: index + 1,
        footballPlayerGameStats: {
          goals: index < 3 ? 1 : null,
          minsPlayed: 90,
          cleanSheet60: 0,
          playedInGame: true,
        },
      },
    }));
    const request = vi.fn(async (_document: unknown, variables: { slug?: string }) =>
      variables.slug
        ? {
            anyPlayer: {
              __typename: 'Player',
              slug: 'timo-werner',
              pastGames: { nodes: historyNodes },
            },
          }
        : {
            players: [
              {
                __typename: 'Player',
                slug: 'timo-werner',
                displayName: 'Timo Werner',
                position: 'Forward',
                activeClub: null,
                nextGame: null,
                playerGameScores: recentScores,
              },
            ],
          },
    );
    const source = new SorareDataSource(
      { request } as unknown as SorareGraphqlClient,
      25,
    );

    const [player] = await source.fetchPlayers([
      { slug: 'timo-werner', position: 'Forward' },
    ]);
    const metrics = calculatePlayerMetrics(player?.appearances ?? [], 'Forward', {
      excludeLowCoverage: true,
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(player?.appearances).toHaveLength(10);
    expect(metrics.aaL10).toEqual({ value: 5.5, sampleSize: 10 });
    expect(metrics.goalL10).toEqual({ value: 0.3, sampleSize: 10 });
  });

  it('loads up to forty assist appearances only when explicitly requested', async () => {
    const historyNodes = Array.from({ length: 40 }, (_, index) => ({
      id: `history-${index}`,
      date: new Date(Date.UTC(2026, 6, 24 - index)).toISOString(),
      lowCoverage: false,
      playerGameScore: {
        __typename: 'PlayerGameScore',
        positionTyped: 'Forward',
        allAroundScore: 8 + (index % 5),
        footballPlayerGameStats: {
          goals: 0,
          goalAssist: index % 4 === 0 ? 1 : 0,
          minsPlayed: 90,
          cleanSheet60: 0,
          playedInGame: true,
        },
      },
    }));
    const recentScores = Array.from({ length: 15 }, (_, index) => ({
      __typename: 'PlayerGameScore',
      positionTyped: 'Forward',
      allAroundScore: 10,
      footballGame: {
        date: new Date(Date.UTC(2026, 6, 24 - index)).toISOString(),
        lowCoverage: false,
      },
      footballPlayerGameStats: {
        goals: 0,
        minsPlayed: 90,
        cleanSheet60: 0,
        playedInGame: true,
      },
    }));
    const request = vi.fn(
      async (_document: unknown, variables: { slug?: string }) =>
        variables.slug
          ? {
              anyPlayer: {
                __typename: 'Player',
                slug: 'assist-history-player',
                pastGames: { nodes: historyNodes },
              },
            }
          : {
              players: [
                {
                  __typename: 'Player',
                  slug: 'assist-history-player',
                  displayName: 'Assist History Player',
                  position: 'Forward',
                  activeClub: null,
                  nextGame: null,
                  playerGameScores: recentScores,
                },
              ],
            },
    );
    const source = new SorareDataSource(
      { request } as unknown as SorareGraphqlClient,
      25,
    );

    const [player] = await source.fetchPlayers([
      {
        slug: 'assist-history-player',
        position: 'Forward',
        includeHistoricalAssists: true,
      },
    ]);

    expect(request).toHaveBeenCalledTimes(2);
    expect(player?.appearances).toHaveLength(40);
    expect(
      player?.appearances.filter((appearance) => appearance.assists === 1),
    ).toHaveLength(10);
  });

  it('refreshes next fixtures with a lightweight query instead of reloading L10 history', async () => {
    const request = vi.fn(
      async (_document: unknown, variables: { slugs: string[] }) => ({
        players: variables.slugs.map((slug) => ({
          __typename: 'Player',
          slug,
          activeClub: { id: `club-${slug}` },
          nextGame: {
            __typename: 'Game',
            date: '2026-08-01T18:00:00Z',
            homeTeam: { id: `club-${slug}`, shortName: 'Home' },
            awayTeam: { id: 'away-club', shortName: 'Away' },
            homeStats: {
              __typename: 'FootballTeamGameStats',
              cleanSheetOdds: 2.5,
              winOddsBasisPoints: 5_500,
              drawOddsBasisPoints: 2_500,
              loseOddsBasisPoints: 2_000,
            },
            awayStats: null,
          },
        })),
      }),
    );
    const source = new SorareDataSource(
      { request } as unknown as SorareGraphqlClient,
      25,
    );
    const players = Array.from({ length: 7 }, (_, index) => ({
      slug: `fixture-player-${index + 1}`,
      position: 'Midfielder' as const,
    }));

    const fixtures = await source.fetchNextGames(players);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      expect.anything(),
      { slugs: players.map(({ slug }) => slug) },
    );
    expect(fixtures).toHaveLength(7);
    expect(fixtures[0]).toEqual({
      slug: 'fixture-player-1',
      nextGame: {
        date: '2026-08-01T18:00:00Z',
        homeTeamName: 'Home',
        awayTeamName: 'Away',
        playerTeamName: 'Home',
        opponentTeamName: 'Away',
        cleanSheetProbability: 0.4,
        matchProbabilities: { win: 0.55, draw: 0.25, loss: 0.2 },
      },
    });
  });
});
