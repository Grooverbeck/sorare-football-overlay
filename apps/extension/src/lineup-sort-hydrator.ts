import type {
  FootballPosition,
  HistoricalMarketWindow,
  LineupSortValue,
  LineupSortValuesRequest,
  LineupSortValuesSuccessResponse,
  LineupSortReadiness,
} from '@sorare-overlay/shared';
import { readSortReadiness, setSortReadiness, readinessIsSettled, uniformReadiness, setSortFinalCheck } from './lineup-sort-readiness.js';
import { fetchLineupSortValues } from './api.js';
import { findCardTargets, type CardTarget } from './dom.js';
import { findCardMediaContainer, findSorareCardMedia } from './card-media.js';
import { FixtureRefreshScheduler, fixtureIdentityAttribute, fixtureRefreshAttribute, readFixtureRefresh, olderFixture, fixtureChangedEvent, retiredFixture, retiredFixtureAttribute } from './fixture-refresh.js';
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
  lineupSortIdentityMissingAttribute,
  setLineupSortDataReady,
  setLineupSortPosition,
  type LineupGoalSortSource,
} from './lineup-sort.js';
import {
  playerNamesLikelyMatch,
  playerRequestIdentity,
  playerTargetKey,
  teamSlugsLikelyMatch,
} from './player-identity.js';
import { logStatsDiagnostic } from './stats-diagnostics.js';

type SortValuesFetcher = (
  request: LineupSortValuesRequest,
) => Promise<LineupSortValuesSuccessResponse>;

type HydrationStatus = 'queued' | 'in-flight' | 'retry' | 'ready' | 'error';

interface HydrationState {
  fixtureRefreshRequest?: boolean;
  key: string;
  target: CardTarget;
  status: HydrationStatus;
  attempts: number;
  reconcileFullOverlay?: boolean;
  preserveExistingGoalUnlessMarket?: boolean;
  fullDataRevisionAtRequest?: string | null;
}

interface SortValueSnapshot {
  readiness?: LineupSortReadiness;
  retiredFixture?: string;
  fixtureIdentity?: string;
  fixtureRefresh?: {key:string;nextCheckAt:string};
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
  const readiness = readSortReadiness(container);
  if (readiness && !Object.values(readiness).every(readinessIsSettled)) return null;
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
    ...(readiness ? { readiness } : {}),
    position: sortPositionFromContainer(container, target.position),
    ...(container.hasAttribute(retiredFixtureAttribute) ? {retiredFixture:container.getAttribute(retiredFixtureAttribute)!} : {}),
    ...(container.hasAttribute(fixtureIdentityAttribute) ? {fixtureIdentity:container.getAttribute(fixtureIdentityAttribute)!} : {}),
    ...(readFixtureRefresh(container) ? {fixtureRefresh:readFixtureRefresh(container)!} : {}),
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
  private readonly handleValueChange = (event: Event): void => {
    if (!(event.target instanceof HTMLElement)) return;
    const state = this.states.get(event.target);
    const readiness = readSortReadiness(event.target);
    if (!state || !readiness) return;
    const current = readiness[this.metricKey()];
    if (current === 'pending' && (state.status === 'ready' || state.status === 'error')) {
      // A full overlay can become partial after compact hydration ended.
      // Continue the missing read even if that card leaves the viewport.
      state.status = 'queued'; state.attempts = 0;
      state.reconcileFullOverlay = !event.target.hasAttribute(lineupSortLightweightReadyAttribute);
      this.phaseCompleted = false;
      this.queue.push(state);
      void this.ensurePump();
    } else if (readinessIsSettled(current) && (state.status === 'retry' || state.status === 'error')) {
      const timer = this.retryTimers.get(event.target);
      if (timer !== undefined) window.clearTimeout(timer);
      this.retryTimers.delete(event.target);
      state.status = 'ready';
      this.preserve(state.target);
      if (!this.pumpPromise) this.maybeLogCompletion();
    }
  };
  private readonly fixtureScheduler=new FixtureRefreshScheduler(
    ()=>!this.grid?.isConnected || !document.querySelector('[data-sorare-overlay-lineup-sort-trigger-label]') ? [] :
      [...this.states.values()].flatMap(s=>{const hint=readFixtureRefresh(s.target.container);return s.target.container.isConnected && hint ? [hint] : [];}),
    async keys=>{
      for(const state of this.states.values()) {
        const hint=readFixtureRefresh(state.target.container);
        if(!hint || !keys.has(hint.key) || state.status!=='ready' || !state.target.container.isConnected)continue;
        state.fixtureRefreshRequest=true;
        state.status='queued';state.attempts=0;
        this.queue.push(state);
      }
      await this.ensurePump();
    },
  );
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
  private finalCheckRequested = false;
  private finalCheckStarted = false;
  private mode: 'goal' | 'aa' | 'clean-sheet' = 'goal';

