import type {
  LineupSortValuesRequest,
  LineupSortValuesSuccessResponse,
} from '@sorare-overlay/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LineupSortHydrator } from '../lineup-sort-hydrator.js';
import {
  markLineupSortFullDataUpdated,
  setLineupAaSortValue,
  setLineupGoalSortValue,
  setLineupSortPosition,
} from '../lineup-sort.js';

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

function renderTeamGrid(): HTMLElement {
  document.body.innerHTML = `
    <section data-testid="lineup-grid">
      ${['team-one-city', 'team-two-city']
        .map(
          (teamSlug, index) => `
            <div>
              <button data-testid="card-${index + 1}" data-position="Midfielder">
                <img alt="Sort Player ${index + 1} - limited">
              </button>
              <div>
                <span aria-label="Team" class="highlighted"><img alt="${teamSlug}"></span>
                <span aria-label="Team"><img alt="opponent-${index + 1}"></span>
              </div>
            </div>
          `,
        )
        .join('')}
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

  it('rechecks only stale lightweight goal values for an updated team', async () => {
    const grid = renderTeamGrid();
    let requestNumber = 0;
    const fetcher = vi.fn(
      async (
        request: LineupSortValuesRequest,
      ): Promise<LineupSortValuesSuccessResponse> => {
        requestNumber += 1;
        const names = request.playerNames ?? [];
        return {
          data: names.map((displayName, index) => ({
            slug: `sort-player-${index + 1}`,
            displayName,
            position: 'Midfielder',
            goal:
              requestNumber === 1
                ? null
                : { probability: 0.42, source: 'market' },
            aa: 12,
          })),
          meta: {
            requested: names.length,
            returned: names.length,
            cacheHits: names.length,
            source: 'sorare',
            durationMs: 2,
          },
        };
      },
    );
    const hydrator = new LineupSortHydrator(fetcher);

    await hydrator.hydrate(grid);
    const firstCard = grid.querySelector<HTMLElement>('[data-testid="card-1"]');
    const secondCard = grid.querySelector<HTMLElement>('[data-testid="card-2"]');
    if (!firstCard || !secondCard) throw new Error('Expected team cards');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      firstCard.hasAttribute('data-sorare-overlay-goal-sort-probability'),
    ).toBe(false);
    setLineupGoalSortValue(firstCard, 0.2, 'historical');

    await hydrator.reconcileMissingGoals(['team-one']);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[0].playerNames).toEqual(['Sort Player 1']);
    expect(
      firstCard.getAttribute('data-sorare-overlay-goal-sort-probability'),
    ).toBe('0.42');
    expect(
      secondCard.hasAttribute('data-sorare-overlay-goal-sort-probability'),
    ).toBe(false);
    expect(
      grid.querySelectorAll('[data-sorare-overlay-sort-data-ready="true"]'),
    ).toHaveLength(2);
    hydrator.stop();
  });

  it('keeps a historical goal when a team refresh has no market replacement', async () => {
    const grid = renderTeamGrid();
    const fetcher = vi.fn(
      async (
        request: LineupSortValuesRequest,
      ): Promise<LineupSortValuesSuccessResponse> => ({
        data: (request.playerNames ?? []).map((displayName, index) => ({
          slug: `sort-player-${index + 1}`,
          displayName,
          position: 'Midfielder',
          goal: null,
          aa: 12,
        })),
        meta: {
          requested: request.playerNames?.length ?? 0,
          returned: request.playerNames?.length ?? 0,
          cacheHits: request.playerNames?.length ?? 0,
          source: 'sorare',
          durationMs: 2,
        },
      }),
    );
    const hydrator = new LineupSortHydrator(fetcher);

    await hydrator.hydrate(grid);
    const firstCard = grid.querySelector<HTMLElement>('[data-testid="card-1"]');
    if (!firstCard) throw new Error('Expected team card');
    setLineupGoalSortValue(firstCard, 0.2, 'historical');

    await hydrator.reconcileMissingGoals(['team-one']);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      firstCard.getAttribute('data-sorare-overlay-goal-sort-probability'),
    ).toBe('0.2');
    expect(
      firstCard.getAttribute('data-sorare-overlay-goal-sort-source'),
    ).toBe('historical');
    expect(
      firstCard.getAttribute('data-sorare-overlay-sort-data-ready'),
    ).toBe('true');
    hydrator.stop();
  });

  it('updates only the missing goal when a full overlay owns the other sort values', async () => {
    const grid = renderGrid(1);
    let requestNumber = 0;
    const fetcher = vi.fn(
      async (
        request: LineupSortValuesRequest,
      ): Promise<LineupSortValuesSuccessResponse> => {
        requestNumber += 1;
        const response = responseFor(request);
        return {
          ...response,
          data: response.data.map((value) => ({
            ...value,
            goal:
              requestNumber === 1
                ? null
                : { probability: 0.42, source: 'market' },
            aa: 99,
          })),
        };
      },
    );
    const hydrator = new LineupSortHydrator(fetcher);

    await hydrator.hydrate(grid);
    const card = grid.querySelector<HTMLElement>('[data-testid="card-1"]');
    if (!card) throw new Error('Expected card');
    card.removeAttribute('data-sorare-overlay-sort-lightweight-ready');
    markLineupSortFullDataUpdated(card);
    setLineupAaSortValue(card, 22);
    setLineupSortPosition(card, 'Forward');

    await hydrator.reconcileMissingGoals();

    expect(
      card.getAttribute('data-sorare-overlay-goal-sort-probability'),
    ).toBe('0.42');
    expect(card.getAttribute('data-sorare-overlay-goal-sort-source')).toBe(
      'market',
    );
    expect(card.getAttribute('data-sorare-overlay-aa-sort-value')).toBe('22');
    expect(card.getAttribute('data-sorare-overlay-sort-position')).toBe(
      'Forward',
    );
    expect(
      card.hasAttribute('data-sorare-overlay-sort-lightweight-ready'),
    ).toBe(false);
    hydrator.stop();
  });

  it('preserves a full-overlay goal that arrives during reconciliation', async () => {
    const grid = renderGrid(1);
    let resolveReconciliation:
      | ((response: LineupSortValuesSuccessResponse) => void)
      | undefined;
    let requestNumber = 0;
    const fetcher = vi.fn((request: LineupSortValuesRequest) => {
      requestNumber += 1;
      if (requestNumber === 1) {
        const response = responseFor(request);
        return Promise.resolve({
          ...response,
          data: response.data.map((value) => ({ ...value, goal: null })),
        });
      }
      return new Promise<LineupSortValuesSuccessResponse>((resolve) => {
        resolveReconciliation = resolve;
      });
    });
    const hydrator = new LineupSortHydrator(fetcher);

    await hydrator.hydrate(grid);
    const card = grid.querySelector<HTMLElement>('[data-testid="card-1"]');
    if (!card) throw new Error('Expected card');
    card.removeAttribute('data-sorare-overlay-sort-lightweight-ready');
    markLineupSortFullDataUpdated(card);
    setLineupAaSortValue(card, 22);

    const reconciliation = hydrator.reconcileMissingGoals();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    markLineupSortFullDataUpdated(card);
    setLineupGoalSortValue(card, 0.75, 'market');
    setLineupAaSortValue(card, 30);
    const response = responseFor({
      slugs: ['sort-player-1'],
      playerNames: [],
      historicalGoalWindow: null,
    });
    resolveReconciliation?.({
      ...response,
      data: response.data.map((value) => ({
        ...value,
        goal: { probability: 0.42, source: 'market' },
      })),
    });
    await reconciliation;

    expect(
      card.getAttribute('data-sorare-overlay-goal-sort-probability'),
    ).toBe('0.75');
    expect(card.getAttribute('data-sorare-overlay-aa-sort-value')).toBe('30');
    expect(
      card.hasAttribute('data-sorare-overlay-sort-lightweight-ready'),
    ).toBe(false);
    hydrator.stop();
  });
});
