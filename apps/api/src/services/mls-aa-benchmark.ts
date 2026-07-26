import {
  FootballPositionSchema,
  MLS_AA_BENCHMARKS,
  getMlsAaPercentileBandFromSnapshot,
  getMlsAaTopPlayerFromSnapshot,
  type FootballPosition,
  type MlsAaBenchmarkSnapshot,
  type MlsAaContext,
  type PlayerStats,
} from '@sorare-overlay/shared';
import { parse } from 'graphql';
import { z } from 'zod';
import type { SorareGraphqlClient } from '../graphql/client.js';
import type { AppLogger } from '../logger.js';

const positions: readonly FootballPosition[] = [
  'Goalkeeper',
  'Defender',
  'Midfielder',
  'Forward',
];

const MlsAaTopPlayerSchema = z.object({
  rank: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  slug: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  aa: z.number().finite(),
  appearances: z.number().int().min(1).max(10),
});

const MlsAaPositionBenchmarkSchema = z.object({
  sampleSize: z.number().int().nonnegative(),
  p20: z.number().finite(),
  p40: z.number().finite(),
  median: z.number().finite(),
  p60: z.number().finite(),
  p80: z.number().finite(),
  p90: z.number().finite(),
  topThree: z.array(MlsAaTopPlayerSchema).length(3),
});

export const MlsAaBenchmarkSnapshotSchema = z.object({
  competition: z.string().trim().min(1),
  competitionSlug: z.literal('mlspa'),
  asOf: z.string().date(),
  minimumAppearances: z.number().int().min(1).max(10),
  populationSize: z.number().int().nonnegative(),
  positions: z.record(FootballPositionSchema, MlsAaPositionBenchmarkSchema),
});

export interface MlsAaBenchmarkStore {
  get(): Promise<MlsAaBenchmarkSnapshot>;
  set(snapshot: MlsAaBenchmarkSnapshot): void | Promise<void>;
}

export class StaticMlsAaBenchmarkStore implements MlsAaBenchmarkStore {
  private snapshot = MlsAaBenchmarkSnapshotSchema.parse(MLS_AA_BENCHMARKS);

  async get(): Promise<MlsAaBenchmarkSnapshot> {
    return this.snapshot;
  }

  set(snapshot: MlsAaBenchmarkSnapshot): void {
    this.snapshot = MlsAaBenchmarkSnapshotSchema.parse(snapshot);
  }
}

export function mlsAaContextForPlayer(
  snapshot: MlsAaBenchmarkSnapshot,
  stats: PlayerStats,
): MlsAaContext {
  const band = getMlsAaPercentileBandFromSnapshot(
    snapshot,
    stats.position,
    stats.aaL10.value,
    stats.aaL10.sampleSize,
  );
  const topPlayer = getMlsAaTopPlayerFromSnapshot(
    snapshot,
    stats.position,
    stats.slug,
  );
  return {
    asOf: snapshot.asOf,
    tone: band?.tone ?? null,
    percentileBand: band?.label ?? null,
    rank: topPlayer?.rank ?? null,
  };
}

const MLS_PLAYERS_QUERY = parse(`
  query WeeklyMlsAaPlayers($first: Int!, $after: String) {
    football {
      competition(slug: "mlspa") {
        displayName
        orderedPlayers(first: $first, after: $after, limit: LAST_10) {
          pageInfo { hasNextPage endCursor }
          nodes {
            slug
            displayName
            position
            cardPositions
          }
        }
      }
    }
  }
`);

const MLS_PLAYER_SCORES_QUERY = parse(`
  query WeeklyMlsAaScores($slugs: [String!], $position: Position) {
    players(slugs: $slugs) {
      __typename
      ... on Player {
        slug
        playerGameScores(last: 15, lowCoverage: true, position: $position) {
          __typename
          positionTyped
          ... on PlayerGameScore {
            allAroundScore
            footballGame { date lowCoverage }
            footballPlayerGameStats { playedInGame minsPlayed }
          }
        }
      }
    }
  }
`);

interface MlsPlayerSeed {
  slug: string;
  displayName: string;
  position: string;
  cardPositions: string[];
}

interface MlsPlayersPage {
  football: {
    competition: {
      displayName: string;
      orderedPlayers: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: MlsPlayerSeed[];
      };
    };
  };
}

interface MlsPlayerScore {
  __typename: string;
  positionTyped?: string;
  allAroundScore?: number;
  footballGame?: { date: string; lowCoverage: boolean };
  footballPlayerGameStats?: {
    playedInGame: boolean;
    minsPlayed: number | null;
  };
}

interface MlsScoresResponse {
  players: Array<{
    __typename: string;
    slug?: string;
    playerGameScores?: MlsPlayerScore[];
  }>;
}

interface EligiblePlayer {
  slug: string;
  displayName: string;
  position: FootballPosition;
  appearances: number;
  aa: number;
}

