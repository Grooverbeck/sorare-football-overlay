import type {
  LineupSortValuesRequest,
  LineupSortValuesSuccessResponse,
} from '@sorare-overlay/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LineupSortHydrator } from '../lineup-sort-hydrator.js';

function renderGrid(count: number): HTMLElement {
  document.body.innerHTML = `
    <section data-testid="lineup-grid">
      ${Array.from(
        { length: count },
        (_, index) => `
          <div>
            <article data-testid="card-${index + 1}" data-position="Midfielder">
              <a href="/football/players/sort-player-${index + 1}">
                <img alt="Sort Player ${index + 1} - limited">
              </a>
            </article>
          </div>
        `,
      ).join('')}
    </section>
  `;
  const grid = document.querySelector<HTMLElement>(
    '[data-testid="lineup-grid"]',
  );
  if (!grid) throw new Error('Expected lineup grid');
  return grid;
}

function responseFor(
  request: LineupSortValuesRequest,
): LineupSortValuesSuccessResponse {
  const slugs = request.slugs ?? [];
  return {
    data: slugs.map((slug, index) => ({
      slug,
      displayName: slug,
      position: 'Midfielder',
      goal: { probability: (index + 1) / 100, source: 'historical' },
      aa: index + 10,
    })),
    meta: {
      requested: slugs.length,
      returned: slugs.length,
      cacheHits: slugs.length,
      source: 'sorare',
      durationMs: 2,
    },
  };
}

describe('LineupSortHydrator', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('hydrates a large pool in provider-free batches of twenty-five', async () => {
    const grid = renderGrid(51);
    const fetcher = vi.fn(async (request: LineupSortValuesRequest) =>
      responseFor(request),
    );
    const hydrator = new LineupSortHydrator(fetcher);

    await hydrator.hydrate(grid);

    expect(fetcher.mock.calls.map(([request]) => request.slugs?.length)).toEqual([
      25,
      25,
      1,
    ]);
    expect(fetcher.mock.calls[0]?.[0]).toMatchObject({
      historicalGoalWindow: null,
    });
    expect(
      grid.querySelectorAll('[data-sorare-overlay-root]'),
    ).toHaveLength(0);
    expect(
      grid.querySelectorAll('[data-sorare-overlay-sort-data-ready="true"]'),
    ).toHaveLength(51);
    hydrator.stop();
  });

  it('supports a measured fifty-player batch without changing the default', async () => {
    const grid = renderGrid(50);
    const fetcher = vi.fn(async (request: LineupSortValuesRequest) =>
      responseFor(request),
    );
    const hydrator = new LineupSortHydrator(fetcher, 50);

    await hydrator.hydrate(grid);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0].slugs).toHaveLength(50);
    hydrator.stop();
  });

  it('passes the selected historical window and writes compact values', async () => {
    const grid = renderGrid(1);
    const fetcher = vi.fn(async (request: LineupSortValuesRequest) =>
      responseFor(request),
    );
    const hydrator = new LineupSortHydrator(fetcher);

    await hydrator.hydrate(grid);
    expect(fetcher.mock.calls[0]?.[0].historicalGoalWindow).toBeNull();
    hydrator.configureHistoricalGoalFallback(true, 40);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));

    expect(fetcher.mock.calls[1]?.[0].historicalGoalWindow).toBe(40);
    const card = grid.querySelector<HTMLElement>('[data-testid="card-1"]');
    expect(card?.getAttribute('data-sorare-overlay-aa-sort-value')).toBe('10');
    expect(
      card?.getAttribute('data-sorare-overlay-goal-sort-probability'),
    ).toBe('0.01');
    hydrator.stop();
  });

  it('does not overwrite a newer full-overlay result', async () => {
    const grid = renderGrid(1);
    let resolveRequest:
      | ((response: LineupSortValuesSuccessResponse) => void)
      | undefined;
    const fetcher = vi.fn(
      (request: LineupSortValuesRequest) =>
        new Promise<LineupSortValuesSuccessResponse>((resolve) => {
          resolveRequest = (response) => resolve(response);
          expect(request.slugs).toEqual(['sort-player-1']);
        }),
    );
    const hydrator = new LineupSortHydrator(fetcher);
    const hydration = hydrator.hydrate(grid);
    const card = grid.querySelector<HTMLElement>('[data-testid="card-1"]');
    if (!card) throw new Error('Expected card');

    card.setAttribute('data-sorare-overlay-goal-sort-probability', '0.75');
    card.setAttribute('data-sorare-overlay-aa-sort-value', '22');
    card.setAttribute('data-sorare-overlay-sort-data-ready', 'true');
    resolveRequest?.(responseFor({
      slugs: ['sort-player-1'],
      playerNames: [],
      historicalGoalWindow: null,
    }));
    await hydration;

    expect(
      card.getAttribute('data-sorare-overlay-goal-sort-probability'),
    ).toBe('0.75');
    expect(card.getAttribute('data-sorare-overlay-aa-sort-value')).toBe('22');
    expect(
      card.hasAttribute('data-sorare-overlay-sort-lightweight-ready'),
    ).toBe(false);
    hydrator.stop();
  });
});
