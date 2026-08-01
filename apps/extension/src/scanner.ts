import type {
  FootballPosition,
  PlayerStats,
  PlayerStatsRequest,
  PlayerStatsSuccessResponse,
} from '@sorare-overlay/shared';
import { hasAnyDisplayData } from '@sorare-overlay/shared';
import { fetchPlayerStats } from './api.js';
import {
  drainDiscoveredCardPictureNames,
  findCardTargets,
  type CardTarget,
} from './dom.js';
import { OverlayView } from './overlay.js';
import {
  clearNativeSorareLineupProbabilityDecorations,
  decorateNativeSorareLineupProbabilities,
} from './sorare-native-ui.js';
import {
  logStatsDiagnostic,
  statsDiagnosticRequestId,
  summarizeStats,
} from './stats-diagnostics.js';

type StatsFetcher = (request: PlayerStatsRequest) => Promise<PlayerStatsSuccessResponse>;
const extensionMountSelector =
  '[data-sorare-overlay-root], [data-sorare-overlay-companion]';
const discoveryAttributes = new Set([
  'href',
  'alt',
  'src',
  'aria-label',
  'data-position',
  'data-card-position',
]);
const viewportPriorityRootMargin = '500px 240px';
const viewportPriorityVerticalMargin = 500;
const viewportPriorityHorizontalMargin = 240;
const viewportPriorityVisible = 2;
const viewportPriorityNearby = 1;

interface PendingTarget {
  slug?: string;
  playerName?: string;
  position?: FootballPosition;
  views: Set<OverlayView>;
  priority: number;
}

interface ScheduledTargetWork {
  target: Pick<PendingTarget, 'slug' | 'playerName' | 'position'>;
  views: Set<OverlayView>;
  priority: number;
  remainingMs: number;
  startedAt?: number;
  timer?: number;
}

interface PendingRefreshWork extends ScheduledTargetWork {
  refreshFixture: boolean;
}

interface BatchJob {
  batch: PendingTarget[];
  priority: number;
  sequence: number;
  resolve: () => void;
}

interface MountedOverlay {
  key: string;
  target: CardTarget;
  view: OverlayView;
  viewportActive: boolean;
  statsRequested: boolean;
}

function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase();
}

function namesLikelyMatch(query: string, displayName: string): boolean {
  const requested = normalizeName(query).split(/\s+/);
  const candidate = normalizeName(displayName).split(/\s+/);
  if (requested.join(' ') === candidate.join(' ')) return true;
  if (requested.length !== 2 || candidate.length !== 2) return false;
  const [requestedFirst, requestedLast] = requested;
  const [candidateFirst, candidateLast] = candidate;
  return Boolean(
    requestedFirst &&
      candidateFirst &&
      requestedLast === candidateLast &&
      Math.min(requestedFirst.length, candidateFirst.length) >= 3 &&
      (requestedFirst.startsWith(candidateFirst) || candidateFirst.startsWith(requestedFirst)),
  );
}

function targetKey(target: Pick<PendingTarget, 'slug' | 'playerName' | 'position'>): string {
  if (target.slug) return `slug:${target.slug}:${target.position ?? 'default'}`;
  return `name:${normalizeName(target.playerName ?? '')}:${target.position ?? 'default'}`;
}

function requestIdentity(
  target: Pick<PendingTarget, 'slug' | 'playerName'>,
): string {
  return target.slug
    ? `slug:${target.slug}`
    : `name:${normalizeName(target.playerName ?? '')}`;
}

function conflictFreeBatches(
  targets: readonly PendingTarget[],
  size: number,
): PendingTarget[][] {
  const batches: PendingTarget[][] = [];
  const identitiesByBatch: Set<string>[] = [];
  for (const target of targets) {
    const identity = requestIdentity(target);
    let batchIndex = batches.findIndex(
      (batch, index) =>
        batch.length < size && !identitiesByBatch[index]?.has(identity),
    );
    if (batchIndex < 0) {
      batchIndex = batches.length;
      batches.push([]);
      identitiesByBatch.push(new Set<string>());
    }
    batches[batchIndex]?.push(target);
    identitiesByBatch[batchIndex]?.add(identity);
  }
  return batches;
}