  configureMode(mode: 'goal' | 'aa' | 'clean-sheet'): void {
    if (this.mode === mode) return;
    this.mode = mode;
    if (this.grid) {
      this.finalCheckRequested = true; this.finalCheckStarted = false; this.phaseCompleted = false;
      setSortFinalCheck(this.grid, 'pending');
    }
    for (const state of this.states.values()) {
      const readiness = readSortReadiness(state.target.container);
      if (!readiness || readinessIsSettled(readiness[this.metricKey()]) || !['ready', 'error'].includes(state.status)) continue;
      state.status = 'queued'; state.attempts = 0; this.queue.push(state);
    }
    if (this.grid) { this.phaseCompleted = false; void this.ensurePump(); }
  }

  private metricKey(): keyof LineupSortReadiness {
    return this.mode === 'clean-sheet' ? 'cleanSheet' : this.mode;
  }

  constructor(
    private readonly fetcher: SortValuesFetcher = fetchLineupSortValues,
    private readonly batchSize = 50,
    private readonly retryDelaysMs: readonly number[] = [1_000, 5_000, 15_000, 30_000],
  ) {}

  finalizePool(grid: HTMLElement): void {
    if (this.grid !== grid) return;
    this.finalCheckRequested = true;
    this.finalCheckStarted = false;
    this.phaseCompleted = false;
    setSortFinalCheck(grid, 'pending');
    if (!this.pumpPromise) this.maybeLogCompletion();
  }

  retryOpenValues(): void {
    if (!this.grid?.isConnected) return;
    this.finalCheckRequested = true;
    this.finalCheckStarted = false;
    this.phaseCompleted = false;
    setSortFinalCheck(this.grid, 'pending');
    for (const state of this.states.values()) {
      if (state.status !== 'error') continue;
      state.status = 'queued'; state.attempts = 0;
      setSortReadiness(state.target.container, uniformReadiness('pending'));
      this.queue.push(state);
    }
    void this.ensurePump();
  }

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

  restoreSettled(target: CardTarget): void {
    const key = playerTargetKey(target);
    const state = this.states.get(target.container);
    if (state?.key !== key || state.status !== 'ready' ||
        target.container.getAttribute(lineupSortDataReadyAttribute) === 'true') return;
    const snapshot = this.snapshotForTarget(target, key);
    if (snapshot) this.applySnapshot(target, key, snapshot);
  }