export interface MlsAaBenchmarkRefresherOptions {
  client: SorareGraphqlClient;
  store: MlsAaBenchmarkStore;
  logger: AppLogger;
  pageSize?: number;
  scoreBatchSize?: number;
  requestDelayMs?: number;
  minimumAppearances?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function chunks<T>(values: readonly T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function quantile(sorted: readonly number[], fraction: number): number {
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowerValue = sorted[lower];
  const upperValue = sorted[upper];
  if (lowerValue === undefined || upperValue === undefined) {
    throw new Error('Cannot calculate MLS AA quantiles for an empty position');
  }
  if (lower === upper) return lowerValue;
  return lowerValue + (upperValue - lowerValue) * (index - lower);
}

function cardPosition(seed: MlsPlayerSeed): FootballPosition | undefined {
  const parsed = FootballPositionSchema.safeParse(
    seed.cardPositions[0] ?? seed.position,
  );
  return parsed.success ? parsed.data : undefined;
}

export class MlsAaBenchmarkRefresher {
  private readonly pageSize: number;
  private readonly scoreBatchSize: number;
  private readonly requestDelayMs: number;
  private readonly minimumAppearances: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: MlsAaBenchmarkRefresherOptions) {
    this.pageSize = options.pageSize ?? 30;
    this.scoreBatchSize = options.scoreBatchSize ?? 5;
    this.requestDelayMs = options.requestDelayMs ?? 100;
    this.minimumAppearances = options.minimumAppearances ?? 5;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async run(): Promise<MlsAaBenchmarkSnapshot> {
    const { competition, players } = await this.fetchPlayers();
    const eligible: EligiblePlayer[] = [];

    for (const position of positions) {
      const candidates = players.filter(
        (candidate) => cardPosition(candidate) === position,
      );
      for (const batch of chunks(candidates, this.scoreBatchSize)) {
        const response = await this.options.client.request<
          MlsScoresResponse,
          { slugs: string[]; position: FootballPosition }
        >(MLS_PLAYER_SCORES_QUERY, {
          slugs: batch.map(({ slug }) => slug),
          position,
        });
        const seeds = new Map(batch.map((seed) => [seed.slug, seed]));
        for (const player of response.players) {
          if (player.__typename !== 'Player' || !player.slug) continue;
          const seed = seeds.get(player.slug);
          if (!seed) continue;
          const validScores = (player.playerGameScores ?? [])
            .filter(
              (score) =>
                score.__typename === 'PlayerGameScore' &&
                score.positionTyped === position &&
                score.allAroundScore !== undefined &&
                score.footballPlayerGameStats?.playedInGame === true &&
                (score.footballPlayerGameStats.minsPlayed ?? 0) > 0 &&
                score.footballGame?.lowCoverage === false,
            )
            .sort(
              (left, right) =>
                Date.parse(right.footballGame?.date ?? '') -
                Date.parse(left.footballGame?.date ?? ''),
            )
            .slice(0, 10);
          if (validScores.length < this.minimumAppearances) continue;
          const total = validScores.reduce(
            (sum, score) => sum + (score.allAroundScore ?? 0),
            0,
          );
          eligible.push({
            slug: seed.slug,
            displayName: seed.displayName,
            position,
            appearances: validScores.length,
            aa: total / validScores.length,
          });
        }
        if (this.requestDelayMs > 0) await this.sleep(this.requestDelayMs);
      }
    }

    const snapshot = MlsAaBenchmarkSnapshotSchema.parse({
      competition,
      competitionSlug: 'mlspa',
      asOf: new Date(this.now()).toISOString().slice(0, 10),
      minimumAppearances: this.minimumAppearances,
      populationSize: eligible.length,
      positions: Object.fromEntries(
        positions.map((position) => {
          const group = eligible
            .filter((player) => player.position === position)
            .sort(
              (left, right) =>
                right.aa - left.aa || left.slug.localeCompare(right.slug),
            );
          const values = group
            .map(({ aa }) => aa)
            .sort((left, right) => left - right);
          return [
            position,
            {
              sampleSize: group.length,
              p20: rounded(quantile(values, 0.2)),
              p40: rounded(quantile(values, 0.4)),
              median: rounded(quantile(values, 0.5)),
              p60: rounded(quantile(values, 0.6)),
              p80: rounded(quantile(values, 0.8)),
              p90: rounded(quantile(values, 0.9)),
              topThree: group
                .slice(0, 3)
                .map(({ slug, displayName, aa, appearances }, index) => ({
                  rank: index + 1,
                  slug,
                  displayName,
                  aa: rounded(aa),
                  appearances,
                })),
            },
          ];
        }),
      ),
    });
    await this.options.store.set(snapshot);
    this.options.logger.info(
      {
        asOf: snapshot.asOf,
        populationSize: snapshot.populationSize,
      },
      'Weekly MLS AA benchmark refreshed',
    );
    return snapshot;
  }

  private async fetchPlayers(): Promise<{
    competition: string;
    players: MlsPlayerSeed[];
  }> {
    const players: MlsPlayerSeed[] = [];
    let after: string | null = null;
    let competition = 'Major League Soccer';
    do {
      const page: MlsPlayersPage = await this.options.client.request<
        MlsPlayersPage,
        { first: number; after: string | null }
      >(MLS_PLAYERS_QUERY, { first: this.pageSize, after });
      competition = page.football.competition.displayName;
      const connection = page.football.competition.orderedPlayers;
      players.push(...connection.nodes);
      after = connection.pageInfo.hasNextPage
        ? connection.pageInfo.endCursor
        : null;
      if (after && this.requestDelayMs > 0) {
        await this.sleep(this.requestDelayMs);
      }
    } while (after);
    return { competition, players };
  }
}
