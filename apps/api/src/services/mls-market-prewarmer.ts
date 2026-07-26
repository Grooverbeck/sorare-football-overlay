import {
  FootballPositionSchema,
  type FootballPosition,
  type PlayerStats,
} from '@sorare-overlay/shared';
import { parse, type DocumentNode } from 'graphql';
import { z } from 'zod';
import type { SorareGraphqlClient } from '../graphql/client.js';
import type { AppLogger } from '../logger.js';
import type { PlayerMarketOddsProvider } from '../providers/market-odds-provider.js';

const TeamSchema = z.object({
  slug: z.string().min(1),
  shortName: z.string().min(1),
});

const FixtureSchema = z.object({
  id: z.string().min(1),
  date: z.string().datetime(),
  homeTeam: TeamSchema.nullable(),
  awayTeam: TeamSchema.nullable(),
});

const FixturesResponseSchema = z.object({
  football: z.object({
    competition: z
      .object({
        futureGames: z.object({
          nodes: z.array(FixtureSchema),
        }),
      })
      .nullable(),
  }),
});

const ActivePlayerSchema = z.object({
  slug: z.string().min(1),
  displayName: z.string().min(1),
  position: z.string().min(1),
  cardPositions: z.array(z.string()).optional(),
});

const ClubSchema = z.object({
  slug: z.string().min(1),
  activePlayers: z.object({
    nodes: z.array(ActivePlayerSchema),
  }),
});

const ClubsResponseSchema = z.object({
  football: z.record(z.string(), ClubSchema.nullable()),
});

const UPCOMING_FIXTURES_QUERY = parse(`
  query MlsUpcomingFixtures($first: Int!) {
    football {
      competition(slug: "mlspa") {
        futureGames(first: $first) {
          nodes {
            id
            date
            homeTeam { slug shortName }
            awayTeam { slug shortName }
          }
        }
      }
    }
  }
`);

const positionPriority: Readonly<Record<FootballPosition, number>> = {
  Forward: 0,
  Midfielder: 1,
  Defender: 2,
  Goalkeeper: 3,
};

interface GraphqlRequester {
  request<TData, TVariables>(
    document: DocumentNode,
    variables: TVariables,
  ): Promise<TData>;
}

interface MlsMarketPrewarmerOptions {
  client: Pick<SorareGraphqlClient, 'request'> | GraphqlRequester;
  marketOddsProvider: PlayerMarketOddsProvider;
  logger: AppLogger;
  windowMs: number;
  now?: () => number;
}

export interface MlsMarketPrewarmResult {
  fixtures: number;
  representatives: number;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

function representativePosition(
  player: z.infer<typeof ActivePlayerSchema>,
): FootballPosition | null {
  const parsed = FootballPositionSchema.safeParse(
    player.cardPositions?.[0] ?? player.position,
  );
  return parsed.success ? parsed.data : null;
}

function clubBatchQuery(size: number): DocumentNode {
  const definitions = Array.from(
    { length: size },
    (_, index) => `$club${index}: String!`,
  ).join(', ');
  const fields = Array.from(
    { length: size },
    (_, index) => `
      club${index}: club(slug: $club${index}) {
        slug
        activePlayers(first: 5) {
          nodes {
            slug
            displayName
            position
            cardPositions
          }
        }
      }
    `,
  ).join('\n');
  return parse(`
    query MlsPrewarmClubRepresentatives(${definitions}) {
      football {
        ${fields}
      }
    }
  `);
}

function representativeStats(
  fixture: z.infer<typeof FixtureSchema>,
  clubSlug: string,
  player: z.infer<typeof ActivePlayerSchema>,
  position: FootballPosition,
): PlayerStats | null {
  if (!fixture.homeTeam || !fixture.awayTeam) return null;
  const isHome = fixture.homeTeam.slug === clubSlug;
  const playerTeam = isHome ? fixture.homeTeam : fixture.awayTeam;
  const opponentTeam = isHome ? fixture.awayTeam : fixture.homeTeam;
  return {
    slug: player.slug,
    displayName: player.displayName,
    position,
    aaL10: { value: null, sampleSize: 0 },
    cleanSheetL10: { value: null, sampleSize: 0 },
    goalL10: { value: null, sampleSize: 0 },
    nextGame: {
      date: fixture.date,
      competitionSlug: 'mlspa',
      homeTeamName: fixture.homeTeam.shortName,
      awayTeamName: fixture.awayTeam.shortName,
      playerTeamName: playerTeam.shortName,
      opponentTeamName: opponentTeam.shortName,
      cleanSheetProbability: null,
      matchProbabilities: null,
    },
    excludedLowCoverage: 0,
  };
}

export class MlsMarketPrewarmer {
  private readonly now: () => number;

