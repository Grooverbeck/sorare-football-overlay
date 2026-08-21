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
  minimumMinutes: number;
  minimumAppearances: number;
  populationSize: number;
  positions: Record<FootballPosition, MlsAaPositionBenchmark>;
}

/**
 * Versioned snapshot generated from Sorare's `mlspa` competition.
 *
 * Population: active competition players with at least five valid club
 * appearances. The snapshot applies the same rules as the overlay: newest ten
 * scores with at least 60 minutes for the concrete card position, excluding
 * DNPs and low coverage.
 */
export const MLS_AA_BENCHMARKS = {
  competition: 'Major League Soccer',
  competitionSlug: 'mlspa',
  asOf: '2026-08-16',
  minimumMinutes: 60,
  minimumAppearances: 5,
  populationSize: 388,
  positions: {
    Goalkeeper: {
      sampleSize: 33,
      p20: 4.74,
      p40: 6.88,
      median: 7.23,
      p60: 7.98,
      p80: 12.58,
      p90: 14.27,
      topThree: [
        {
          rank: 1,
          slug: 'jonathan-sirois',
          displayName: 'Jonathan Sirois',
          aa: 17.16,
          appearances: 7,
        },
        {
          rank: 2,
          slug: 'carlos-joaquim-dos-santos',
          displayName: 'CJ Dos Santos',
          aa: 15.64,
          appearances: 7,
        },
        {
          rank: 3,
          slug: 'james-marcinkowski',
          displayName: 'JT Marcinkowski',
          aa: 15.12,
          appearances: 10,
        },
      ],
    },
    Defender: {
      sampleSize: 147,
      p20: 5.74,
      p40: 8.89,
      median: 10.89,
      p60: 12.81,
      p80: 16.38,
      p90: 19.57,
      topThree: [
        {
          rank: 1,
          slug: 'kai-wagner',
          displayName: 'Kai Wagner',
          aa: 31.61,
          appearances: 5,
        },
        {
          rank: 2,
          slug: 'lucas-halter',
          displayName: 'Lucas Halter',
          aa: 27.09,
          appearances: 5,
        },
        {
          rank: 3,
          slug: 'jaziel-orozco',
          displayName: 'Jaziel Orozco',
          aa: 25.6,
          appearances: 5,
        },
      ],
    },
    Midfielder: {
      sampleSize: 123,
      p20: 5.82,
      p40: 9.92,
      median: 11.28,
      p60: 12.73,
      p80: 15.83,
      p90: 18.93,
      topThree: [
        {
          rank: 1,
          slug: 'adrian-andres-cubas',
          displayName: 'Andrés Cubas',
          aa: 27.62,
          appearances: 5,
        },
        {
          rank: 2,
          slug: 'alonso-coello-camarero',
          displayName: 'Alonso Coello',
          aa: 24.09,
          appearances: 10,
        },
        {
          rank: 3,
          slug: 'jose-luis-caicedo-barrera',
          displayName: 'José Caicedo',
          aa: 23.22,
          appearances: 6,
        },
      ],
    },
    Forward: {
      sampleSize: 85,
      p20: 4.37,
      p40: 6.19,
      median: 6.73,
      p60: 8.22,
      p80: 12.64,
      p90: 16.96,
      topThree: [
        {
          rank: 1,
          slug: 'kristoffer-velde',
          displayName: 'Kristoffer Velde',
          aa: 23.31,
          appearances: 10,
        },
        {
          rank: 2,
          slug: 'miguel-angel-almiron-rejala',
          displayName: 'Miguel Almirón',
          aa: 23.2,
          appearances: 5,
        },
        {
          rank: 3,
          slug: 'guilherme-augusto-vieira-dos-santos',
          displayName: 'Guilherme',
          aa: 22.55,
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
  if (value === null || sampleSize < 1) return null;
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