function targetMatchesStats(
  target: Pick<PendingTarget, 'slug' | 'playerName'>,
  stats: PlayerStats,
): boolean {
  return (
    (target.slug !== undefined && target.slug === stats.slug) ||
    (target.playerName !== undefined &&
      namesLikelyMatch(target.playerName, stats.displayName))
  );
}

function viewportPriorityForRect(rect: DOMRectReadOnly): number {
  if (rect.width <= 0 || rect.height <= 0) return 0;
  const visible =
    rect.bottom > 0 &&
    rect.top < window.innerHeight &&
    rect.right > 0 &&
    rect.left < window.innerWidth;
  if (visible) return viewportPriorityVisible;
  const nearby =
    rect.bottom > -viewportPriorityVerticalMargin &&
    rect.top < window.innerHeight + viewportPriorityVerticalMargin &&
    rect.right > -viewportPriorityHorizontalMargin &&
    rect.left < window.innerWidth + viewportPriorityHorizontalMargin;
  return nearby ? viewportPriorityNearby : 0;
}

export class StatsBatchCoordinator {
  private readonly pending = new Map<string, PendingTarget>();
  private readonly inFlightTargets = new Map<string, PendingTarget>();
  private readonly inFlightFixtureRefreshKeys = new Set<string>();
  private readonly afterFlightTargets = new Map<string, PendingTarget>();
  private readonly batchQueue: BatchJob[] = [];
  private readonly cache = new Map<string, PlayerStats>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly retryWork = new Map<string, ScheduledTargetWork>();
  private readonly deferredRetryUsed = new Set<string>();
  private readonly refreshAttempts = new Map<string, number>();
  private readonly refreshWork = new Map<string, PendingRefreshWork>();
  private readonly fixtureRefreshTargets = new Set<string>();
  private activeBatchCount = 0;
  private batchSequence = 0;
  private timer: number | undefined;
  private includeHistoricalAssists = false;

  constructor(
    private readonly fetcher: StatsFetcher = fetchPlayerStats,
    private readonly debounceMs = 40,
    private readonly retryDelaysMs: readonly number[] = [5_000, 30_000],
    private readonly progressiveBatchSize = 12,
    private readonly maxConcurrentBatches = 2,
    private readonly refreshDelaysMs: readonly number[] = [2_500, 8_000],
    private readonly deferredRetryDelayMs = 750,
  ) {}

  setIncludeHistoricalAssists(enabled: boolean): void {
    if (this.includeHistoricalAssists === enabled) return;
    this.includeHistoricalAssists = enabled;
    if (enabled) this.cache.clear();
  }

  enqueue(target: CardTarget, view: OverlayView, priority = 0): void {
    const key = targetKey(target);
    this.clearRetry(key);
    const cached = this.cachedStatsForTarget(target);
    if (cached) {
      logStatsDiagnostic('cache-hit-render', {
        key,
        target: {
          slug: target.slug ?? null,
          playerName: target.playerName ?? null,
          position: target.position ?? null,
        },
        rendered: summarizeStats(cached),
      });
      view.render(cached);
      if (cached.pendingRefreshes?.length) {
        this.schedulePendingRefresh(
          target,
          [view],
          cached.pendingRefreshes.includes('fixture'),
          priority,
        );
      } else {
        this.clearPendingRefresh(key);
      }
      return;
    }

    this.queueTarget(target, [view], priority);
  }

  setViewViewportActive(
    target: Pick<PendingTarget, 'slug' | 'playerName' | 'position'>,
    view: OverlayView,
    active: boolean,
    priority = 0,
  ): void {
    const key = targetKey(target);
    const retry = this.retryWork.get(key);
    if (retry) {
      retry.views.add(view);
      retry.priority = Math.max(retry.priority, priority);
      if (active) this.startRetryWork(key, retry);
      else if (!this.hasActiveViews(retry.views)) this.pauseScheduledWork(retry);
    }

    const refresh = this.refreshWork.get(key);
    if (refresh) {
      refresh.views.add(view);
      refresh.priority = Math.max(refresh.priority, priority);
      if (active) this.startRefreshWork(key, refresh);
      else if (!this.hasActiveViews(refresh.views)) {
        this.pauseScheduledWork(refresh);
      }
    }
  }

