import type {
  HistoricalMarketWindow,
  LineupSortValue,
  LineupSortValuesRequest,
  LineupSortValuesSuccessResponse,
} from '@sorare-overlay/shared';
import { fetchLineupSortValues } from './api.js';
import { findCardTargets, type CardTarget } from './dom.js';
import {
  setLineupAaSortValue,
  setLineupGoalSortValue,
  lineupGoalSortProbabilityAttribute,
  lineupGoalSortSourceAttribute,
  lineupSortDataReadyAttribute,
  lineupSortFullDataRevisionAttribute,
  lineupSortLightweightReadyAttribute,
  setLineupSortDataReady,
  setLineupSortPosition,
} from './lineup-sort.js';
import {
  normalizePlayerName,
  playerNamesLikelyMatch,
  playerRequestIdentity,
  playerTargetKey,
  teamSlugsLikelyMatch,
} from './player-identity.js';
import { logStatsDiagnostic } from './stats-diagnostics.js';

type SortValuesFetcher = (
  request: LineupSortValuesRequest,
) => Promise<LineupSortValuesSuccessResponse>;

type HydrationStatus = 'queued' | 'in-flight' | 'retry' | 'ready';

interface HydrationState {
  key: string;
  target: CardTarget;
  status: HydrationStatus;
  attempts: number;
  reconcileFullOverlay?: boolean;
  preserveExistingGoalUnlessMarket?: boolean;
  fullDataRevisionAtRequest?: string | null;
}

function targetMatchesValue(
  target: CardTarget,
  value: LineupSortValue,
): boolean {
  if (target.position && target.position !== value.position) return false;
  return Boolean(
    (target.slug && target.slug === value.slug) ||
      (target.playerName &&
        playerNamesLikelyMatch(target.playerName, value.displayName)),
  );
}

function requestForBatch(
  states: readonly HydrationState[],
  historicalGoalWindow: HistoricalMarketWindow | null,
): LineupSortValuesRequest {
  const slugs = [
    ...new Set(states.flatMap(({ target }) => (target.slug ? [target.slug] : []))),
  ];
  const playerNames = [
    ...new Set(
      states.flatMap(({ target }) =>
        target.playerName ? [target.playerName] : [],
      ),
    ),
  ];
  const positions = Object.fromEntries(
    states.flatMap(({ target }) => {
      const identity = target.slug ?? target.playerName;
      return identity && target.position ? [[identity, target.position]] : [];
    }),
  );
  const playerTeams = Object.fromEntries(
    states.flatMap(({ target }) => {
      const identity = target.slug ?? target.playerName;
      return identity && target.teamSlug ? [[identity, target.teamSlug]] : [];
    }),
  );
  return {
    slugs,
    playerNames,
    historicalGoalWindow,
    ...(Object.keys(positions).length > 0 ? { positions } : {}),
    ...(Object.keys(playerTeams).length > 0 ? { playerTeams } : {}),
  };
}

function roundedDuration(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}

export class LineupSortHydrator {
  private grid: HTMLElement | null = null;
  private readonly states = new Map<HTMLElement, HydrationState>();
  private readonly queue: HydrationState[] = [];
  private readonly retryTimers = new Map<HTMLElement, number>();
  private generation = 0;
  private pumpPromise: Promise<void> | undefined;
  private pumpGeneration: number | undefined;
  private historicalGoalWindow: HistoricalMarketWindow | null = null;
  private phaseStartedAt = 0;
  private phaseCompleted = true;

  constructor(
    private readonly fetcher: SortValuesFetcher = fetchLineupSortValues,
    private readonly batchSize = 25,
    private readonly retryDelaysMs: readonly number[] = [1_000, 5_000],
  ) {}

  configureHistoricalGoalFallback(
    enabled: boolean,
    window: HistoricalMarketWindow,
  ): void {
    const nextWindow = enabled ? window : null;
    if (this.historicalGoalWindow === nextWindow) return;
    this.historicalGoalWindow = nextWindow;
    const grid = this.grid;
    if (!grid?.isConnected) return;
    this.reset(grid, true);
    void this.hydrate(grid);
  }

