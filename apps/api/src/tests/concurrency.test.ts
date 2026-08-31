import { describe, expect, it } from 'vitest';
import {
  mapSettledWithConcurrency,
  mapWithConcurrency,
} from '../services/concurrency.js';

describe('bounded concurrency helpers', () => {
  it('preserves result order while respecting the concurrency ceiling', async () => {
    let active = 0;
    let maximumActive = 0;

    const values = await mapWithConcurrency(
      [1, 2, 3, 4, 5, 6],
      3,
      async (value) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        return value * 2;
      },
    );

    expect(values).toEqual([2, 4, 6, 8, 10, 12]);
    expect(maximumActive).toBe(3);
  });

  it('isolates rejected tasks and continues the remaining work', async () => {
    const visited: number[] = [];
    const results = await mapSettledWithConcurrency(
      [1, 2, 3, 4],
      2,
      async (value) => {
        visited.push(value);
        if (value === 2) throw new Error('expected failure');
        return value;
      },
    );

    expect(visited).toEqual(expect.arrayContaining([1, 2, 3, 4]));
    expect(results.map(({ status }) => status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
      'fulfilled',
    ]);
  });
});