  constructor(private readonly options: MlsMarketPrewarmerOptions) {
    this.now = options.now ?? Date.now;
  }

  async run(): Promise<MlsMarketPrewarmResult> {
    const now = this.now();
    const windowEnd = now + this.options.windowMs;
    const fixtureData = FixturesResponseSchema.parse(
      await this.options.client.request<unknown, { first: number }>(
        UPCOMING_FIXTURES_QUERY,
        { first: 50 },
      ),
    );
    const fixtures =
      fixtureData.football.competition?.futureGames.nodes
        .filter((fixture) => {
          const kickoff = Date.parse(fixture.date);
          return (
            kickoff >= now &&
            kickoff <= windowEnd &&
            fixture.homeTeam !== null &&
            fixture.awayTeam !== null
          );
        })
        .sort((left, right) => Date.parse(left.date) - Date.parse(right.date)) ??
      [];
    if (fixtures.length === 0) {
      this.options.logger.info(
        { windowHours: Math.round(this.options.windowMs / 3_600_000) },
        'MLS market prewarm found no upcoming fixtures',
      );
      return { fixtures: 0, representatives: 0 };
    }

    const clubSlugs = [
      ...new Set(
        fixtures.flatMap((fixture) =>
          [fixture.homeTeam?.slug, fixture.awayTeam?.slug].filter(
            (slug): slug is string => Boolean(slug),
          ),
        ),
      ),
    ];
    const representatives = new Map<
      string,
      {
        player: z.infer<typeof ActivePlayerSchema>;
        position: FootballPosition;
      }
    >();
    for (const batch of chunks(clubSlugs, 5)) {
      const variables = Object.fromEntries(
        batch.map((slug, index) => [`club${index}`, slug]),
      );
      const response = ClubsResponseSchema.parse(
        await this.options.client.request<unknown, Record<string, string>>(
          clubBatchQuery(batch.length),
          variables,
        ),
      );
      for (let index = 0; index < batch.length; index += 1) {
        const clubSlug = batch[index];
        const club = response.football[`club${index}`];
        if (!clubSlug || !club) continue;
        const candidate = club.activePlayers.nodes
          .map((player) => ({
            player,
            position: representativePosition(player),
          }))
          .filter(
            (
              candidate,
            ): candidate is {
              player: z.infer<typeof ActivePlayerSchema>;
              position: FootballPosition;
            } =>
              candidate.position !== null &&
              candidate.position !== 'Goalkeeper',
          )
          .sort(
            (left, right) =>
              positionPriority[left.position] - positionPriority[right.position],
          )[0];
        if (candidate) representatives.set(clubSlug, candidate);
      }
    }

    const players = fixtures.flatMap((fixture) => {
      if (!fixture.homeTeam || !fixture.awayTeam) return [];
      const clubSlug = representatives.has(fixture.homeTeam.slug)
        ? fixture.homeTeam.slug
        : fixture.awayTeam.slug;
      const representative = representatives.get(clubSlug);
      if (!representative) return [];
      const stats = representativeStats(
        fixture,
        clubSlug,
        representative.player,
        representative.position,
      );
      return stats ? [stats] : [];
    });
    await this.options.marketOddsProvider.load(players);
    const result = {
      fixtures: fixtures.length,
      representatives: players.length,
    };
    this.options.logger.info(
      result,
      'MLS market prewarm completed',
    );
    return result;
  }
}
