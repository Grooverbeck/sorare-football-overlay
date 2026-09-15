import type {
  FootballPosition,
  HistoricalMarketWindow,
  LineupSortValue,
  LineupSortValuesRequest,
  LineupSortValuesSuccessResponse,
  LineupSortReadiness,
} from '@sorare-overlay/shared';
import { readSortReadiness, setSortReadiness, readinessIsSettled, uniformReadiness, setSortFinalCheck, sortFinalCheckAttribute } from './lineup-sort-readiness.js';
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
  finalCheckMetric?: keyof LineupSortReadiness;
  finalCheckRevision?: number;
  verified?: Partial<Record<keyof LineupSortReadiness, { signature: string; at: number }>>;
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

interface HydrationBatchGroup {
  scope: string;
  states: HydrationState[];
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
  const readiness = readSortReadiness(container);
  if (readiness ? !Object.values(readiness).some(readinessIsSettled)
    : container.getAttribute(lineupSortDataReadyAttribute) !== 'true') {
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
  // A known slug must never be replaced by a different player with a similar name.
  return target.slug ? target.slug === value.slug : Boolean(
    target.playerName && playerNamesLikelyMatch(target.playerName, value.displayName),
  );
}

function sameSortValue(left: LineupSortValue, right: LineupSortValue): boolean {
  // A name and an automatic-position slug can resolve to the same record.
  // Collapse only equivalent answers, never choose between conflicting
  // players, card positions, fixtures, readiness states or metric snapshots.
  return left.slug === right.slug &&
    left.displayName === right.displayName &&
    left.position === right.position &&
    left.fixtureIdentity === right.fixtureIdentity &&
    left.fixtureRefresh?.key === right.fixtureRefresh?.key &&
    left.fixtureRefresh?.nextCheckAt === right.fixtureRefresh?.nextCheckAt &&
    left.readiness?.goal === right.readiness?.goal &&
    left.readiness?.aa === right.readiness?.aa &&
    left.readiness?.cleanSheet === right.readiness?.cleanSheet &&
    left.goal?.probability === right.goal?.probability &&
    left.goal?.source === right.goal?.source &&
    left.aa === right.aa &&
    left.cleanSheet === right.cleanSheet;
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
        // A learned card may carry BOTH identities. Send exactly one so a
        // 50-card batch cannot exceed the API's combined identity limit.
        !target.slug && target.playerName ? [target.playerName] : [],
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
    if (this.suspended) return;
    if (this.finalCheckRequested && !this.grid?.hasAttribute(sortFinalCheckAttribute) && !this.grid?.hasAttribute('data-sorare-overlay-lineup-sort-hydration')) return;
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
    ()=>this.suspended || !this.grid?.isConnected || !document.querySelector('[data-sorare-overlay-lineup-sort-trigger-label]') ? [] :
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
  private readonly resolvedIdentities = new Map<string, { slug: string; position: FootballPosition } | null>();
  private readonly positionlessSnapshots = new Map<
    string,
    PositionlessSnapshotAlias
  >();
  private readonly queue: HydrationState[] = [];
  private readonly retryTimers = new Map<HTMLElement, number>();
  private generation = 0;
  private suspended = false;
  private readonly pausedReconcileTeams = new Set<string>();
  private pausedReconcileAll = false;
  private marketCacheRevision = 0;
  private pumpPromise: Promise<void> | undefined;
  private pumpGeneration: number | undefined;
  private batchTimer: number | undefined;
  private finishBatchDelay: (() => void) | undefined;
  private historicalGoalWindow: HistoricalMarketWindow | null = null;
  private phaseStartedAt = 0;
  private phaseCompleted = true;
  private finalCheckRequested = false;
  private finalCheckStarted = false;
  private discoveryPending = false;
  private mode: 'goal' | 'aa' | 'clean-sheet' = 'goal';

  suspend(): void {
    this.suspended = true;
    this.generation += 1;
    this.releaseBatchDelay();
    this.fixtureScheduler.stop();
    for (const timer of this.retryTimers.values()) window.clearTimeout(timer);
    this.retryTimers.clear();
    this.queue.length = 0;
    for (const state of this.states.values()) {
      if (state.status === 'in-flight' || state.status === 'retry') state.status = 'queued';
    }
  }

  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    for (const state of this.states.values()) {
      if (state.status === 'queued') this.queue.push(state);
    }
    const teams = [...this.pausedReconcileTeams];
    const all = this.pausedReconcileAll;
    this.pausedReconcileTeams.clear();
    this.pausedReconcileAll = false;
    if (all || teams.length) void this.reconcileMissingGoals(all ? undefined : teams);
    this.fixtureScheduler.schedule();
    void this.ensurePump();
  }

