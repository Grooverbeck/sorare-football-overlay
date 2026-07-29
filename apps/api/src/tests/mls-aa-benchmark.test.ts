import type { FootballPosition } from '@sorare-overlay/shared';
import { describe, expect, it, vi } from 'vitest';
import type { SorareGraphqlClient } from '../graphql/client.js';
import type { AppLogger } from '../logger.js';
import {
  MlsAaBenchmarkRefresher,
  StaticMlsAaBenchmarkStore,
  mlsAaContextForPlayer,
} from '../services/mls-aa-benchmark.js';

const logger: AppLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('weekly MLS AA benchmark', () => {
  it('derives deterministic position ranks and stores the new snapshot', async () => {
    const positions: FootballPosition[] = [
      'Goalkeeper',
      'Defender',
      'Midfielder',
      'Forward',
    ];
    const seeds = positions.flatMap((position) =>
      [1, 2, 3].map((rank) => ({
        slug: `${position.toLowerCase()}-${rank}`,
        displayName: `${position} ${rank}`,
        position,
        cardPositions: [position],
      })),
    );
    const positionBySlug = new Map(
      seeds.map((seed) => [seed.slug, seed.position]),
    );
    const request = vi.fn(
      async (
        _document: unknown,
        variables:
          | { first: number; after: string | null }
          | { slugs: string[]; position: FootballPosition },
      ) => {
        if ('first' in variables) {
          return {
            football: {
              competition: {
                displayName: 'Major League Soccer',
                orderedPlayers: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: seeds,
                },
              },
            },
          };
        }
        return {
          players: variables.slugs.map((slug) => {
            const position = positionBySlug.get(slug);
            const score = Number(slug.at(-1)) * 10;
            return {
              __typename: 'Player',
              slug,
              activeClub: { id: `club-${slug}` },
              playerGameScores: [
                {
                  __typename: 'PlayerGameScore',
                  positionTyped: position,
                  allAroundScore: 100,
                  footballGame: {
                    date: '2026-07-27T18:00:00.000Z',
                    lowCoverage: false,
                  },
                  footballPlayerGameStats: {
                    playedInGame: true,
                    minsPlayed: 90,
                    anyTeam: { id: `national-${slug}` },
                  },
                },
                {
                  __typename: 'PlayerGameScore',
                  positionTyped: position,
                  allAroundScore: score,
                  footballGame: {
                    date: '2026-07-26T18:00:00.000Z',
                    lowCoverage: false,
                  },
                  footballPlayerGameStats: {
                    playedInGame: true,
                    minsPlayed: 90,
                    anyTeam: { id: `club-${slug}` },
                  },
                },
              ],
            };
          }),
        };
      },
    );
    const store = new StaticMlsAaBenchmarkStore();
    const refresher = new MlsAaBenchmarkRefresher({
      client: { request } as unknown as SorareGraphqlClient,
      store,
      logger,
      minimumAppearances: 1,
      scoreBatchSize: 3,
      requestDelayMs: 0,
      now: () => Date.parse('2026-07-27T10:00:00.000Z'),
    });

    const snapshot = await refresher.run();

    expect(snapshot.asOf).toBe('2026-07-27');
    expect(snapshot.populationSize).toBe(12);
    expect(snapshot.positions.Forward.topThree.map(({ slug }) => slug)).toEqual([
      'forward-3',
      'forward-2',
      'forward-1',
    ]);
    await expect(store.get()).resolves.toEqual(snapshot);
  });

  it('creates a response-only context from the current weekly snapshot', async () => {
    const snapshot = await new StaticMlsAaBenchmarkStore().get();
    const ranked = snapshot.positions.Midfielder.topThree[0];
    expect(ranked).toBeDefined();

    const context = mlsAaContextForPlayer(snapshot, {
      slug: ranked?.slug ?? '',
      displayName: ranked?.displayName ?? '',
      position: 'Midfielder',
      aaL10: { value: ranked?.aa ?? 0, sampleSize: 10 },
      cleanSheetL10: { value: null, sampleSize: 0 },
      goalL10: { value: null, sampleSize: 0 },
      nextGame: null,
      excludedLowCoverage: 0,
    });

    expect(context).toMatchObject({
      asOf: snapshot.asOf,
      rank: 1,
      tone: 'elite',
      percentileBand: 'P90–100',
    });
  });
});