  settleUnidentifiedCards(root: ParentNode, targets: readonly CardTarget[]): void {
    const knownContainers = new Set(targets.map(target => target.container));
    for (const media of findSorareCardMedia(root)) {
      let ancestor: HTMLElement | null = media;
      while (ancestor && !knownContainers.has(ancestor)) ancestor = ancestor.parentElement;
      if (ancestor) continue;
      const container = findCardMediaContainer(media);
      if (!container || container.hasAttribute(lineupSortIdentityMissingAttribute)) continue;
      // Count the physical card, but do not invent a player or send an empty
      // request. Missing identity is an open error, not a completed data miss.
      this.clearTargetValues(container);
      container.setAttribute(lineupSortIdentityMissingAttribute, 'true');
      setSortReadiness(container, uniformReadiness('error'));
      setLineupSortDataReady(container, false);
    }
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
      if (target.container.hasAttribute(lineupSortIdentityMissingAttribute)) {
        target.container.removeAttribute(lineupSortIdentityMissingAttribute);
        setLineupSortDataReady(target.container, false);
      }
      const key = playerTargetKey(target);
      const existing = this.states.get(target.container);
      if (existing?.key === key) {
        // Full-overlay loading/demotion can reset the DOM after this state's
        // request finished. Restore its settled values without another fetch.
        this.restoreSettled(target);
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

      const existingReadiness = readSortReadiness(target.container);
      if (
        target.container.getAttribute(lineupSortDataReadyAttribute) === 'true' &&
        (!existingReadiness || Object.values(existingReadiness).every(readinessIsSettled))
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
      if (!existingReadiness) setSortReadiness(target.container, uniformReadiness('pending'));
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
    this.fixtureScheduler.schedule();
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
    this.grid?.removeEventListener('sorare-overlay:lineup-sort-value-changed', this.handleValueChange);
    this.fixtureScheduler.stop();
    this.clearUnidentifiedCards();
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
    this.finalCheckRequested = false;
    this.finalCheckStarted = false;
  }

  private reset(grid: HTMLElement, clearLightweightValues = false): void {
    this.grid?.removeEventListener('sorare-overlay:lineup-sort-value-changed', this.handleValueChange);
    this.fixtureScheduler.stop();
    if (grid !== this.grid) this.clearUnidentifiedCards();
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
    grid.addEventListener('sorare-overlay:lineup-sort-value-changed', this.handleValueChange);
    this.phaseCompleted = true;
    this.finalCheckRequested = false;
    this.finalCheckStarted = false;
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
    const changedPlayers=new Set<string>();
    for (const state of batch) {
      const value = response.data.find((candidate) =>
        targetMatchesValue(state.target, candidate),
      );
      if (value) {
        const before=state.target.container.getAttribute(fixtureIdentityAttribute);
        this.completeState(state, value);
        const readiness = readSortReadiness(state.target.container);
        if (readiness?.[this.metricKey()] === 'pending') this.retryOrComplete(state);
        else if (readiness?.[this.metricKey()] === 'error') state.status = 'error';
        if(before!==null && before!==state.target.container.getAttribute(fixtureIdentityAttribute))changedPlayers.add(value.slug);
        continue;
      }
      // An absent record is not proof that a player has no data. Deferred and
      // unclassified misses both get a bounded retry, then an explicit error.
      this.retryOrComplete(state);
    }
    this.fixtureScheduler.schedule();
    if(changedPlayers.size)document.dispatchEvent(new CustomEvent(fixtureChangedEvent,{detail:[...changedPlayers]}));
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
      state.status = 'error';
      setSortReadiness(state.target.container, uniformReadiness('error'));
      setLineupSortDataReady(state.target.container, false);
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
    const incomingReadiness = value?.readiness ?? {
      goal: value?.goal ? 'ready' : 'unavailable',
      aa: value?.aa != null ? 'ready' : 'unavailable',
      cleanSheet: value?.cleanSheet != null ? 'ready' : 'unavailable',
    };
    const refreshingFixture=state.fixtureRefreshRequest;
    delete state.fixtureRefreshRequest;
    let fixtureChanged=false;
    if(value?.fixtureIdentity!==undefined) {
      const previous=container.getAttribute(fixtureIdentityAttribute);
      if(olderFixture(value.fixtureIdentity,previous) || retiredFixture(value.fixtureIdentity,container.getAttribute(retiredFixtureAttribute))) {state.status='ready';return;}
      if(value.fixtureIdentity===null && value.fixtureRefresh)container.setAttribute(retiredFixtureAttribute,value.fixtureRefresh.key);
      fixtureChanged=previous!==null && previous!==(value.fixtureIdentity??'');
      if(fixtureChanged) {
        setLineupGoalSortValue(container,null);
        setLineupCleanSheetSortValue(container,null);
      }
      container.setAttribute(fixtureIdentityAttribute,value.fixtureIdentity??'');
      if(value.fixtureRefresh)container.setAttribute(fixtureRefreshAttribute,JSON.stringify(value.fixtureRefresh));
      else container.removeAttribute(fixtureRefreshAttribute);
    }
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
      !fixtureChanged &&
      (fullOverlayChangedDuringRequest || (!refreshingFixture && !state.reconcileFullOverlay))
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
    const preserveGoal =
      currentGoalIsMarket ||
      (incomingReadiness.goal === 'pending' && container.hasAttribute(lineupGoalSortProbabilityAttribute)) ||
      (state.preserveExistingGoalUnlessMarket &&
        value?.goal?.source !== 'market');
    if (state.reconcileFullOverlay && fullOverlayOwnsValues && !fixtureChanged && !refreshingFixture) {
      // The compact endpoint is only being consulted for a newer cached goal
      // price. Keep AA, position and readiness owned by the full response.
      if (!preserveGoal) setLineupGoalSortValue(
        container,
        value?.goal?.probability ?? null,
        value?.goal?.source,
      );
      const currentReadiness = readSortReadiness(container) ?? incomingReadiness;
      setSortReadiness(container, { ...currentReadiness, goal: currentGoalIsMarket ? 'ready' : incomingReadiness.goal });
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
    if (!preserveGoal) setLineupGoalSortValue(
      container,
      value?.goal?.probability ?? null,
      value?.goal?.source,
    );
    if (incomingReadiness.aa !== 'pending') setLineupAaSortValue(container, value?.aa ?? null);
    if (incomingReadiness.cleanSheet !== 'pending') setLineupCleanSheetSortValue(container, value?.cleanSheet ?? null);
    setSortReadiness(container, { ...incomingReadiness, goal: currentGoalIsMarket && !fixtureChanged ? 'ready' : incomingReadiness.goal });
    container.setAttribute(lineupSortLightweightReadyAttribute, state.key);
    setLineupSortDataReady(container, readinessIsSettled(incomingReadiness[this.metricKey()]));
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
    if(snapshot.fixtureIdentity!==undefined)container.setAttribute(fixtureIdentityAttribute,snapshot.fixtureIdentity);
    if(snapshot.retiredFixture)container.setAttribute(retiredFixtureAttribute,snapshot.retiredFixture);
    if(snapshot.fixtureRefresh)container.setAttribute(fixtureRefreshAttribute,JSON.stringify(snapshot.fixtureRefresh));
    setLineupSortPosition(container, snapshot.position);
    if (container.getAttribute(lineupGoalSortSourceAttribute) !== 'market') setLineupGoalSortValue(
      container,
      snapshot.goal?.probability ?? null,
      snapshot.goal?.source,
    );
    setLineupAaSortValue(container, snapshot.aa);
    setLineupCleanSheetSortValue(container, snapshot.cleanSheet);
    setSortReadiness(container, snapshot.readiness ?? null);
    container.setAttribute(lineupSortLightweightReadyAttribute, key);
    setLineupSortDataReady(container, true);
  }

  private clearTargetValues(container: HTMLElement): void {
    setSortReadiness(container, null);
    container.removeAttribute(fixtureRefreshAttribute);
    container.removeAttribute(fixtureIdentityAttribute);
    container.removeAttribute(retiredFixtureAttribute);
    setLineupGoalSortValue(container, null);
    setLineupAaSortValue(container, null);
    setLineupCleanSheetSortValue(container, null);
    setLineupSortPosition(container, null);
    setLineupSortDataReady(container, null);
    container.removeAttribute(lineupSortLightweightReadyAttribute);
  }

  private clearUnidentifiedCards(): void {
    for (const container of this.grid?.querySelectorAll<HTMLElement>(`[${lineupSortIdentityMissingAttribute}]`) ?? []) {
      container.removeAttribute(lineupSortIdentityMissingAttribute);
      this.clearTargetValues(container);
    }
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
    if (connected.some(({ status }) => status !== 'ready' && status !== 'error')) return;
    if (this.finalCheckRequested && !this.finalCheckStarted) {
      this.finalCheckStarted = true;
      // One bounded, pool-wide last cache read. Never start bookmaker work.
      for (const state of connected) {
        if (state.status !== 'ready' || this.mode === 'aa' ||
          (this.mode === 'goal' ? state.target.container.getAttribute(lineupGoalSortSourceAttribute) === 'market' : state.target.container.hasAttribute(lineupCleanSheetSortProbabilityAttribute))) continue;
        state.status = 'queued'; state.attempts = 0;
        state.reconcileFullOverlay = !state.target.container.hasAttribute(lineupSortLightweightReadyAttribute);
        this.queue.push(state);
      }
      if (this.queue.length) { void this.ensurePump(); return; }
    }
    if (this.finalCheckRequested && this.grid) setSortFinalCheck(this.grid, 'complete');
    this.phaseCompleted = true;
    logStatsDiagnostic('lineup-sort-hydration-complete', {
      players: connected.length,
      durationMs: roundedDuration(this.phaseStartedAt),
    });
  }
}