  cancel(): void {
    // Already dispatched service-worker requests may finish, but their old
    // generation cannot write values or enqueue any more work.
    this.suspend();
    this.grid?.removeEventListener('sorare-overlay:lineup-sort-value-changed', this.handleValueChange);
    this.grid?.removeAttribute(sortFinalCheckAttribute);
    this.states.clear();
    this.snapshots.clear();
    this.resolvedIdentities.clear();
    this.positionlessSnapshots.clear();
    this.pausedReconcileTeams.clear();
    this.pausedReconcileAll = false;
    this.grid = null;
    this.phaseCompleted = true;
    this.finalCheckRequested = false;
    this.finalCheckStarted = false;
    this.discoveryPending = false;
  }

  configureMode(mode: 'goal' | 'aa' | 'clean-sheet'): void {
    if (this.mode === mode) return;
    if (!this.grid) { this.mode = mode; return; }
    const wasSuspended = this.suspended;
    this.suspend();
    this.mode = mode;
    if (this.grid) {
      this.finalCheckRequested = true; this.finalCheckStarted = false; this.phaseCompleted = false;
      setSortFinalCheck(this.grid, 'pending');
    }
    for (const state of this.states.values()) {
      const readiness = readSortReadiness(state.target.container) ?? uniformReadiness('pending');
      const settled = readinessIsSettled(readiness[this.metricKey()]);
      state.status = settled ? 'ready' : 'queued';
      state.attempts = 0;
      delete state.finalCheckMetric;
      if (!settled) setSortReadiness(state.target.container, { ...readiness, [this.metricKey()]: 'pending' });
    }
    if (!wasSuspended) this.resume();
  }

  private metricKey(): keyof LineupSortReadiness {
    return this.mode === 'clean-sheet' ? 'cleanSheet' : this.mode;
  }

  constructor(
    private readonly fetcher: SortValuesFetcher = fetchLineupSortValues,
    private readonly batchSize = 50,
    private readonly retryDelaysMs: readonly number[] = [1_000, 5_000, 15_000, 30_000],
    private readonly coalesceDelayMs = 24,
  ) {}

  finalizePool(grid: HTMLElement): void {
    if (this.grid !== grid || this.suspended) return;
    this.discoveryPending = false;
    this.finalCheckRequested = true;
    this.finalCheckStarted = false;
    this.phaseCompleted = false;
    setSortFinalCheck(grid, 'pending');
    if (!this.pumpPromise) this.maybeLogCompletion();
  }

  beginPoolReconciliation(grid: HTMLElement): void {
    if (this.grid !== grid) this.reset(grid);
    this.discoveryPending = true;
    setSortFinalCheck(grid, 'pending');
  }

