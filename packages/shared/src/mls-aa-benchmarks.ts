import type { FootballPosition } from './contracts.js';

export type PerformanceTone =
  | 'very-low'
  | 'low'
  | 'balanced'
  | 'good'
  | 'strong'
  | 'elite';

export interface MlsAaPositionBenchmark {
  sampleSize: number;
  p20: number;
  p40: number;
  median: number;
  p60: number;
  p80: number;
  p90: number;
  topThree: readonly MlsAaTopPlayer[];
}

export type MlsAaTopRank = 1 | 2 | 3;

export interface MlsAaTopPlayer {
  rank: MlsAaTopRank;
  slug: string;
  displayName: string;
  aa: number;
  appearances: number;
}

export interface MlsAaPercentileBand {
  tone: PerformanceTone;
  label: 'P0–20' | 'P20–40' | 'P40–60' | 'P60–80' | 'P80–90' | 'P90–100';
}

export interface MlsAaBenchmarkSnapshot {
  competition: string;
  competitionSlug: string;
  asOf: string;
  minimumAppearances: number;
  populationSize: number;
  positions: Record<FootballPosition, MlsAaPositionBenchmark>;
}

/**
 * Versioned snapshot generated from Sorare's `mlspa` competition.
 *
 * Population: active competition players with at least five valid club
 * appearances. The snapshot applies the same rules as the overlay: newest ten
 * played scores for the concrete card position, excluding DNPs and low
 * coverage.
 */
export const MLS_AA_BENCHMARKS = {
  competition: 'Major League Soccer',
  competitionSlug: 'mlspa',
  asOf: '2026-07-24',
  minimumAppearances: 5,
  populationSize: 551,
  positions: {
    Goalkeeper: {
      sampleSize: 31,
      p20: 4.21,
      p40: 5.73,
      median: 6.34,
      p60: 6.56,
      p80: 8.45,
      p90: 11.99,
      topThree: [
        {
          rank: 1,
          slug: 'james-pantemis',
          displayName: 'James Pantemis',
          aa: 15.86,
          appearances: 10,
        },
        {
          rank: 2,
          slug: 'brian-schwake',
          displayName: 'Brian Schwake',
          aa: 13.95,
          appearances: 10,
        },
        {
          rank: 3,
          slug: 'nicholas-defreitas-hansen',
          displayName: 'Nicholas Hansen',
          aa: 12.4,
          appearances: 7,
        },
      ],
    },
    Defender: {
      sampleSize: 194,
      p20: 1.83,
      p40: 5.66,
      median: 6.91,
      p60: 8.73,
      p80: 13.42,
      p90: 15.69,
      topThree: [
        {
          rank: 1,
          slug: 'jeisson-andres-palacios-murillo',
          displayName: 'Jeisson Palacios',
          aa: 22.73,
          appearances: 10,
        },
        {
          rank: 2,
          slug: 'maxwell-woledzi',
          displayName: 'Maxwell Woledzi',
          aa: 21.14,
          appearances: 10,
        },
        {
          rank: 3,
          slug: 'nouhou-tolo',
          displayName: 'Nouhou Tolo',
          aa: 20.86,
          appearances: 10,
        },
      ],
    },
    Midfielder: {
      sampleSize: 171,
      p20: 2.94,
      p40: 5.7,
      median: 7.46,
      p60: 9.65,
      p80: 12.3,
      p90: 15.58,
      topThree: [
        {
          rank: 1,
          slug: 'alonso-coello-camarero',
          displayName: 'Alonso Coello',
          aa: 24.09,
          appearances: 10,
        },
        {
          rank: 2,
          slug: 'carles-gil-de-pareja-vicent',
          displayName: 'Carles Gil',
          aa: 19.4,
          appearances: 10,
        },
        {
          rank: 3,
          slug: 'alhassan-yusuf',
          displayName: 'Alhassan Yusuf',
          aa: 19.14,
          appearances: 10,
        },
      ],
    },
    Forward: {
      sampleSize: 155,
      p20: 1.21,
      p40: 3.09,
      median: 4.04,
      p60: 5.25,
      p80: 8.33,
      p90: 11.84,
      topThree: [
        {
          rank: 1,
          slug: 'lionel-andres-messi-cuccittini',
          displayName: 'Lionel Messi',
          aa: 25.04,
          appearances: 10,
        },
        {
          rank: 2,
          slug: 'guilherme-augusto-vieira-dos-santos',
          displayName: 'Guilherme',
          aa: 22.83,
          appearances: 10,
        },
        {
          rank: 3,
          slug: 'philip-zinckernagel',
          displayName: 'Philip Zinckernagel',
          aa: 19.89,
          appearances: 10,
        },
      ],
    },
  } satisfies Record<FootballPosition, MlsAaPositionBenchmark>,
} as const;

export function getMlsAaPercentileBand(
  position: FootballPosition,
  value: number | null,
  sampleSize: number,
): MlsAaPercentileBand | null {
  return getMlsAaPercentileBandFromSnapshot(
    MLS_AA_BENCHMARKS,
    position,
    value,
    sampleSize,
  );
}

export function getMlsAaPercentileBandFromSnapshot(
  snapshot: MlsAaBenchmarkSnapshot,
  position: FootballPosition,
  value: number | null,
  sampleSize: number,
): MlsAaPercentileBand | null {
  if (value === null || sampleSize < snapshot.minimumAppearances) return null;
  const benchmark = snapshot.positions[position];
  if (value < benchmark.p20) return { tone: 'very-low', label: 'P0–20' };
  if (value < benchmark.p40) return { tone: 'low', label: 'P20–40' };
  if (value < benchmark.p60) return { tone: 'balanced', label: 'P40–60' };
  if (value < benchmark.p80) return { tone: 'good', label: 'P60–80' };
  if (value < benchmark.p90) return { tone: 'strong', label: 'P80–90' };
  return { tone: 'elite', label: 'P90–100' };
}

export function getMlsAaTopPlayer(
  position: FootballPosition,
  slug: string,
): MlsAaTopPlayer | null {
  return getMlsAaTopPlayerFromSnapshot(MLS_AA_BENCHMARKS, position, slug);
}

export function getMlsAaTopPlayerFromSnapshot(
  snapshot: MlsAaBenchmarkSnapshot,
  position: FootballPosition,
  slug: string,
): MlsAaTopPlayer | null {
  const normalizedSlug = slug.trim().toLocaleLowerCase();
  return (
    snapshot.positions[position].topThree.find(
      (candidate) => candidate.slug === normalizedSlug,
    ) ?? null
  );
}