  private queueTarget(
    target: Pick<PendingTarget, 'slug' | 'playerName' | 'position'>,
    views: Iterable<OverlayView>,
    priority = 0,
  ): void {
    const key = targetKey(target);
    const inFlight = this.inFlightTargets.get(key);
    if (inFlight) {
      const requiresFixtureRefresh = this.fixtureRefreshTargets.has(key);
      if (
        !requiresFixtureRefresh ||
        this.inFlightFixtureRefreshKeys.has(key)
      ) {
        for (const view of views) inFlight.views.add(view);
        inFlight.priority = Math.max(inFlight.priority, priority);
        return;
      }
      const followUp = this.afterFlightTargets.get(key) ?? {
        ...(target.slug ? { slug: target.slug } : {}),
        ...(target.playerName ? { playerName: target.playerName } : {}),
        ...(target.position ? { position: target.position } : {}),
        views: new Set<OverlayView>(),
        priority,
      };
      for (const view of views) followUp.views.add(view);
      followUp.priority = Math.max(followUp.priority, priority);
      this.afterFlightTargets.set(key, followUp);
      return;
    }
    const pendingTarget = this.pending.get(key) ?? {
      ...(target.slug ? { slug: target.slug } : {}),
      ...(target.playerName ? { playerName: target.playerName } : {}),
      ...(target.position ? { position: target.position } : {}),
      views: new Set<OverlayView>(),
      priority,
    };
    for (const view of views) pendingTarget.views.add(view);
    pendingTarget.priority = Math.max(pendingTarget.priority, priority);
    this.pending.set(key, pendingTarget);
    if (this.timer === undefined) {
      this.timer = window.setTimeout(() => void this.flush(), this.debounceMs);
    }
  }

  async flush(): Promise<void> {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
    const queued = [...this.pending.values()].sort(
      (left, right) => right.priority - left.priority,
    );
    this.pending.clear();
    if (queued.length === 0) return;

    for (const target of queued) {
      this.inFlightTargets.set(targetKey(target), target);
    }
    const batches = conflictFreeBatches(
      queued,
      Math.max(1, this.progressiveBatchSize),
    );
    await Promise.all(
      batches.map((batch) => this.scheduleBatch(batch)),
    );
  }

  private scheduleBatch(batch: PendingTarget[]): Promise<void> {
    return new Promise((resolve) => {
      this.batchQueue.push({
        batch,
        priority: Math.max(...batch.map((target) => target.priority)),
        sequence: this.batchSequence,
        resolve,
      });
      this.batchSequence += 1;
      this.pumpBatchQueue();
    });
  }

  private pumpBatchQueue(): void {
    const concurrency = Math.max(1, this.maxConcurrentBatches);
    while (this.activeBatchCount < concurrency && this.batchQueue.length > 0) {
      this.batchQueue.sort(
        (left, right) =>
          right.priority - left.priority || left.sequence - right.sequence,
      );
      const job = this.batchQueue.shift();
      if (!job) return;
      this.activeBatchCount += 1;
      void this.runBatchJob(job);
    }
  }

  private async runBatchJob(job: BatchJob): Promise<void> {
    try {
      await this.loadBatch(job.batch);
    } finally {
      for (const target of job.batch) {
        const key = targetKey(target);
        this.inFlightFixtureRefreshKeys.delete(key);
        if (this.inFlightTargets.get(key) === target) {
          this.inFlightTargets.delete(key);
        }
        const followUp = this.afterFlightTargets.get(key);
        if (followUp) {
          this.afterFlightTargets.delete(key);
          this.queueTarget(followUp, followUp.views, followUp.priority);
        }
      }
      this.activeBatchCount -= 1;
      job.resolve();
      this.pumpBatchQueue();
    }
  }