  retryOpenValues(): void {
    if (!this.grid?.isConnected || this.suspended) return;
    this.finalCheckRequested = true;
    this.finalCheckStarted = false;
    this.phaseCompleted = false;
    setSortFinalCheck(this.grid, 'pending');
    for (const state of this.states.values()) {
      const readiness = readSortReadiness(state.target.container) ?? uniformReadiness('pending');
      if (readiness[this.metricKey()] !== 'error') continue;
      state.status = 'queued'; state.attempts = 0;
      setSortReadiness(state.target.container, { ...readiness, [this.metricKey()]: 'pending' });
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
    const resolved = this.resolvedIdentities.get(key);
    if (resolved && snapshot.position === resolved.position) {
      const canonical = { ...target, slug: resolved.slug, position: resolved.position };
      const canonicalKey = playerTargetKey(canonical);
      if (canonicalKey !== key) {
        this.snapshots.set(canonicalKey, snapshot);
        this.rememberPositionlessSnapshot(canonical, snapshot);
      }
    }
    this.rememberPositionlessSnapshot(target, snapshot);
  }

  private rememberPositionlessSnapshot(target: CardTarget, snapshot: SortValueSnapshot): void {
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
    const resolved = this.resolvedIdentities.get(key);
    const exact = (resolved ? this.snapshots.get(playerTargetKey({ ...target, ...resolved })) : undefined) ?? this.snapshots.get(key);
    const currentFixture = target.container.getAttribute(fixtureIdentityAttribute);
    // Do not carry a cached price back over a fixture transition already known
    // by the live card, including an explicit retired/no-fixture state.
    const alias = target.position === undefined ? this.positionlessSnapshots.get(positionlessTargetKey(target)) : undefined;
    const snapshot = exact ?? (alias?.ambiguous ? undefined : alias?.snapshot);
    if (snapshot && currentFixture !== null && snapshot.fixtureIdentity !== undefined && currentFixture !== snapshot.fixtureIdentity) return undefined;
    return snapshot;
  }

  private rememberResolvedIdentity(state: HydrationState, value: LineupSortValue): void {
    const previous = this.resolvedIdentities.get(state.key);
    if (previous === null) return;
    if (previous && (previous.slug !== value.slug || previous.position !== value.position)) {
      this.resolvedIdentities.set(state.key, null);
      return;
    }
    const resolved = { slug: value.slug, position: value.position };
    this.resolvedIdentities.set(state.key, resolved);
    const canonicalKey = playerTargetKey({ ...state.target, ...resolved });
    this.resolvedIdentities.set(canonicalKey, resolved);
  }

  private requestTarget(state: HydrationState): CardTarget {
    const resolved = this.resolvedIdentities.get(state.key);
    // Learn identity, not a new position override. Automatic and explicit
    // card positions have different backend form-cache keys and semantics.
    return resolved ? { ...state.target, slug: resolved.slug } : state.target;
  }

  private requestScope(state: HydrationState): string {
    const target = this.requestTarget(state);
    return JSON.stringify([playerRequestIdentity(target), target.position ?? null,
      target.teamSlug ?? null, target.container.getAttribute(fixtureIdentityAttribute),
      Boolean(state.fixtureRefreshRequest)]);
  }

  hydrate(
    grid: HTMLElement,
    targets: readonly CardTarget[] = findCardTargets(grid),
  ): Promise<void> {
    if (this.grid !== grid) this.reset(grid);
    if (this.suspended) return Promise.resolve();
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
      const cachedSnapshot = this.snapshotForTarget(target, key);
      if (existing) {
        const previousTarget = this.requestTarget(existing);
        const previousResolved = this.resolvedIdentities.get(existing.key);
        const resolved = this.resolvedIdentities.get(key);
        const nextTarget = resolved ? { ...target, ...resolved } : target;
        const samePlayer = playerRequestIdentity(previousTarget) === playerRequestIdentity(nextTarget) &&
          (previousTarget.position ?? previousResolved?.position) === nextTarget.position && previousTarget.teamSlug === nextTarget.teamSlug;
        this.removeState(target.container);
        if (!cachedSnapshot || !samePlayer) this.clearTargetValues(target.container, samePlayer);
      }

      const lightweightKey = target.container.getAttribute(
        lineupSortLightweightReadyAttribute,
      );
      if (lightweightKey && lightweightKey !== key && (!existing || !cachedSnapshot)) {
        this.clearTargetValues(target.container);
      }

      const existingReadiness = readSortReadiness(target.container);
      if (!existing && (!lightweightKey || lightweightKey === key) &&
        target.container.getAttribute(lineupSortDataReadyAttribute) === 'true' &&
        (!existingReadiness || readinessIsSettled(existingReadiness[this.metricKey()]))
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

      const snapshot = cachedSnapshot;
      if (snapshot) {
        this.applySnapshot(target, key, snapshot);
        const settled = !snapshot.readiness || readinessIsSettled(snapshot.readiness[this.metricKey()]);
        const state: HydrationState = {
          key,
          target,
          status: settled ? 'ready' : 'queued',
          attempts: 0,
        };
        this.states.set(target.container, state);
        if (!settled) { this.queue.push(state); discovered += 1; }
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
    // Even an update received during an in-flight read invalidates that
    // read's ability to certify a later skipped final check.
    this.marketCacheRevision += 1;
    const grid = this.grid;
    if (!grid?.isConnected) return Promise.resolve();
    const expectedTeams = teamSlugs
      ? [...new Set([...teamSlugs].map((slug) => slug.trim().toLowerCase()))]
      : null;
    if (this.suspended) {
      if (expectedTeams) for (const team of expectedTeams) this.pausedReconcileTeams.add(team);
      else this.pausedReconcileAll = true;
      return Promise.resolve();
    }
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
      delete state.verified;
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
    this.releaseBatchDelay();
    this.pausedReconcileTeams.clear();
    this.pausedReconcileAll = false;
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
    this.resolvedIdentities.clear();
    this.positionlessSnapshots.clear();
    this.queue.length = 0;
    this.grid = null;
    this.phaseCompleted = true;
    this.finalCheckRequested = false;
    this.finalCheckStarted = false;
    this.discoveryPending = false;
  }

  private reset(grid: HTMLElement, clearLightweightValues = false): void {
    this.releaseBatchDelay();
    this.suspended = false;
    this.pausedReconcileTeams.clear();
    this.pausedReconcileAll = false;
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
    this.resolvedIdentities.clear();
    this.positionlessSnapshots.clear();
    this.queue.length = 0;
    this.grid = grid;
    grid.addEventListener('sorare-overlay:lineup-sort-value-changed', this.handleValueChange);
    this.phaseCompleted = true;
    this.finalCheckRequested = false;
    this.finalCheckStarted = false;
    this.discoveryPending = false;
  }

  private effectiveBatchSize(): number {
    return Math.min(50, Math.max(1, Math.floor(this.batchSize)));
  }

  private ensurePump(): Promise<void> {
    if (this.suspended) return Promise.resolve();
    if (this.queue.length >= this.effectiveBatchSize()) this.releaseBatchDelay();
    const generation = this.generation;
    if (this.pumpPromise && this.pumpGeneration === generation) {
      return this.pumpPromise;
    }
    // Coalesce same-turn discoveries before considering a bounded wait for
    // small batches. Concurrent backend requests remain limited to one.
    const promise = Promise.resolve().then(() => this.pump(generation)).finally(() => {
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
    while (!this.suspended && generation === this.generation) {
      if (this.queue.length > 0 && this.queue.length < this.effectiveBatchSize() && this.coalesceDelayMs > 0) {
        await new Promise<void>(resolve => {
          this.finishBatchDelay = resolve;
          this.batchTimer = window.setTimeout(() => this.releaseBatchDelay(), this.coalesceDelayMs);
        });
        if (this.suspended || generation !== this.generation) return;
      }
      const groups = this.takeBatch();
      if (groups.length === 0) return;
      const batch = groups.flatMap(group => group.states);
      const requestedCacheRevision = this.marketCacheRevision;
      const startedAt = performance.now();
      for (const state of batch) {
        state.status = 'in-flight';
        state.attempts += 1;
        if (state.finalCheckMetric) state.finalCheckRevision = this.marketCacheRevision;
        state.fullDataRevisionAtRequest =
          state.target.container.getAttribute(
            lineupSortFullDataRevisionAttribute,
          );
      }
      try {
        const response = await this.fetcher(
          requestForBatch(groups.map(group => {
            const state = group.states[0]!;
            return { ...state, target: this.requestTarget(state) };
          }), this.historicalGoalWindow),
        );
        if (generation !== this.generation) return;
        // A duplicate card can be discovered while the common request is in
        // flight. Join only an exact scope; other positions/teams/fixtures wait.
        const scopes = new Set(groups.map(group => group.scope));
        for (const state of this.queue) {
          if (state.status !== 'queued' || this.states.get(state.target.container) !== state ||
            !state.target.container.isConnected || !scopes.has(this.requestScope(state))) continue;
          state.status = 'in-flight'; state.attempts += 1;
          state.fullDataRevisionAtRequest = state.target.container.getAttribute(lineupSortFullDataRevisionAttribute);
          if (state.finalCheckMetric) state.finalCheckRevision = requestedCacheRevision;
          batch.push(state);
        }
        this.applyResponse(batch, response);
        logStatsDiagnostic('lineup-sort-batch-complete', {
          requested: groups.length,
          cards: batch.length,
          returned: response.data.length,
          attempt: Math.max(...batch.map(({ attempts }) => attempts)),
          durationMs: roundedDuration(startedAt),
          backendDurationMs: response.meta.durationMs,
        });
      } catch (error) {
        if (generation !== this.generation) return;
        logStatsDiagnostic('lineup-sort-batch-failed', {
          requested: groups.length,
          attempt: Math.max(...batch.map(({ attempts }) => attempts)),
          durationMs: roundedDuration(startedAt),
          message: error instanceof Error ? error.message : String(error),
        });
        for (const state of batch) this.retryOrComplete(state);
      }
    }
  }

  private releaseBatchDelay(): void {
    if (this.batchTimer !== undefined) window.clearTimeout(this.batchTimer);
    this.batchTimer = undefined;
    const finish = this.finishBatchDelay;
    this.finishBatchDelay = undefined;
    finish?.();
  }

  private takeBatch(): HydrationBatchGroup[] {
    const batch: HydrationBatchGroup[] = [];
    const identities = new Map<string, HydrationBatchGroup>();
    const deferred: HydrationState[] = [];
    const seen = new Set<HydrationState>();
    for (const state of this.queue.splice(0)) {
      if (
        seen.has(state) ||
        state.status !== 'queued' ||
        !state.target.container.isConnected ||
        this.states.get(state.target.container) !== state
      ) {
        continue;
      }
      seen.add(state);
      const identity = playerRequestIdentity(this.requestTarget(state));
      const scope = this.requestScope(state);
      const existing = identities.get(identity);
      if (existing?.scope === scope) {
        existing.states.push(state);
      } else if (existing || batch.length >= this.effectiveBatchSize()) {
        deferred.push(state);
      } else {
        const group = { scope, states: [state] };
        identities.set(identity, group);
        batch.push(group);
      }
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
      if (!state.target.container.isConnected || this.states.get(state.target.container) !== state) continue;
      const candidates = response.data.filter((candidate) =>
        targetMatchesValue(this.requestTarget(state), candidate),
      );
      const first = candidates[0];
      const value = first && candidates.every(candidate => sameSortValue(first, candidate))
        ? first : undefined;
      if (value) {
        this.rememberResolvedIdentity(state, value);
        const before=state.target.container.getAttribute(fixtureIdentityAttribute);
        this.completeState(state, value);
        const readiness = readSortReadiness(state.target.container);
        if (readiness?.[this.metricKey()] === 'pending') this.retryOrComplete(state);
        else if (readiness?.[this.metricKey()] === 'error') state.status = 'error';
        const sameFixture = value.fixtureIdentity === undefined ||
          (value.fixtureIdentity ?? '') === state.target.container.getAttribute(fixtureIdentityAttribute);
        if (state.finalCheckMetric && sameFixture && state.finalCheckRevision === this.marketCacheRevision &&
          readinessIsSettled(value.readiness?.[state.finalCheckMetric] ?? 'ready') &&
          readinessIsSettled(readiness?.[state.finalCheckMetric] ?? 'pending')) {
          (state.verified ??= {})[state.finalCheckMetric] = {
            signature: this.verificationSignature(state, state.finalCheckMetric), at: Date.now(),
          };
        }
        delete state.finalCheckMetric;
        delete state.finalCheckRevision;
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
      const current = readSortReadiness(state.target.container) ?? uniformReadiness('pending');
      const readiness = { ...current };
      for (const metric of ['goal', 'aa', 'cleanSheet'] as const) {
        if (!readinessIsSettled(readiness[metric])) readiness[metric] = 'error';
      }
      const settled = readinessIsSettled(readiness[this.metricKey()]);
      state.status = settled ? 'ready' : 'error';
      setSortReadiness(state.target.container, readiness);
      setLineupSortDataReady(state.target.container, settled);
      delete state.finalCheckMetric;
      this.preserve(state.target);
      return;
    }
    state.status = 'retry';
    const generation = this.generation;
    const timer = window.setTimeout(() => {
      this.retryTimers.delete(state.target.container);
      if (
        this.suspended || generation !== this.generation ||
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
      // Complete missing metrics independently. Settled full-overlay AA/CS
      // values still belong to the newer full response, not this cache read.
      const currentReadiness = readSortReadiness(container) ?? incomingReadiness;
      const updateGoal = !readinessIsSettled(currentReadiness.goal) || value?.goal?.source === 'market';
      if (updateGoal && !preserveGoal) setLineupGoalSortValue(
        container,
        value?.goal?.probability ?? null,
        value?.goal?.source,
      );
      const nextReadiness = { ...currentReadiness, goal: currentGoalIsMarket ? 'ready' as const : updateGoal ? incomingReadiness.goal : currentReadiness.goal };
      if (!readinessIsSettled(currentReadiness.aa) && readinessIsSettled(incomingReadiness.aa)) {
        setLineupAaSortValue(container, value?.aa ?? null);
        nextReadiness.aa = incomingReadiness.aa;
      }
      if (!readinessIsSettled(currentReadiness.cleanSheet) && readinessIsSettled(incomingReadiness.cleanSheet)) {
        setLineupCleanSheetSortValue(container, value?.cleanSheet ?? null);
        nextReadiness.cleanSheet = incomingReadiness.cleanSheet;
      }
      setSortReadiness(container, nextReadiness);
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
    if (readinessIsSettled(incomingReadiness.aa)) setLineupAaSortValue(container, value?.aa ?? null);
    if (readinessIsSettled(incomingReadiness.cleanSheet)) setLineupCleanSheetSortValue(container, value?.cleanSheet ?? null);
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
    setLineupSortDataReady(container, !snapshot.readiness || readinessIsSettled(snapshot.readiness[this.metricKey()]));
  }

  private clearTargetValues(container: HTMLElement, preserveFixture = false): void {
    setSortReadiness(container, null);
    if (!preserveFixture) {
      container.removeAttribute(fixtureRefreshAttribute);
      container.removeAttribute(fixtureIdentityAttribute);
      container.removeAttribute(retiredFixtureAttribute);
    }
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
    if (this.suspended || this.discoveryPending || this.phaseCompleted || this.retryTimers.size > 0) return;
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
        const metric = this.metricKey();
        const verified = state.verified?.[metric];
        // Reuse only an actual completed final read, briefly, in this exact
        // pool/identity/fixture/window. The first pool-wide pass is never skipped.
        if (verified && Date.now() - verified.at < 30_000 &&
          verified.signature === this.verificationSignature(state, metric)) continue;
        state.finalCheckMetric = metric;
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

  private verificationSignature(state: HydrationState, metric: keyof LineupSortReadiness): string {
    const container = state.target.container;
    return JSON.stringify([state.key, this.historicalGoalWindow, metric, this.marketCacheRevision,
      container.getAttribute(fixtureIdentityAttribute), readSortReadiness(container)?.[metric],
      container.getAttribute(metric === 'goal' ? lineupGoalSortProbabilityAttribute : metric === 'aa' ? lineupAaSortValueAttribute : lineupCleanSheetSortProbabilityAttribute),
      metric === 'goal' ? container.getAttribute(lineupGoalSortSourceAttribute) : null]);
  }
}