  hydrate(grid: HTMLElement): Promise<void> {
    if (this.grid !== grid) this.reset(grid);
    this.removeDisconnectedStates();
    let discovered = 0;
    for (const target of findCardTargets(grid)) {
      const key = playerTargetKey(target);
      const existing = this.states.get(target.container);
      if (existing?.key === key) continue;
      if (existing) {
        this.removeState(target.container);
        this.clearTargetValues(target.container);
      }

      const lightweightKey = target.container.getAttribute(
        lineupSortLightweightReadyAttribute,
      );
      if (lightweightKey && lightweightKey !== key) {
        this.clearTargetValues(target.container);
      }

      setLineupSortPosition(target.container, target.position ?? null);
      if (
        target.container.getAttribute(lineupSortDataReadyAttribute) === 'true'
      ) {
        this.states.set(target.container, {
          key,
          target,
          status: 'ready',
          attempts: 0,
        });
        continue;
      }

      const state: HydrationState = {
        key,
        target,
        status: 'queued',
        attempts: 0,
      };
      this.states.set(target.container, state);
      this.queue.push(state);
      setLineupSortDataReady(target.container, false);
      discovered += 1;
    }

    if (discovered > 0) {
      if (this.phaseCompleted) {
        this.phaseStartedAt = performance.now();
        this.phaseCompleted = false;
        logStatsDiagnostic('lineup-sort-hydration-start', {
          players: this.connectedStateCount(),
          batchSize: this.effectiveBatchSize(),
        });
      } else {
        logStatsDiagnostic('lineup-sort-hydration-grow', {
          addedPlayers: discovered,
          players: this.connectedStateCount(),
        });
      }
    }
    return this.ensurePump();
  }

  reconcileMissingGoals(teamSlugs?: Iterable<string>): Promise<void> {
    const grid = this.grid;
    if (!grid?.isConnected) return Promise.resolve();
    const expectedTeams = teamSlugs
      ? [...new Set([...teamSlugs].map((slug) => slug.trim().toLowerCase()))]
      : null;
    let queued = 0;
    for (const state of this.states.values()) {
      const container = state.target.container;
      const hasGoalValue = container.hasAttribute(
        lineupGoalSortProbabilityAttribute,
      );
      const hasMarketGoal =
        hasGoalValue &&
        container.getAttribute(lineupGoalSortSourceAttribute) === 'market';
      if (
        state.status !== 'ready' ||
        !container.isConnected ||
        !grid.contains(container) ||
        (expectedTeams ? hasMarketGoal : hasGoalValue) ||
        (expectedTeams &&
          !expectedTeams.some((teamSlug) =>
            teamSlugsLikelyMatch(state.target.teamSlug, teamSlug),
          ))
      ) {
        continue;
      }

      state.status = 'queued';
      state.attempts = 0;
      state.preserveExistingGoalUnlessMarket = hasGoalValue;
      state.reconcileFullOverlay = !container.hasAttribute(
        lineupSortLightweightReadyAttribute,
      );
      if (!state.reconcileFullOverlay) {
        setLineupSortDataReady(container, false);
      }
      this.queue.push(state);
      queued += 1;
    }

    if (queued > 0) {
      logStatsDiagnostic('lineup-sort-goal-reconcile', {
        players: queued,
        teams: expectedTeams,
      });
    }
    return this.ensurePump();
  }

  stop(): void {
    this.generation += 1;
    for (const timer of this.retryTimers.values()) window.clearTimeout(timer);
    this.retryTimers.clear();
    for (const { target } of this.states.values()) {
      this.clearTargetValues(target.container);
    }
    this.states.clear();
    this.queue.length = 0;
    this.grid = null;
    this.phaseCompleted = true;
  }

  private reset(grid: HTMLElement, clearLightweightValues = false): void {
    this.generation += 1;
    for (const timer of this.retryTimers.values()) window.clearTimeout(timer);
    this.retryTimers.clear();
    if (clearLightweightValues) {
      for (const container of grid.querySelectorAll<HTMLElement>(
        `[${lineupSortLightweightReadyAttribute}]`,
      )) {
        this.clearTargetValues(container);
      }
      if (grid.hasAttribute(lineupSortLightweightReadyAttribute)) {
        this.clearTargetValues(grid);
      }
    }
    this.states.clear();
    this.queue.length = 0;
    this.grid = grid;
    this.phaseCompleted = true;
  }

  private effectiveBatchSize(): number {
    return Math.min(50, Math.max(1, Math.floor(this.batchSize)));
  }

