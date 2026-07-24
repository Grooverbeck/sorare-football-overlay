import type { FootballPosition, MatchProbabilities } from '@sorare-overlay/shared';

export interface MockPlayerTemplate {
  displayName: string;
  position: FootballPosition;
  aa: number[];
  goals: number[];
  minutes: number[];
  cleanSheets: number[];
  lowCoverageIndexes?: number[];
  nextCleanSheetProbability?: number;
  nextMatchProbabilities: MatchProbabilities;
}

export const mockPlayers: Record<string, MockPlayerTemplate> = {
  'kylian-mbappe-lottin': {
    displayName: 'Kylian Mbappé',
    position: 'Forward',
    aa: [13, 9, 7, 16, 4, 11, 8, 6, 14, 10],
    goals: [1, 0, 1, 2, 0, 1, 0, 1, 1, 0],
    minutes: [90, 83, 90, 90, 31, 90, 90, 74, 90, 88],
    cleanSheets: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    nextMatchProbabilities: { win: 0.62, draw: 0.22, loss: 0.16 },
  },
  'virgil-van-dijk': {
    displayName: 'Virgil van Dijk',
    position: 'Defender',
    aa: [18, 12, 9, 21, 14, 7, 16, 11, 19, 13],
    goals: [0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
    minutes: [90, 90, 90, 90, 90, 90, 90, 90, 90, 90],
    cleanSheets: [1, 0, 1, 1, 0, 0, 1, 1, 0, 1],
    lowCoverageIndexes: [7],
    nextCleanSheetProbability: 0.47,
    nextMatchProbabilities: { win: 0.48, draw: 0.27, loss: 0.25 },
  },
  'manuel-neuer': {
    displayName: 'Manuel Neuer',
    position: 'Goalkeeper',
    aa: [6, 8, 11, 4, 13, 7, 9, 12, 5, 10],
    goals: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    minutes: [90, 90, 90, 90, 90, 90, 90, 90, 90, 90],
    cleanSheets: [1, 1, 0, 1, 0, 1, 0, 1, 1, 0],
    nextCleanSheetProbability: 0.55,
    nextMatchProbabilities: { win: 0.66, draw: 0.2, loss: 0.14 },
  },
  'jude-bellingham': {
    displayName: 'Jude Bellingham',
    position: 'Midfielder',
    aa: [15, 10, 17, 8, 12, 14, 6, 19, 11, 9],
    goals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0],
    minutes: [90, 90, 86, 90, 90, 72, 90, 90, 63, 90],
    cleanSheets: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    nextMatchProbabilities: { win: 0.58, draw: 0.24, loss: 0.18 },
  },
};