  private async loadBatch(batch: PendingTarget[]): Promise<void> {
    const slugs = [...new Set(batch.flatMap(({ slug }) => (slug ? [slug] : [])))];
    const playerNames = [
      ...new Set(batch.flatMap(({ playerName }) => (playerName ? [playerName] : []))),
    ];
    const positions = Object.fromEntries(
      batch.flatMap(({ slug, playerName, position }) => {
        const identity = slug ?? playerName;
        return identity && position ? [[identity, position]] : [];
      }),
    );
    const includeHistoricalAssists = this.includeHistoricalAssists;
    const refreshFixtures = batch.some((target) =>
      this.fixtureRefreshTargets.has(targetKey(target)),
    );
    if (refreshFixtures) {
      for (const target of batch) {
        this.inFlightFixtureRefreshKeys.add(targetKey(target));
      }
    }

    try {
      const response = await this.fetcher({
        slugs,
        playerNames,
        supportsPartialFormHistory: true,
        ...(Object.keys(positions).length ? { positions } : {}),
        ...(includeHistoricalAssists
          ? { includeHistoricalAssists: true }
          : {}),
        ...(refreshFixtures ? { refreshFixtures: true } : {}),
      });
      const diagnosticRequestId = statsDiagnosticRequestId(response);
      if (includeHistoricalAssists !== this.includeHistoricalAssists) {
        for (const target of batch) {
          this.inFlightTargets.delete(targetKey(target));
          this.queueTarget(target, target.views, target.priority);
        }
        return;
      }
      const deferredPlayerNames = new Set(
        (response.meta.deferredPlayerNames ?? []).map(normalizeName),
      );
      for (const stats of response.data) {
        if (!hasAnyDisplayData(stats)) continue;
        const mergedStats = this.mergeWithCompleteCachedForm(stats);
        this.cache.set(
          targetKey({ slug: mergedStats.slug, position: mergedStats.position }),
          mergedStats,
        );
        this.cache.set(
          targetKey({
            playerName: mergedStats.displayName,
            position: mergedStats.position,
          }),
          mergedStats,
        );
        if (
          batch.some(
            (target) =>
              target.position === undefined &&
              targetMatchesStats(target, mergedStats),
          )
        ) {
          this.cache.set(targetKey({ slug: mergedStats.slug }), mergedStats);
          this.cache.set(
            targetKey({ playerName: mergedStats.displayName }),
            mergedStats,
          );
        }
      }
      for (const target of batch) {
        const key = targetKey(target);
        if (refreshFixtures) this.fixtureRefreshTargets.delete(key);
        const stats =
          this.cache.get(targetKey(target)) ??
          response.data.find(
            (candidate) =>
              hasAnyDisplayData(candidate) &&
              (target.position === undefined || candidate.position === target.position) &&
              targetMatchesStats(target, candidate),
          );
        logStatsDiagnostic('target-resolution', {
          requestId: diagnosticRequestId ?? null,
          target: {
            slug: target.slug ?? null,
            playerName: target.playerName ?? null,
            position: target.position ?? null,
          },
          resolved: stats ? summarizeStats(stats) : null,
          responsePlayers: response.data.map(summarizeStats),
        });
        for (const view of target.views) {
          if (stats && hasAnyDisplayData(stats)) {
            logStatsDiagnostic('render', {
              requestId: diagnosticRequestId ?? null,
              target: {
                slug: target.slug ?? null,
                playerName: target.playerName ?? null,
                position: target.position ?? null,
              },
              rendered: summarizeStats(stats),
            });
            view.render(stats);
          } else if (
            target.playerName &&
            deferredPlayerNames.has(normalizeName(target.playerName))
          ) {
            view.loading();
          } else {
            view.noData();
          }
        }
        if (stats && hasAnyDisplayData(stats)) {
          this.clearRetry(targetKey(target));
        } else {
          this.scheduleRetry(
            target,
            Boolean(
              target.playerName &&
                deferredPlayerNames.has(normalizeName(target.playerName)),
            ),
          );
        }
        if (stats?.pendingRefreshes?.length) {
          this.schedulePendingRefresh(
            target,
            target.views,
            stats.pendingRefreshes.includes('fixture'),
            target.priority,
          );
        } else if (stats) {
          this.clearPendingRefresh(
            key,
            this.fixtureRefreshTargets.has(key) && !refreshFixtures,
          );
        }
      }
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : 'UNKNOWN_ERROR: Stats nicht verfügbar';
      console.warn('[Sorare Overlay] Statistikabruf fehlgeschlagen:', error);
      for (const target of batch) {
        const key = targetKey(target);
        const cached = this.cachedStatsForTarget(target);
        const isFirstTransientFailure = !this.deferredRetryUsed.has(key);
        const retryScheduled = this.scheduleRetry(target, true);
        logStatsDiagnostic('request-failed', {
          target: {
            slug: target.slug ?? null,
            playerName: target.playerName ?? null,
            position: target.position ?? null,
          },
          message,
          retained: cached ? summarizeStats(cached) : null,
          retryScheduled,
          transient: isFirstTransientFailure,
        });
        for (const view of target.views) {
          if (cached) view.render(cached);
          else if (isFirstTransientFailure && retryScheduled) view.loading();
          else view.error();
        }
      }
    }
  }

