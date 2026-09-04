import type {
  FootballPosition,
  HistoricalMarketWindow,
  LineupSortValue,
  LineupSortValuesRequest,
  LineupSortValuesSuccessResponse,
} from '@sorare-overlay/shared';
import { fetchLineupSortValues } from './api.js';
import { findCardTargets, type CardTarget } from './dom.js';
import {
  setLineupAaSortValue,
  setLineupCleanSheetSortValue,
  setLineupGoalSortValue,
  lineupAaSortValueAttribute,
  lineupCleanSheetSortProbabilityAttribute,
  lineupGoalSortProbabilityAttribute,
  lineupGoalSortSourceAttribute,
  lineupSortDataReadyAttribute,
  lineupSortFullDataRevisionAttribute,
  lineupSortLightweightReadyAttribute,
  lineupSortPositionAttribute,
  setLineupSortDataReady,
  setLineupSortPosition,
  type LineupGoalSortSource,
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

interface SortValueSnapshot {
  position: FootballPosition | null;
  goal: {
    probability: number;
    source: LineupGoalSortSource;
  } | null;
  aa: number | null;
  cleanSheet: number | null;
}

interface PositionlessSnapshotAlias {
  snapshot: SortValueSnapshot;
  ambiguous: boolean;
}

function positionlessTargetKey(target: CardTarget): string {
  return playerTargetKey({
    ...(target.slug ? { slug: target.slug } : {}),
    ...(target.playerName ? { playerName: target.playerName } : {}),
    ...(target.teamSlug ? { teamSlug: target.teamSlug } : {}),
  });
}

function finiteAttribute(
  container: HTMLElement,
  attribute: string,
): number | null {
  if (!container.hasAttribute(attribute)) return null;
  const value = Number(container.getAttribute(attribute));
  return Number.isFinite(value) ? value : null;
}

function sortPositionFromContainer(
  container: HTMLElement,
  fallback: FootballPosition | undefined,
): FootballPosition | null {
  const value = container.getAttribute(lineupSortPositionAttribute);
  if (
    value === 'Goalkeeper' ||
    value === 'Defender' ||
    value === 'Midfielder' ||
    value === 'Forward'
  ) {
    return value;
  }
  return fallback ?? null;
}

function snapshotForTarget(target: CardTarget): SortValueSnapshot | null {
  const container = target.container;
  if (container.getAttribute(lineupSortDataReadyAttribute) !== 'true') {
    return null;
  }
  const goalProbability = finiteAttribute(
    container,
    lineupGoalSortProbabilityAttribute,
  );
  const rawGoalSource = container.getAttribute(lineupGoalSortSourceAttribute);
  const goalSource =
    rawGoalSource === 'market' || rawGoalSource === 'historical'
      ? rawGoalSource
      : null;
  return {
    position: sortPositionFromContainer(container, target.position),
    goal:
      goalProbability !== null && goalSource
        ? { probability: goalProbability, source: goalSource }
        : null,
    aa: finiteAttribute(container, lineupAaSortValueAttribute),
    cleanSheet: finiteAttribute(
      container,
      lineupCleanSheetSortProbabilityAttribute,
    ),
  };
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
  private readonly snapshots = new Map<string, SortValueSnapshot>();
  private readonly positionlessSnapshots = new Map<
    string,
    PositionlessSnapshotAlias
  >();
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
    private readonly batchSize = 50,
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

  preserve(target: CardTarget): void {
    const key = playerTargetKey(target);
    if (this.states.get(target.container)?.key !== key) return;
    this.rememberSnapshot(target, key);
  }

  private rememberSnapshot(target: CardTarget, key: string): void {
    const snapshot = snapshotForTarget(target);
    if (!snapshot) return;
    this.snapshots.set(key, snapshot);
    if (!snapshot.position) return;

    const aliasKey = positionlessTargetKey(target);
    const existing = this.positionlessSnapshots.get(aliasKey);
    if (!existing) {
      this.positionlessSnapshots.set(aliasKey, {
        snapshot,
        ambiguous: false,
      });
      return;
    }
    if (existing.ambiguous) return;
    if (existing.snapshot.position !== snapshot.position) {
      this.positionlessSnapshots.set(aliasKey, {
        snapshot: existing.snapshot,
        ambiguous: true,
      });
      return;
    }
    this.positionlessSnapshots.set(aliasKey, {
      snapshot,
      ambiguous: false,
    });
  }

  private snapshotForTarget(
    target: CardTarget,
    key: string,
  ): SortValueSnapshot | undefined {
    const exact = this.snapshots.get(key);
    if (exact || target.position !== undefined) return exact;
    const alias = this.positionlessSnapshots.get(positionlessTargetKey(target));
    return alias?.ambiguous ? undefined : alias?.snapshot;
  }

  hydrate(
    grid: HTMLElement,
    targets: readonly CardTarget[] = findCardTargets(grid),
  ): Promise<void> {
    if (this.grid !== grid) this.reset(grid);
    // Progress pulses intentionally pass no targets. They only need to keep
    // the existing queue moving; sweeping every previously discovered card
    // on each pulse makes a large lazy-loaded pool quadratic.
    if (targets.length > 0) this.removeDisconnectedStates();
    let discovered = 0;
    for (const target of targets) {
      const key = playerTargetKey(target);
      const existing = this.states.get(target.container);
      if (existing?.key === key) {
        this.preserve(target);
        continue;
      }
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

      if (
        target.container.getAttribute(lineupSortDataReadyAttribute) === 'true'
      ) {
        this.rememberSnapshot(target, key);
        this.states.set(target.container, {
          key,
          target,
          status: 'ready',
          attempts: 0,
        });
        continue;
      }

      const snapshot = this.snapshotForTarget(target, key);
      if (snapshot) {
        this.applySnapshot(target, key, snapshot);
        this.states.set(target.container, {
          key,
          target,
          status: 'ready',
          attempts: 0,
        });
        continue;
      }

      setLineupSortPosition(target.container, target.position ?? null);

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
          players: this.states.size,
          batchSize: this.effectiveBatchSize(),
        });
      } else {
        logStatsDiagnostic('lineup-sort-hydration-grow', {
          addedPlayers: discovered,
          players: this.states.size,
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
    this.snapshots.clear();
    this.positionlessSnapshots.clear();
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
    this.snapshots.clear();
    this.positionlessSnapshots.clear();
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
      this.preserve(state.target);
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
      this.preserve(state.target);
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
      this.preserve(state.target);
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
    setLineupCleanSheetSortValue(container, value?.cleanSheet ?? null);
    container.setAttribute(lineupSortLightweightReadyAttribute, state.key);
    setLineupSortDataReady(container, true);
    state.status = 'ready';
    this.preserve(state.target);
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

  private applySnapshot(
    target: CardTarget,
    key: string,
    snapshot: SortValueSnapshot,
  ): void {
    const container = target.container;
    setLineupSortPosition(container, snapshot.position);
    setLineupGoalSortValue(
      container,
      snapshot.goal?.probability ?? null,
      snapshot.goal?.source,
    );
    setLineupAaSortValue(container, snapshot.aa);
    setLineupCleanSheetSortValue(container, snapshot.cleanSheet);
    container.setAttribute(lineupSortLightweightReadyAttribute, key);
    setLineupSortDataReady(container, true);
  }

  private clearTargetValues(container: HTMLElement): void {
    setLineupGoalSortValue(container, null);
    setLineupAaSortValue(container, null);
    setLineupCleanSheetSortValue(container, null);
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
