import type { FootballPosition } from './contracts.js';
import type { MarketProbabilityBand } from './market-probability-benchmarks.js';

type Market = 'goal' | 'assist';
type OutfieldPosition = Exclude<FootballPosition, 'Goalkeeper'>;
type CutPoints = readonly [number, number, number, number, number];
type Bands = Readonly<Record<Market, Readonly<Record<OutfieldPosition, CutPoints>>>>;

/**
 * Frozen European Set reference, not percentiles of the visible/user pool.
 * Empirical P20/P40/P60/P80/P90 rounded to 0.5 percentage points.
 * See docs/EUROPEAN_MARKET_BENCHMARKS.md for coverage and limitations.
 * No provider requests or recalculation take place in the rendering path.
 */
export const EUROPEAN_MARKET_BENCHMARKS = {
  version: 1,
  asOf: '2026-09-13',
  referenceLeagues: ['premier-league-gb-eng', 'bundesliga-de', 'laliga-es', 'ligue-1-fr'],
  market: {
    source: 'odds-api-io/bet365',
    probabilityConvention: 'raw-implied-1/decimal',
    fixtures: 72,
    samples: { goal: 1977, assist: 1902 },
    goal: {
      Defender: [.065, .09, .105, .135, .155],
      Midfielder: [.125, .155, .2, .25, .295],
      Forward: [.22, .28, .325, .39, .455],
    },
    assist: {
      Defender: [.075, .09, .11, .135, .18],
      Midfielder: [.11, .135, .165, .22, .23],
      Forward: [.125, .145, .18, .22, .25],
    },
  },
  historical: {
    source: 'sorare-independent-stratified-roster-sample',
    sampledPlayers: 360,
    eligiblePlayers: 280,
    referenceWindow: 40,
    minimumAppearances: 20,
    goal: {
      // >40% of sampled defenders had no goal. Preserve ties instead of
      // inventing an orange band; zero is always classified as very-low.
      Defender: [0, 0, .04, .08, .105],
      Midfielder: [.025, .055, .09, .135, .19],
      Forward: [.085, .13, .22, .285, .355],
    },
    assist: {
      Defender: [0, .03, .045, .09, .13],
      Midfielder: [.03, .06, .095, .14, .165],
      Forward: [.035, .07, .1, .175, .215],
    },
  },
} as const satisfies {
  version: number;
  asOf: string;
  referenceLeagues: readonly string[];
  market: Bands & { source: string; probabilityConvention: string; fixtures: number; samples: Record<Market, number> };
  historical: Bands & { source: string; sampledPlayers: number; eligiblePlayers: number; referenceWindow: number; minimumAppearances: number };
};

const descriptions: readonly MarketProbabilityBand[] = [
  { tone: 'very-low', label: 'sehr niedrig' },
  { tone: 'low', label: 'niedrig' },
  { tone: 'balanced', label: 'mittel' },
  { tone: 'good', label: 'gut' },
  { tone: 'strong', label: 'sehr gut' },
  { tone: 'elite', label: 'Spitze' },
];

function classify(bands: Bands, market: Market, position: FootballPosition, value: number | null | undefined): MarketProbabilityBand | null {
  if (position === 'Goalkeeper' || value === null || value === undefined || !Number.isFinite(value)) return null;
  const bounded = Math.max(0, Math.min(1, value));
  // A percentile boundary can be zero for sparse historical outcomes.
  // No observed event must never become yellow/green merely because of ties.
  if (bounded === 0) return { ...descriptions[0]! };
  const index = bands[market][position].findIndex(cut => bounded < cut);
  return { ...descriptions[index < 0 ? 5 : index]! };
}

export function getEuropeanMarketProbabilityBand(market: Market, position: FootballPosition, value: number | null | undefined): MarketProbabilityBand | null {
  return classify(EUROPEAN_MARKET_BENCHMARKS.market, market, position, value);
}

export function getEuropeanHistoricalMarketProbabilityBand(market: Market, position: FootballPosition, value: number | null | undefined): MarketProbabilityBand | null {
  return classify(EUROPEAN_MARKET_BENCHMARKS.historical, market, position, value);
}
