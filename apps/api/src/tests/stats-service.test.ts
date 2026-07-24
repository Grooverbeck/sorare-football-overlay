import {
  PlayerStatsRequestSchema,
  type PlayerStats,
} from '@sorare-overlay/shared';
import { describe, expect, it } from 'vitest';
import type { Cache } from '../cache.js';
import { MockDataSource } from '../mock/mock-data-source.js';
import { HistoricalGoalscorerProvider } from '../providers/goalscorer-provider.js';
import { StatsService } from '../services/stats-service.js';

class FillMissingCache implements Cache<PlayerStats> {
  fillMissingCalls = 0;
  setCalls = 0;
  getKeys: string[] = [];

  get(key: string): undefined {
    this.getKeys.push(key);
    return undefined;
  }

  set(): void {
    this.setCalls += 1;
  }

  fillMissing(_key: string, value: PlayerStats): PlayerStats {
    this.fillMissingCalls += 1;
    return { ...value, displayName: `${value.displayName} (cached form)` };
  }
}

describe('StatsService cache writes', () => {
  it('uses the cache result when filling a partial cache miss', async () => {
    const cache = new FillMissingCache();
    const service = new StatsService(
      new MockDataSource(),
      new HistoricalGoalscorerProvider(),
      cache,
      true,
    );

    const result = await service.getPlayerStats(
      PlayerStatsRequestSchema.parse({ slugs: ['jude-bellingham'] }),
    );

    expect(cache.fillMissingCalls).toBe(1);
    expect(cache.setCalls).toBe(0);
    expect(cache.getKeys).toContain('jude-bellingham:auto-v3:no-low');
    expect(result.data[0]?.displayName).toBe('Jude Bellingham (cached form)');
  });
});
