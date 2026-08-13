import { calculatePlayerMetrics } from '@sorare-overlay/shared';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../errors.js';
import type { SorareGraphqlClient } from '../graphql/client.js';
import { SorareDataSource } from '../graphql/sorare-data-source.js';
import type {
  PlayerNameResolutionCache,
  SourcePlayerRequest,
} from '../services/data-source.js';

describe('SorareDataSource player-name resolution', () => {
  it('returns persistent name mappings without contacting Sorare in cache-only mode', async () => {
    const cache: PlayerNameResolutionCache = {
      get: vi.fn(async (name) =>
        name === 'Cached Player'
          ? {
              slug: 'cached-player',
              position: 'Midfielder',
              teamSlug: 'cached-club',
            }
          : undefined,
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
        ['Cached Player', 'Cold Player'],
        undefined,
        { cacheOnly: true },
      ),
    ).resolves.toEqual([
      {
        slug: 'cached-player',
        teamSlug: 'cached-club',
        resolvedFromName: 'Cached Player',
      },
    ]);
    expect(request).not.toHaveBeenCalled();
  });

  it('resolves direct slug candidates before using individual Sorare searches and caches them', async () => {
    const players = {
      'Tim Ream': {
        slug: 'tim-ream',
        displayName: 'Tim Ream',
        position: 'Defender',
        activeClub: { slug: 'charlotte-fc-charlotte-north-carolina' },
      },
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
      {
        slug: 'tim-ream',
        teamSlug: 'charlotte-fc-charlotte-north-carolina',
        resolvedFromName: 'Tim Ream',
        nameResolution: 'direct',
      },
      {
        slug: 'sam-surridge',
        resolvedFromName: 'Sam Surridge',
        nameResolution: 'search',
      },
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
    ).resolves.toEqual([
      {
        slug: 'nicolas-fernandez-mercau',
        resolvedFromName: 'Nicolás Fernández-Mercau',
        nameResolution: 'direct',
      },
    ]);
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
    ).resolves.toEqual([
      {
        slug: 'tim-ream',
        resolvedFromName: 'Tim Ream',
        nameResolution: 'direct',
      },
    ]);
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
      {
        slug: 'diego-luna-2003-09-07',
        position: 'Midfielder',
        resolvedFromName: 'Diego Luna',
        nameResolution: 'search',
      },
      {
        slug: 'joaquin-nicolas-pereyra',
        position: 'Midfielder',
        resolvedFromName: 'Joaquin Pereyra',
        nameResolution: 'search',
      },
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
      {
        slug: 'ivan-dario-angulo-cortes',
        position: 'Forward',
        resolvedFromName: 'Ivan Angulo',
        nameResolution: 'search',
      },
    ]);
  });

  it('reuses a compatible generic cached name after a stale position-specific miss', async () => {
    const cache: PlayerNameResolutionCache = {
      get: vi.fn(async (_name, position) =>
        position
          ? null
          : { slug: 'bryan-josias-ramirez-leon', position: 'Forward' },
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
      {
        slug: 'bryan-josias-ramirez-leon',
        position: 'Forward',
        resolvedFromName: 'Bryan Ramirez',
      },
    ]);
    expect(request).not.toHaveBeenCalled();
  });

  it('does not reuse a generic player with the wrong position for an ambiguous card name', async () => {
    const cache: PlayerNameResolutionCache = {
      get: vi.fn(async (_name, position) =>
        position
          ? null
          : {
              slug: 'ederson-jose-dos-santos-lourenco-da-silva',
              position: 'Midfielder',
            },
      ),
      set: vi.fn(),
    };
    const request = vi.fn(
      async (
        _document: unknown,
        variables: { query?: string; slugs?: string[] },
      ) => {
        if (variables.slugs) return { players: [] };
        return {
          searchPlayers: {
            hits: [
              {
                player: {
                  slug: 'ederson-jose-dos-santos-lourenco-da-silva',
                  displayName: 'Éderson',
                  position: 'Midfielder',
                },
              },
              {
                player: {
                  slug: 'ederson-santana-de-moraes',
                  displayName: 'Ederson',
                  position: 'Goalkeeper',
                },
              },
            ],
          },
          searchCards: { hits: [] },
        };
      },
    );
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
        ['Ederson'],
        { Ederson: 'Goalkeeper' },
      ),
    ).resolves.toEqual([
      {
        slug: 'ederson-santana-de-moraes',
        position: 'Goalkeeper',
        resolvedFromName: 'Ederson',
        nameResolution: 'search',
      },
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(cache.set).toHaveBeenCalledWith(
      'Ederson',
      'Goalkeeper',
      {
        slug: 'ederson-santana-de-moraes',
        position: 'Goalkeeper',
        nameResolution: 'search',
      },
    );
  });

  it('uses the highlighted card team to resolve same-name players without a DOM position', async () => {
    const wrongPlayer = {
      slug: 'joaquin-pereyra',
      displayName: 'Joaquín Pereyra',
      position: 'Defender',
      activeClub: { slug: 'estudiantes-la-plata-buenos-aires' },
    };
    const correctPlayer = {
      slug: 'joaquin-nicolas-pereyra',
      displayName: 'Joaquín Pereyra',
      position: 'Midfielder',
      activeClub: {
        slug: 'minnesota-united',
      },
    };
    const request = vi.fn(async (_document: unknown, variables: { query?: string; slugs?: string[] }) => {
      if (variables.slugs) {
        return { players: [{ __typename: 'Player', ...wrongPlayer }] };
      }
      return {
        searchPlayers: {
          hits: [
            { player: wrongPlayer },
            { player: correctPlayer },
          ],
        },
        searchCards: { hits: [] },
      };
    });
    const source = new SorareDataSource(
      { request } as unknown as SorareGraphqlClient,
      25,
    );

    await expect(
      source.resolvePlayerNames(['Joaquín Pereyra'], undefined, {
        teamSlugs: {
          'Joaquín Pereyra':
            'minnesota-united-minneapolis-saint-paul-minnesota',
        },
      }),
    ).resolves.toEqual([
      {
        slug: 'joaquin-nicolas-pereyra',
        teamSlug: 'minnesota-united',
        resolvedFromName: 'Joaquín Pereyra',
        nameResolution: 'search',
      },
    ]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('prefers an exact display-name hit over accent-insensitive alternatives', async () => {
    const request = vi.fn(
      async (
        _document: unknown,
        variables: { query?: string; slugs?: string[] },
      ) => {
        if (variables.slugs) return { players: [] };
        return {
          searchPlayers: {
            hits: [
              {
                player: {
                  slug: 'ederson-jose-dos-santos-lourenco-da-silva',
                  displayName: 'Éderson',
                  position: 'Midfielder',
                },
              },
              {
                player: {
                  slug: 'ederson-santana-de-moraes',
                  displayName: 'Ederson',
                  position: 'Goalkeeper',
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
                    slug: 'ederson-santana-de-moraes',
                    displayName: 'Ederson',
                    position: 'Goalkeeper',
                  },
                },
              },
              {
                card: {
                  __typename: 'Card',
                  anyPlayer: {
                    __typename: 'Player',
                    slug: 'ederson-jose-dos-santos-lourenco-da-silva',
                    displayName: 'Éderson',
                    position: 'Midfielder',
                  },
                },
              },
              {
                card: {
                  __typename: 'Card',
                  anyPlayer: {
                    __typename: 'Player',
                    slug: 'ederson-santana-de-moraes',
                    displayName: 'Ederson',
                    position: 'Goalkeeper',
                  },
                },
              },
            ],
          },
        };
      },
    );
    const source = new SorareDataSource(
      { request } as unknown as SorareGraphqlClient,
      25,
    );

    await expect(source.resolvePlayerNames(['Ederson'])).resolves.toEqual([
      {
        slug: 'ederson-santana-de-moraes',
        resolvedFromName: 'Ederson',
        nameResolution: 'search',
      },
    ]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('prefers Sorare player relevance over historical card volume for identical names', async () => {
    const request = vi.fn(
      async (
        _document: unknown,
        variables: { query?: string; slugs?: string[] },
      ) => {
        if (variables.slugs) return { players: [] };
        const goalkeeperCard = {
          card: {
            __typename: 'Card',
            anyPlayer: {
              __typename: 'Player',
              slug: 'andre-nogueira-gomes',
              displayName: 'André Gomes',
              position: 'Goalkeeper',
            },
          },
        };
        return {
          searchPlayers: {
            hits: [
              {
                player: {
                  slug: 'andre-filipe-tavares-gomes',
                  displayName: 'André Gomes',
                  position: 'Midfielder',
                },
              },
              {
                player: goalkeeperCard.card.anyPlayer,
              },
            ],
          },
          searchCards: {
            hits: [
              goalkeeperCard,
              goalkeeperCard,
              goalkeeperCard,
              {
                card: {
                  __typename: 'Card',
                  anyPlayer: {
                    __typename: 'Player',
                    slug: 'andre-filipe-tavares-gomes',
                    displayName: 'André Gomes',
                    position: 'Midfielder',
                  },
                },
              },
            ],
          },
        };
      },
    );
    const source = new SorareDataSource(
      { request } as unknown as SorareGraphqlClient,
      25,
    );

    await expect(source.resolvePlayerNames(['André Gomes'])).resolves.toEqual([
      {
        slug: 'andre-filipe-tavares-gomes',
        resolvedFromName: 'André Gomes',
        nameResolution: 'search',
      },
    ]);
    expect(request).toHaveBeenCalledTimes(2);
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
      {
        slug: 'lucas-adrian-hoyos',
        position: 'Goalkeeper',
        resolvedFromName: 'Lucas Hoyos',
        nameResolution: 'search',
      },
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
      {
        slug: 'diego-luna-2003-09-07',
        position: 'Midfielder',
        resolvedFromName: 'Diego Luna',
        nameResolution: 'search',
      },
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
      {
        slug: 'diego-luna-2003-09-07',
        position: 'Midfielder',
        resolvedFromName: 'Diego Luna',
        nameResolution: 'search',
      },
    ]);
    expect(secondRequest).not.toHaveBeenCalled();
  });

  it('force-searches and replaces a stale direct-slug name resolution', async () => {
    const cache: PlayerNameResolutionCache = {
      get: vi.fn(async () => ({
        slug: 'david-ruiz',
        position: 'Midfielder',
      })),
      set: vi.fn(),
    };
    const request = vi.fn(
      async (_document: unknown, variables: { query?: string; slugs?: string[] }) => {
        if (variables.slugs) {
          throw new Error('Forced resolution must skip direct slug candidates');
        }
        return {
          searchPlayers: {
            hits: [
              {
                player: {
                  slug: 'david-ruiz-2004-02-08',
                  displayName: 'David Ruíz',
                  position: 'Midfielder',
                },
              },
            ],
          },
          searchCards: { hits: [] },
        };
      },
    );
    const source = new SorareDataSource(
      { request } as unknown as SorareGraphqlClient,
      25,
      false,
      86_400_000,
      true,
      cache,
    );
    const positions = { 'David Ruiz': 'Midfielder' } as const;

    await expect(
      source.resolvePlayerNames(
        ['David Ruiz'],
        positions,
        { forceSearch: true },
      ),
    ).resolves.toEqual([
      {
        slug: 'david-ruiz-2004-02-08',
        position: 'Midfielder',
        resolvedFromName: 'David Ruiz',
        nameResolution: 'search',
      },
    ]);
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      expect.anything(),
      { query: 'David Ruiz' },
    );
    expect(cache.set).toHaveBeenCalledWith(
      'David Ruiz',
      'Midfielder',
      {
        slug: 'david-ruiz-2004-02-08',
        position: 'Midfielder',
        nameResolution: 'search',
      },
    );
  });

  it('converts Sorare clean-sheet decimal odds to implied probability', async () => {
    const request = vi.fn(async () => ({
      players: [
        {
          __typename: 'Player',
          slug: 'angus-gunn',
          displayName: 'Angus Gunn',
          position: 'Goalkeeper',
          activeClub: { id: 'san-jose', slug: 'san-jose-earthquakes' },
          nextGame: {
            __typename: 'Game',
            date: '2026-07-23T02:30:00Z',
            homeTeam: {
              id: 'san-jose',
              slug: 'san-jose-earthquakes',
              shortName: 'San Jose',
            },
            awayTeam: {
              id: 'orlando',
              slug: 'orlando-city',
              shortName: 'Orlando',
            },
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
      playerTeamSlug: 'san-jose-earthquakes',
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
          activeClub: { id: 'vancouver', slug: 'vancouver-whitecaps' },
          nextGame: {
            __typename: 'Game',
            date: '2026-07-27T01:00:00Z',
            homeTeam: {
              id: 'minnesota',
              slug: 'minnesota-united',
              shortName: 'Minnesota United',
            },
            awayTeam: {
              id: 'vancouver',
              slug: 'vancouver-whitecaps',
              shortName: 'Vancouver Whitecaps',
            },
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
      playerTeamSlug: 'vancouver-whitecaps',
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

  it('marks appearances from the active club so AA excludes other teams', async () => {
    const request = vi.fn(async () => ({
      players: [
        {
          __typename: 'Player',
          slug: 'ederson',
          displayName: 'Ederson',
          position: 'Goalkeeper',
          cardPositions: ['Goalkeeper'],
          anyPositions: ['Goalkeeper'],
          activeClub: { id: 'fenerbahce' },
          nextGame: null,
          playerGameScores: Array.from({ length: 12 }, (_, index) => ({
            __typename: 'PlayerGameScore',
            positionTyped: 'Goalkeeper',
            allAroundScore: index < 2 ? 50 : 10,
            footballGame: {
              id: `game-${index}`,
              date: new Date(Date.UTC(2026, 6, 24 - index)).toISOString(),
              lowCoverage: false,
            },
            footballPlayerGameStats: {
              anyTeam: { id: index < 2 ? 'brazil' : 'fenerbahce' },
              goals: 0,
              minsPlayed: 90,
              cleanSheet60: 0,
              playedInGame: true,
            },
          })),
        },
      ],
    }));
    const source = new SorareDataSource(
      { request } as unknown as SorareGraphqlClient,
      25,
    );

    const [player] = await source.fetchPlayers([
      { slug: 'ederson', position: 'Goalkeeper' },
    ]);
    const metrics = calculatePlayerMetrics(
      player?.appearances ?? [],
      'Goalkeeper',
      { excludeLowCoverage: true },
    );

    expect(player?.appearances).toHaveLength(12);
    expect(
      player?.appearances.filter(
        (appearance) => appearance.currentClubGame === false,
      ),
    ).toHaveLength(2);
    expect(metrics.aaL10).toEqual({ value: 10, sampleSize: 10 });
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
      async (
        _document: unknown,
        variables: { slug?: string; after?: string | null },
      ) =>
        variables.slug
          ? {
              anyPlayer: {
                __typename: 'Player',
                slug: 'assist-history-player',
                pastGames: {
                  nodes: variables.after
                    ? historyNodes.slice(20, 40)
                    : historyNodes.slice(0, 20),
                  pageInfo: variables.after
                    ? { hasNextPage: false, endCursor: null }
                    : { hasNextPage: true, endCursor: 'history-page-2' },
                },
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

    expect(request).toHaveBeenCalledTimes(3);
    expect(player?.appearances).toHaveLength(40);
    expect(
      player?.appearances.filter((appearance) => appearance.assists === 1),
    ).toHaveLength(10);
  });

  it('returns a partial base window without waiting for extra history', async () => {
    const request = vi.fn(
      async (_document: unknown, variables: { slug?: string }) => {
        if (variables.slug) {
          throw new Error('Base loading must not request appearance history');
        }
        return {
          players: [
            {
              __typename: 'Player',
              slug: 'cold-base-player',
              displayName: 'Cold Base Player',
              position: 'Midfielder',
              activeClub: null,
              nextGame: null,
              playerGameScores: Array.from({ length: 15 }, (_, index) => ({
                __typename: 'PlayerGameScore',
                positionTyped: 'Midfielder',
                allAroundScore: index < 2 ? 12 + index : 0,
                footballGame: {
                  date: new Date(Date.UTC(2026, 6, 24 - index)).toISOString(),
                  lowCoverage: false,
                },
                footballPlayerGameStats: {
                  goals: 0,
                  minsPlayed: index < 2 ? 90 : null,
                  cleanSheet60: 0,
                  playedInGame: index < 2,
                },
              })),
            },
          ],
        };
      },
    );
    const source = new SorareDataSource(
      { request } as unknown as SorareGraphqlClient,
      25,
    );

    const [player] = await source.fetchPlayersBase?.([
      { slug: 'cold-base-player', position: 'Midfielder' },
    ]) ?? [];

    expect(request).toHaveBeenCalledOnce();
    expect(player?.historyStatus).toBe('partial');
    expect(player?.appearances).toHaveLength(2);
  });

  it('keeps other players when one appearance-history request fails', async () => {
    const recentScores = (slug: string) =>
      Array.from({ length: 15 }, (_, index) => ({
        __typename: 'PlayerGameScore',
        positionTyped: 'Forward',
        allAroundScore: index === 0 ? 7 : 0,
        footballGame: {
          date: new Date(Date.UTC(2026, 6, 24 - index)).toISOString(),
          lowCoverage: false,
        },
        footballPlayerGameStats: {
          goals: 0,
          minsPlayed: index === 0 ? 90 : null,
          cleanSheet60: 0,
          playedInGame: index === 0,
          anyTeam: { id: `club-${slug}` },
        },
      }));
    const request = vi.fn(
      async (
        _document: unknown,
        variables: { slugs?: string[]; slug?: string },
      ) => {
        if (variables.slug === 'broken-history') {
          throw new Error('One player history timed out');
        }
        if (variables.slug) {
          return {
            anyPlayer: {
              __typename: 'Player',
              slug: variables.slug,
              pastGames: {
                nodes: Array.from({ length: 10 }, (_, index) => ({
                  date: new Date(Date.UTC(2026, 5, 30 - index)).toISOString(),
                  lowCoverage: false,
                  playerGameScore: {
                    __typename: 'PlayerGameScore',
                    positionTyped: 'Forward',
                    allAroundScore: 10 + index,
                    footballPlayerGameStats: {
                      goals: 0,
                      goalAssist: 0,
                      minsPlayed: 90,
                      cleanSheet60: 0,
                      playedInGame: true,
                      anyTeam: { id: `club-${variables.slug}` },
                    },
                  },
                })),
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          };
        }
        return {
          players: (variables.slugs ?? []).map((slug) => ({
            __typename: 'Player',
            slug,
            displayName: slug,
            position: 'Forward',
            activeClub: { id: `club-${slug}` },
            nextGame: null,
            playerGameScores: recentScores(slug),
          })),
        };
      },
    );
    const source = new SorareDataSource(
      { request } as unknown as SorareGraphqlClient,
      25,
    );

    const players = await source.fetchPlayers([
      { slug: 'broken-history', position: 'Forward' },
      { slug: 'healthy-history', position: 'Forward' },
    ]);

    expect(players).toHaveLength(2);
    expect(
      players.find((player) => player.slug === 'broken-history')
        ?.historyStatus,
    ).toBe('partial');
    expect(
      players.find((player) => player.slug === 'healthy-history')
        ?.historyStatus,
    ).toBe('complete');
    expect(
      players.find((player) => player.slug === 'healthy-history')
        ?.appearances,
    ).toHaveLength(10);
  });

  it('splits a failed Sorare batch and still returns the healthy players', async () => {
    const request = vi.fn(
      async (_document: unknown, variables: { slugs: string[] }) => {
        if (variables.slugs.includes('broken-player')) {
          throw new AppError(
            502,
            'SORARE_GRAPHQL_ERROR',
            'Query has complexity which exceeds max complexity',
          );
        }
        return {
          players: variables.slugs.map((slug) => ({
            __typename: 'Player',
            slug,
            displayName: slug,
            position: 'Defender',
            activeClub: null,
            nextGame: null,
            playerGameScores: [],
          })),
        };
      },
    );
    const source = new SorareDataSource(
      { request } as unknown as SorareGraphqlClient,
      25,
    );

    const players = await source.fetchPlayers([
      { slug: 'healthy-one', position: 'Defender' },
      { slug: 'broken-player', position: 'Defender' },
      { slug: 'healthy-two', position: 'Defender' },
    ]);

    expect(players.map((player) => player.slug)).toEqual([
      'healthy-one',
      'healthy-two',
    ]);
  });

  it.each([
    ['SORARE_TIMEOUT', 'Sorare request timed out'],
    ['SORARE_HTTP_ERROR', 'Sorare API returned HTTP 429'],
  ])(
    'does not multiply transient %s batch failures into per-player requests',
    async (code, message) => {
    const request = vi.fn(async () => {
      throw new AppError(
        502,
        code,
        message,
      );
    });
    const source = new SorareDataSource(
      { request } as unknown as SorareGraphqlClient,
      25,
    );

    await expect(
      source.fetchPlayers([
        { slug: 'one', position: 'Defender' },
        { slug: 'two', position: 'Defender' },
        { slug: 'three', position: 'Defender' },
      ]),
    ).rejects.toMatchObject({ code });
    expect(request).toHaveBeenCalledOnce();
    },
  );

  it('refreshes next fixtures with a lightweight query instead of reloading L10 history', async () => {
    const request = vi.fn(
      async (_document: unknown, variables: { slugs: string[] }) => ({
        players: variables.slugs.map((slug) => ({
          __typename: 'Player',
          slug,
          activeClub: { id: `club-${slug}`, slug: `team-${slug}` },
          nextGame: {
            __typename: 'Game',
            date: '2026-08-01T18:00:00Z',
            competition: { slug: 'mlspa' },
            homeTeam: {
              id: `club-${slug}`,
              slug: `team-${slug}`,
              shortName: 'Home',
            },
            awayTeam: {
              id: 'away-club',
              slug: 'away-club',
              shortName: 'Away',
            },
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
      playerTeamSlug: 'team-fixture-player-1',
      nextGame: {
        date: '2026-08-01T18:00:00Z',
        competitionSlug: 'mlspa',
        homeTeamName: 'Home',
        awayTeamName: 'Away',
        playerTeamName: 'Home',
        opponentTeamName: 'Away',
        playerTeamSlug: 'team-fixture-player-1',
        cleanSheetProbability: 0.4,
        matchProbabilities: { win: 0.55, draw: 0.25, loss: 0.2 },
      },
    });
  });

  it('returns the Sorare-confirmed team slug when the player next game is null', async () => {
    const request = vi.fn(async () => ({
      players: [
        {
          __typename: 'Player',
          slug: 'fixture-missing-player',
          activeClub: { id: 'confirmed-club', slug: 'confirmed-club' },
          nextGame: null,
        },
      ],
    }));
    const source = new SorareDataSource(
      { request } as unknown as SorareGraphqlClient,
      25,
    );

    await expect(
      source.fetchNextGames([{ slug: 'fixture-missing-player' }]),
    ).resolves.toEqual([
      {
        slug: 'fixture-missing-player',
        playerTeamSlug: 'confirmed-club',
        nextGame: null,
      },
    ]);
  });
});