  private ensurePump(): Promise<void> {
    const generation = this.generation;
    if (this.pumpPromise && this.pumpGeneration === generation) {
      return this.pumpPromise;
    }
    const promise = this.pump(generation).finally(() => {
      if (this.pumpPromise === promise) {
        this.pumpPromise = undefined;
        this.pumpGeneration = undefined;
      }
      if (generation !== this.generation) return;
      if (this.queue.length > 0) void this.ensurePump();
      else this.maybeLogCompletion();
    });
    this.pumpPromise = promise;
    this.pumpGeneration = generation;
    return promise;
  }

  private async pump(generation: number): Promise<void> {
    while (generation === this.generation) {
      const batch = this.takeBatch();
      if (batch.length === 0) return;
      const startedAt = performance.now();
      for (const state of batch) {
        state.status = 'in-flight';
        state.attempts += 1;
        state.fullDataRevisionAtRequest =
          state.target.container.getAttribute(
            lineupSortFullDataRevisionAttribute,
          );
      }
      try {
        const response = await this.fetcher(
          requestForBatch(batch, this.historicalGoalWindow),
        );
        if (generation !== this.generation) return;
        this.applyResponse(batch, response);
        logStatsDiagnostic('lineup-sort-batch-complete', {
          requested: batch.length,
          returned: response.data.length,
          attempt: Math.max(...batch.map(({ attempts }) => attempts)),
          durationMs: roundedDuration(startedAt),
          backendDurationMs: response.meta.durationMs,
        });
      } catch (error) {
        if (generation !== this.generation) return;
        logStatsDiagnostic('lineup-sort-batch-failed', {
          requested: batch.length,
          attempt: Math.max(...batch.map(({ attempts }) => attempts)),
          durationMs: roundedDuration(startedAt),
          message: error instanceof Error ? error.message : String(error),
        });
        for (const state of batch) this.retryOrComplete(state);
      }
    }
  }

  private takeBatch(): HydrationState[] {
    const batch: HydrationState[] = [];
    const identities = new Set<string>();
    const deferred: HydrationState[] = [];
    while (this.queue.length > 0 && batch.length < this.effectiveBatchSize()) {
      const state = this.queue.shift();
      if (
        !state ||
        state.status !== 'queued' ||
        !state.target.container.isConnected ||
        this.states.get(state.target.container) !== state
      ) {
        continue;
      }
      const identity = playerRequestIdentity(state.target);
      if (identities.has(identity)) {
        deferred.push(state);
        continue;
      }
      identities.add(identity);
      batch.push(state);
    }
    this.queue.push(...deferred);
    return batch;
  }

  private applyResponse(
    batch: readonly HydrationState[],
    response: LineupSortValuesSuccessResponse,
  ): void {
    const deferredNames = new Set(
      (response.meta.deferredPlayerNames ?? []).map(normalizePlayerName),
    );
    const deferredSlugs = new Set(response.meta.deferredPlayerSlugs ?? []);
    for (const state of batch) {
      const value = response.data.find((candidate) =>
        targetMatchesValue(state.target, candidate),
      );
      if (value) {
        this.completeState(state, value);
        continue;
      }
      const deferred = Boolean(
        (state.target.slug && deferredSlugs.has(state.target.slug)) ||
          (state.target.playerName &&
            deferredNames.has(normalizePlayerName(state.target.playerName))),
      );
      if (deferred) this.retryOrComplete(state);
      else this.completeState(state, null);
    }
  }

  private retryOrComplete(state: HydrationState): void {
    if (
      !state.target.container.isConnected ||
      this.states.get(state.target.container) !== state
    ) {
      this.removeState(state.target.container);
      return;
    }
    const delay = this.retryDelaysMs[state.attempts - 1];
    if (delay === undefined) {
      this.completeState(state, null);
      return;
    }
    state.status = 'retry';
    const generation = this.generation;
    const timer = window.setTimeout(() => {
      this.retryTimers.delete(state.target.container);
      if (
        generation !== this.generation ||
        !state.target.container.isConnected ||
        this.states.get(state.target.container) !== state
      ) {
        return;
      }
      state.status = 'queued';
      this.queue.push(state);
      void this.ensurePump();
    }, Math.max(0, delay));
    this.retryTimers.set(state.target.container, timer);
  }

