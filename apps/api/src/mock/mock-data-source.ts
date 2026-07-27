import type { FootballPosition, PlayerAppearance } from '@sorare-overlay/shared';
import type {
  PlayerStatsDataSource,
  SourcePlayer,
  SourcePlayerFixture,
  SourcePlayerRequest,
} from '../services/data-source.js';
import { mockPlayers, type MockPlayerTemplate } from './players.js';

const positions: FootballPosition[] = ['Goalkeeper', 'Defender', 'Midfielder', 'Forward'];

function hash(value: string): number {
  return [...value].reduce((total, character) => (total * 31 + character.charCodeAt(0)) >>> 0, 7);
}

function titleFromSlug(slug: string): string {
  return slug
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function generatedTemplate(slug: string, position?: FootballPosition): MockPlayerTemplate {
  const seed = hash(slug);
  const selectedPosition = position ?? positions[seed % positions.length] ?? 'Midfielder';
  const win = 0.35 + (seed % 25) / 100;
  const draw = 0.2 + ((seed >>> 3) % 10) / 100;
  return {
    displayName: titleFromSlug(slug),
    position: selectedPosition,
    aa: Array.from({ length: 10 }, (_, index) => 6 + ((seed + index * 7) % 15)),
    goals: Array.from({ length: 10 }, (_, index) => ((seed + index * 11) % 5 === 0 ? 1 : 0)),
    assists: Array.from(
      { length: 10 },
      (_, index) => ((seed + index * 13) % 6 === 0 ? 1 : 0),
    ),
    minutes: Array.from({ length: 10 }, (_, index) => (index === 8 ? 0 : 60 + ((seed + index) % 31))),
    cleanSheets: Array.from({ length: 10 }, (_, index) => ((seed + index * 3) % 3 === 0 ? 1 : 0)),
    lowCoverageIndexes: [6],
    nextMatchProbabilities: { win, draw, loss: 1 - win - draw },
    ...(selectedPosition === 'Goalkeeper' || selectedPosition === 'Defender'
      ? { nextCleanSheetProbability: 0.3 + (seed % 31) / 100 }
      : {}),
  };
}

export class MockDataSource implements PlayerStatsDataSource {
  readonly source = 'mock' as const;

  async resolvePlayerNames(
    names: readonly string[],
    expectedPositions?: Readonly<Record<string, FootballPosition>>,
  ): Promise<SourcePlayerRequest[]> {
    return names.map((name) => ({
      slug: name
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, ''),
      ...(expectedPositions?.[name] ? { position: expectedPositions[name] } : {}),
      resolvedFromName: name,
      nameResolution: 'search',
    }));
  }

  async fetchPlayers(requests: readonly SourcePlayerRequest[]): Promise<SourcePlayer[]> {
    return requests.map((request) => {
      const template = mockPlayers[request.slug] ?? generatedTemplate(request.slug, request.position);
      const position = request.position ?? template.position;
      const appearanceCount = request.includeHistoricalAssists
        ? 50
        : template.aa.length;
      const appearances: PlayerAppearance[] = Array.from(
        { length: appearanceCount },
        (_, index) => {
          const sourceIndex = index % template.aa.length;
          return {
            date: new Date(Date.UTC(2026, 6, 20 - index * 7, 18)).toISOString(),
            allAroundScore: template.aa[sourceIndex] ?? null,
            goals: template.goals[sourceIndex] ?? 0,
            assists:
              template.assists?.[sourceIndex] ??
              ((hash(`${request.slug}:${index}`) % 6 === 0) ? 1 : 0),
            minsPlayed: template.minutes[sourceIndex] ?? 0,
            cleanSheet60: template.cleanSheets[sourceIndex] ?? 0,
            lowCoverage:
              template.lowCoverageIndexes?.includes(sourceIndex) ?? false,
            position,
          };
        },
      );

      return {
        slug: request.slug,
        displayName: template.displayName,
        position,
        appearances,
        nextGame: {
          date: '2026-07-27T18:45:00.000Z',
          competitionSlug: 'mlspa',
          homeTeamName: 'Mock United',
          awayTeamName: 'Demo City',
          playerTeamName: 'Mock United',
          opponentTeamName: 'Demo City',
          cleanSheetProbability: template.nextCleanSheetProbability ?? null,
          matchProbabilities: template.nextMatchProbabilities,
        },
      };
    });
  }

  async fetchNextGames(
    requests: readonly SourcePlayerRequest[],
  ): Promise<SourcePlayerFixture[]> {
    return (await this.fetchPlayers(requests)).map(({ slug, nextGame }) => ({
      slug,
      nextGame,
    }));
  }
}