  private schedulePendingRefresh(
    target: Pick<PendingTarget, 'slug' | 'playerName' | 'position'>,
    views: Iterable<OverlayView>,
    refreshFixture = false,
    priority = 0,
  ): void {
    const key = targetKey(target);
    if (refreshFixture) this.fixtureRefreshTargets.add(key);
    const existing = this.refreshWork.get(key);
    if (existing) {
      for (const view of views) existing.views.add(view);
      existing.priority = Math.max(existing.priority, priority);
      existing.refreshFixture ||= refreshFixture;
      this.startRefreshWork(key, existing);
      return;
    }

    const attempt = this.refreshAttempts.get(key) ?? 0;
    const delay = this.refreshDelaysMs[attempt];
    if (delay === undefined) {
      this.fixtureRefreshTargets.delete(key);
      return;
    }

    this.refreshAttempts.set(key, attempt + 1);
    const work: PendingRefreshWork = {
      target,
      views: new Set(views),
      priority,
      remainingMs: delay,
      refreshFixture,
    };
    this.refreshWork.set(key, work);
    this.startRefreshWork(key, work);
  }

  private startRefreshWork(key: string, work: PendingRefreshWork): void {
    if (work.timer !== undefined || !this.hasActiveViews(work.views)) return;
    work.startedAt = Date.now();
    work.timer = window.setTimeout(() => {
      delete work.timer;
      delete work.startedAt;
      work.remainingMs = 0;
      const connectedViews = this.connectedViews(work.views);
      if (connectedViews.length === 0) {
        this.refreshWork.delete(key);
        this.refreshAttempts.delete(key);
        this.fixtureRefreshTargets.delete(key);
        return;
      }
      const activeViews = connectedViews.filter((view) =>
        view.isViewportPriorityActive(),
      );
      if (activeViews.length === 0) return;
      this.refreshWork.delete(key);
      this.queueTarget(work.target, connectedViews, work.priority);
    }, work.remainingMs);
  }

  private cachedStatsForTarget(
    target: Pick<PendingTarget, 'slug' | 'playerName' | 'position'>,
  ): PlayerStats | undefined {
    const exact = this.cache.get(targetKey(target));
    if (exact || target.position === undefined) return exact;
    return [...this.cache.values()].find(
      (stats) =>
        stats.position === target.position && targetMatchesStats(target, stats),
    );
  }