  private completeState(
    state: HydrationState,
    value: LineupSortValue | null,
  ): void {
    if (
      !state.target.container.isConnected ||
      this.states.get(state.target.container) !== state
    ) {
      return;
    }
    const container = state.target.container;
    // A visible card can finish its full stats request while this compact
    // cache-only request is still in flight. The full response is newer and
    // may contain freshly fetched market odds, so never overwrite it with the
    // lightweight snapshot that started earlier.
    const fullOverlayOwnsValues =
      container.getAttribute(lineupSortDataReadyAttribute) === 'true' &&
      !container.hasAttribute(lineupSortLightweightReadyAttribute);
    const fullOverlayChangedDuringRequest =
      container.getAttribute(lineupSortFullDataRevisionAttribute) !==
      state.fullDataRevisionAtRequest;
    if (
      fullOverlayOwnsValues &&
      (!state.reconcileFullOverlay || fullOverlayChangedDuringRequest)
    ) {
      state.status = 'ready';
      delete state.reconcileFullOverlay;
      delete state.preserveExistingGoalUnlessMarket;
      delete state.fullDataRevisionAtRequest;
      return;
    }
    const currentGoalIsMarket =
      container.hasAttribute(lineupGoalSortProbabilityAttribute) &&
      container.getAttribute(lineupGoalSortSourceAttribute) === 'market';
    if (
      currentGoalIsMarket ||
      (state.preserveExistingGoalUnlessMarket &&
        value?.goal?.source !== 'market')
    ) {
      setLineupSortDataReady(container, true);
      state.status = 'ready';
      delete state.reconcileFullOverlay;
      delete state.preserveExistingGoalUnlessMarket;
      delete state.fullDataRevisionAtRequest;
      return;
    }
    if (state.reconcileFullOverlay) {
      // The compact endpoint is only being consulted for a newer cached goal
      // price. Keep AA, position and readiness owned by the full response.
      setLineupGoalSortValue(
        container,
        value?.goal?.probability ?? null,
        value?.goal?.source,
      );
      state.status = 'ready';
      delete state.reconcileFullOverlay;
      delete state.preserveExistingGoalUnlessMarket;
      delete state.fullDataRevisionAtRequest;
      return;
    }
    setLineupSortPosition(
      container,
      value?.position ?? state.target.position ?? null,
    );
    setLineupGoalSortValue(
      container,
      value?.goal?.probability ?? null,
      value?.goal?.source,
    );
    setLineupAaSortValue(container, value?.aa ?? null);
    container.setAttribute(lineupSortLightweightReadyAttribute, state.key);
    setLineupSortDataReady(container, true);
    state.status = 'ready';
    delete state.reconcileFullOverlay;
    delete state.preserveExistingGoalUnlessMarket;
    delete state.fullDataRevisionAtRequest;
  }

  private removeState(container: HTMLElement): void {
    const timer = this.retryTimers.get(container);
    if (timer !== undefined) window.clearTimeout(timer);
    this.retryTimers.delete(container);
    this.states.delete(container);
  }

  private clearTargetValues(container: HTMLElement): void {
    setLineupGoalSortValue(container, null);
    setLineupAaSortValue(container, null);
    setLineupSortPosition(container, null);
    setLineupSortDataReady(container, null);
    container.removeAttribute(lineupSortLightweightReadyAttribute);
  }

  private removeDisconnectedStates(): void {
    for (const [container] of this.states) {
      if (!container.isConnected || !this.grid?.contains(container)) {
        this.removeState(container);
      }
    }
  }

  private connectedStateCount(): number {
    return [...this.states.values()].filter(
      ({ target }) =>
        target.container.isConnected && Boolean(this.grid?.contains(target.container)),
    ).length;
  }

  private maybeLogCompletion(): void {
    if (this.phaseCompleted || this.retryTimers.size > 0) return;
    const connected = [...this.states.values()].filter(
      ({ target }) =>
        target.container.isConnected && Boolean(this.grid?.contains(target.container)),
    );
    if (connected.some(({ status }) => status !== 'ready')) return;
    this.phaseCompleted = true;
    logStatsDiagnostic('lineup-sort-hydration-complete', {
      players: connected.length,
      durationMs: roundedDuration(this.phaseStartedAt),
    });
  }
}