  private mergeWithCompleteCachedForm(incoming: PlayerStats): PlayerStats {
    const cached = this.cachedStatsForTarget({
      slug: incoming.slug,
      position: incoming.position,
    });
    const isPartialFormRefresh =
      incoming.pendingRefreshes?.includes('formHistory') === true;
    const cachedIsPartialForm =
      cached?.pendingRefreshes?.includes('formHistory') === true;
    if (
      !cached ||
      !isPartialFormRefresh ||
      cachedIsPartialForm
    ) {
      return incoming;
    }

    return {
      ...cached,
      ...incoming,
      aaL10: cached.aaL10,
      cleanSheetL10: cached.cleanSheetL10,
      goalL10: cached.goalL10,
      excludedLowCoverage: cached.excludedLowCoverage,
      ...(cached.mlsAaContext
        ? { mlsAaContext: cached.mlsAaContext }
        : {}),
      ...(cached.historicalGoals
        ? { historicalGoals: cached.historicalGoals }
        : {}),
      ...(cached.historicalAssists
        ? { historicalAssists: cached.historicalAssists }
        : {}),
      ...(cached.historicalDecisives
        ? { historicalDecisives: cached.historicalDecisives }
        : {}),
    };
  }

  private clearPendingRefresh(
    key: string,
    preserveFixtureRefresh = false,
  ): void {
    const work = this.refreshWork.get(key);
    if (work?.timer !== undefined) window.clearTimeout(work.timer);
    this.refreshWork.delete(key);
    this.refreshAttempts.delete(key);
    if (!preserveFixtureRefresh) this.fixtureRefreshTargets.delete(key);
  }

  private scheduleRetry(target: PendingTarget, deferred = false): boolean {
    const key = targetKey(target);
    const existing = this.retryWork.get(key);
    if (existing) {
      for (const view of target.views) existing.views.add(view);
      existing.priority = Math.max(existing.priority, target.priority);
      this.startRetryWork(key, existing);
      return true;
    }

    let delay: number | undefined;
    if (deferred && !this.deferredRetryUsed.has(key)) {
      this.deferredRetryUsed.add(key);
      delay = this.deferredRetryDelayMs;
    } else {
      const attempt = this.retryAttempts.get(key) ?? 0;
      delay = this.retryDelaysMs[attempt];
      if (delay !== undefined) this.retryAttempts.set(key, attempt + 1);
    }
    if (delay === undefined) return false;

    const work: ScheduledTargetWork = {
      target,
      views: new Set(target.views),
      priority: target.priority,
      remainingMs: delay,
    };
    this.retryWork.set(key, work);
    this.startRetryWork(key, work);
    return true;
  }

  private startRetryWork(key: string, work: ScheduledTargetWork): void {
    if (work.timer !== undefined || !this.hasActiveViews(work.views)) return;
    work.startedAt = Date.now();
    work.timer = window.setTimeout(() => {
      delete work.timer;
      delete work.startedAt;
      work.remainingMs = 0;
      const connectedViews = this.connectedViews(work.views);
      if (connectedViews.length === 0) {
        this.retryWork.delete(key);
        this.retryAttempts.delete(key);
        this.deferredRetryUsed.delete(key);
        return;
      }
      const activeViews = connectedViews.filter((view) =>
        view.isViewportPriorityActive(),
      );
      if (activeViews.length === 0) return;
      this.retryWork.delete(key);
      this.queueTarget(work.target, connectedViews, work.priority);
    }, work.remainingMs);
  }

  private connectedViews(views: Iterable<OverlayView>): OverlayView[] {
    return [...views].filter((view) => view.host.isConnected);
  }

  private hasActiveViews(views: Iterable<OverlayView>): boolean {
    return this.connectedViews(views).some((view) =>
      view.isViewportPriorityActive(),
    );
  }

  private pauseScheduledWork(work: ScheduledTargetWork): void {
    if (work.timer === undefined) return;
    window.clearTimeout(work.timer);
    const elapsed = Math.max(0, Date.now() - (work.startedAt ?? Date.now()));
    work.remainingMs = Math.max(0, work.remainingMs - elapsed);
    delete work.timer;
    delete work.startedAt;
  }

  private clearRetry(key: string): void {
    const work = this.retryWork.get(key);
    if (work?.timer !== undefined) window.clearTimeout(work.timer);
    this.retryWork.delete(key);
    this.retryAttempts.delete(key);
    this.deferredRetryUsed.delete(key);
  }
}

export class SorareCardScanner {
  private observer: MutationObserver | undefined;
  private visibilityObserver: IntersectionObserver | undefined;
  private readonly overlays = new Map<HTMLElement, MountedOverlay>();
  private readonly pendingScanRoots = new Set<Element>();
  private mutationFrame: number | undefined;
  private shouldRefreshPositions = false;

  constructor(
    private readonly coordinator = new StatsBatchCoordinator(),
    private readonly onCardPictureNamesDiscovered?: (
      entries: Readonly<Record<string, string>>,
    ) => void,
  ) {}

  configureHistoricalAssistFallback(enabled: boolean): void {
    this.coordinator.setIncludeHistoricalAssists(enabled);
    this.refreshAllOverlays();
  }

  refreshAllOverlays(): void {
    for (const mounted of this.overlays.values()) {
      mounted.statsRequested = false;
      if (mounted.viewportActive) this.requestStats(mounted);
    }
  }

  start(): void {
    if (this.observer) return;
    const root = document.body ?? document.documentElement;
    this.startVisibilityObserver();
    this.scan(root);
    this.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const mutationElement = mutation.target instanceof Element ? mutation.target : null;
        if (mutationElement?.closest(extensionMountSelector)) continue;
        const externalAddedNodes =
          mutation.type === 'childList'
            ? [...mutation.addedNodes].filter(
                (node) =>
                  !(node instanceof Element && node.closest(extensionMountSelector)),
              )
            : [];
        const externalRemovedNodes =
          mutation.type === 'childList'
            ? [...mutation.removedNodes].filter(
                (node) =>
                  !(node instanceof Element && node.matches(extensionMountSelector)),
              )
            : [];
        if (
          mutation.type === 'childList' &&
          externalAddedNodes.length === 0 &&
          externalRemovedNodes.length === 0
        ) {
          continue;
        }
        this.shouldRefreshPositions = true;
        if (mutation.type === 'attributes') {
          if (mutation.attributeName && discoveryAttributes.has(mutation.attributeName)) {
            this.queueScanRoot(mutation.target as Element);
            this.queueScanContext(mutation.target);
          }
        } else {
          for (const added of externalAddedNodes) {
            if (added instanceof Element) this.queueScanRoot(added);
          }
          this.queueScanContext(mutation.target);
        }
      }
      this.scheduleMutationFlush();
    });
    this.observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        'href',
        'alt',
        'src',
        'class',
        'style',
        'hidden',
        'inert',
        'aria-hidden',
        'aria-label',
        'data-position',
        'data-card-position',
      ],
    });
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = undefined;
    this.visibilityObserver?.disconnect();
    this.visibilityObserver = undefined;
    if (this.mutationFrame !== undefined) {
      if (typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(this.mutationFrame);
      } else {
        window.clearTimeout(this.mutationFrame);
      }
      this.mutationFrame = undefined;
    }
    this.pendingScanRoots.clear();
    this.shouldRefreshPositions = false;
    for (const { view } of this.overlays.values()) view.destroy();
    this.overlays.clear();
    clearNativeSorareLineupProbabilityDecorations();
  }

  scan(root: ParentNode): void {
    decorateNativeSorareLineupProbabilities(root);
    const targets = findCardTargets(root);
    const discoveredPictureNames = drainDiscoveredCardPictureNames();
    if (Object.keys(discoveredPictureNames).length > 0) {
      this.onCardPictureNamesDiscovered?.(discoveredPictureNames);
      if (root !== document && root !== document.documentElement) {
        this.queueScanRoot(document.documentElement);
        this.scheduleMutationFlush();
      }
    }
    for (const target of targets) {
      this.mountTarget(target);
    }
  }

  private mountTarget(target: CardTarget): void {
    const key = targetKey(target);
    const mounted = this.overlays.get(target.container);
    if (mounted?.key === key) return;
    if (mounted) {
      this.visibilityObserver?.unobserve(target.container);
      mounted.view.destroy();
    }
    const view = new OverlayView(
      target.container,
      {
        ...(target.slug ? { slug: target.slug } : {}),
        ...(target.playerName ? { playerName: target.playerName } : {}),
      },
      target.position,
    );
    target.container.dataset.sorareOverlayKey = key;
    const priority = this.visibilityObserver
      ? viewportPriorityForRect(target.container.getBoundingClientRect())
      : viewportPriorityNearby;
    const mountedOverlay: MountedOverlay = {
      key,
      target,
      view,
      viewportActive: priority > 0,
      statsRequested: false,
    };
    this.overlays.set(target.container, mountedOverlay);
    if (this.visibilityObserver) {
      this.visibilityObserver.observe(target.container);
      view.setViewportPriorityActive(mountedOverlay.viewportActive);
    }
    if (mountedOverlay.viewportActive) {
      this.requestStats(mountedOverlay, priority);
    }
  }

  private reconcileMountedOverlays(): void {
    for (const [container, mounted] of [...this.overlays]) {
      const currentTarget = container.isConnected
        ? findCardTargets(container).find(
            (candidate) => candidate.container === container,
          )
        : undefined;
      if (!currentTarget) {
        this.visibilityObserver?.unobserve(container);
        mounted.view.destroy();
        delete container.dataset.sorareOverlayKey;
        this.overlays.delete(container);
        continue;
      }
      if (targetKey(currentTarget) === mounted.key) continue;
      this.visibilityObserver?.unobserve(container);
      mounted.view.destroy();
      this.overlays.delete(container);
      this.mountTarget(currentTarget);
    }
  }

  private cleanupDisconnectedOverlays(): void {
    for (const [container, { view }] of this.overlays) {
      if (container.isConnected) continue;
      this.visibilityObserver?.unobserve(container);
      view.destroy();
      this.overlays.delete(container);
    }
  }

  private queueScanRoot(root: Element): void {
    this.pendingScanRoots.add(root);
  }

  private queueScanContext(node: Node): void {
    let context =
      node instanceof Element
        ? node
        : node.parentElement;
    for (let depth = 0; context && depth < 4; depth += 1) {
      this.pendingScanRoots.add(context);
      context = context.parentElement;
    }
  }

  private scheduleMutationFlush(): void {
    if (
      this.mutationFrame !== undefined ||
      (this.pendingScanRoots.size === 0 && !this.shouldRefreshPositions)
    ) {
      return;
    }
    const flush = (): void => {
      this.mutationFrame = undefined;
      this.flushMutations();
    };
    this.mutationFrame =
      typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame(flush)
        : window.setTimeout(flush, 0);
  }

  private flushMutations(): void {
    const roots = [...this.pendingScanRoots];
    this.pendingScanRoots.clear();
    for (const root of roots) this.scan(root);
    if (roots.length > 0) {
      this.reconcileMountedOverlays();
    } else {
      this.cleanupDisconnectedOverlays();
    }
    if (this.shouldRefreshPositions) {
      this.shouldRefreshPositions = false;
      for (const { view, viewportActive } of this.overlays.values()) {
        if (viewportActive) view.refreshPosition();
      }
    }
  }

  private startVisibilityObserver(): void {
    if (
      this.visibilityObserver ||
      typeof IntersectionObserver === 'undefined'
    ) {
      return;
    }
    this.visibilityObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!(entry.target instanceof HTMLElement)) continue;
          const mounted = this.overlays.get(entry.target);
          if (!mounted) continue;
          const priority = entry.isIntersecting
            ? Math.max(
                viewportPriorityNearby,
                viewportPriorityForRect(entry.boundingClientRect),
              )
            : 0;
          const viewportActive = priority > 0;
          if (mounted.viewportActive !== viewportActive) {
            mounted.viewportActive = viewportActive;
            mounted.view.setViewportPriorityActive(viewportActive);
            this.coordinator.setViewViewportActive(
              mounted.target,
              mounted.view,
              viewportActive,
              priority,
            );
          }
          if (viewportActive) this.requestStats(mounted, priority);
        }
      },
      {
        root: null,
        rootMargin: viewportPriorityRootMargin,
        threshold: 0,
      },
    );
  }

  private requestStats(
    mounted: MountedOverlay,
    priority = viewportPriorityNearby,
  ): void {
    if (mounted.statsRequested) return;
    mounted.statsRequested = true;
    this.coordinator.enqueue(mounted.target, mounted.view, priority);
  }
}
