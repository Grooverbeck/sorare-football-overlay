import type {
  FootballPosition,
  HistoricalMarketWindow,
  PlayerMarketOdds,
  PlayerMarketSnapshot,
  PlayerMarketSnapshotsRequest,
  PlayerMarketSnapshotsSuccessResponse,
  PlayerStats,
  PlayerStatsRequest,
  PlayerStatsSuccessResponse,
} from '@sorare-overlay/shared';
import { hasAnyDisplayData } from '@sorare-overlay/shared';
import { fetchPlayerMarketSnapshots, fetchPlayerStats } from './api.js';
import {
  drainDiscoveredCardPictureNames,
  extractCardPictureId,
  extractPlayerName,
  findCardTargets,
  type CardTarget,
} from './dom.js';
import { OverlayView } from './overlay.js';
import { LineupSortHydrator } from './lineup-sort-hydrator.js';
import {
  normalizePlayerName as normalizeName,
  playerNamesLikelyMatch as namesLikelyMatch,
  playerRequestIdentity as requestIdentity,
  playerTargetKey as targetKey,
  teamSlugsLikelyMatch,
} from './player-identity.js';
import {
  LineupCardSorter,
  activeLineupPosition,
  lineupAaSortOptionAttribute,
  lineupGoalSortOptionAttribute,
  lineupPoolProgressEvent,
  lineupPoolReadyEvent,
  lineupSortDataReadyAttribute,
  lineupSortHydrationGridAttribute,
  lineupSortLightweightReadyAttribute,
  setLineupSortDataReady,
  setLineupSortPosition,
} from './lineup-sort.js';
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
type MarketSnapshotsFetcher = (
  request: PlayerMarketSnapshotsRequest,
) => Promise<PlayerMarketSnapshotsSuccessResponse>;
type MarketCacheUpdateListener = (teamSlugs: readonly string[]) => void;
const extensionMountSelector =
  '[data-sorare-overlay-root], [data-sorare-overlay-companion]';
const deferredOverlayKeyAttribute = 'data-sorare-overlay-deferred-key';
const trackedOverlayContainerSelector =
  `[data-sorare-overlay-key], [${deferredOverlayKeyAttribute}]`;
const extensionMutationSelector =
  `${extensionMountSelector}, ` +
  `[${lineupGoalSortOptionAttribute}], ` +
  `[${lineupAaSortOptionAttribute}]`;
const discoveryAttributes = new Set([
  'href',
  'alt',
  'src',
  'aria-label',
  'aria-expanded',
  'data-position',
  'data-card-position',
]);
const globalLayoutStateAttributes = ['hidden', 'inert', 'aria-hidden'] as const;
const globalOverlayLayoutSelector =
  'dialog, [role="dialog"], [aria-modal="true"]';
const viewportPriorityRootMargin = '500px 240px';
const viewportPriorityVerticalMargin = 500;
const viewportPriorityHorizontalMargin = 240;
const viewportPriorityVisible = 2;
const viewportPriorityNearby = 1;
const mutationFlushBudgetMs = 7;
const mutationFlushMaxRoots = 16;
const poolReadyScanBudgetMs = 7;
const poolReadyScanMaxRoots = 16;
const poolOverlayDemotionBudgetMs = 7;
const poolOverlayDemotionMaxCards = 16;
const defaultMaxCachedAliases = 8_192;
const defaultCachedAliasTtlMs = 6 * 60 * 60 * 1_000;
const defaultMarketSnapshotRecheckTtlMs = 60_000;

interface CachedAliasMetadata {
  lastAccessedAt: number;
  sequence: number;
}

export interface StatsBatchCoordinatorOptions {
  maxCachedAliases?: number;
  cachedAliasTtlMs?: number;
  marketSnapshotRecheckTtlMs?: number;
  marketSnapshotBatchSize?: number;
  marketSnapshotsFetcher?: MarketSnapshotsFetcher;
}

interface PendingTarget {
  slug?: string;
  playerName?: string;
  position?: FootballPosition;
  teamSlug?: string;
  views: Set<OverlayView>;
  priority: number;
}

type TargetIdentity = Pick<
  PendingTarget,
  'slug' | 'playerName' | 'position' | 'teamSlug'
>;

interface ScheduledTargetWork {
  target: TargetIdentity;
  views: Set<OverlayView>;
  priority: number;
  remainingMs: number;
  startedAt?: number;
  timer?: number;
}

interface PendingRefreshWork extends ScheduledTargetWork {
  refreshFixture: boolean;
  refreshMarketOdds: boolean;
}

interface BatchJob {
  batch: PendingTarget[];
  kind: 'stats' | 'market-snapshots';
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

interface DeferredOverlay {
  key: string;
  target: CardTarget;
}

function isElementNode(node: Node): node is Element {
  return node.nodeType === 1;
}

function outermostElements(elements: Iterable<Element>): Element[] {
  const candidates = new Set(elements);
  return [...candidates].filter((candidate) => {
    let ancestor = candidate.parentElement;
    while (ancestor) {
      if (candidates.has(ancestor)) return false;
      ancestor = ancestor.parentElement;
    }
    return true;
  });
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

function canTrackStats(stats: PlayerStats): boolean {
  return hasAnyDisplayData(stats) || Boolean(stats.pendingRefreshes?.length);
}

function samePlayerTeamFixture(
  left: NonNullable<PlayerStats['nextGame']>,
  right: NonNullable<PlayerStats['nextGame']>,
): boolean {
  return (
    left.date === right.date &&
    normalizeName(left.homeTeamName ?? '') ===
      normalizeName(right.homeTeamName ?? '') &&
    normalizeName(left.awayTeamName ?? '') ===
      normalizeName(right.awayTeamName ?? '') &&
    Boolean(left.playerTeamName && right.playerTeamName) &&
    normalizeName(left.playerTeamName ?? '') ===
      normalizeName(right.playerTeamName ?? '')
  );
}

function samePlayerFixture(
  left: NonNullable<PlayerStats['nextGame']>,
  right: NonNullable<PlayerStats['nextGame']>,
): boolean {
  if (left.date !== right.date) return false;
  const comparableIdentities: Array<
    [string | null | undefined, string | null | undefined]
  > = [
    [left.playerTeamSlug, right.playerTeamSlug],
    [left.homeTeamName, right.homeTeamName],
    [left.awayTeamName, right.awayTeamName],
    [left.playerTeamName, right.playerTeamName],
    [left.opponentTeamName, right.opponentTeamName],
  ];
  return comparableIdentities.every(
    ([leftIdentity, rightIdentity]) =>
      !leftIdentity ||
      !rightIdentity ||
      normalizeName(leftIdentity) === normalizeName(rightIdentity),
  );
}

function marketSnapshotMatchesStats(
  snapshot: PlayerMarketSnapshot,
  stats: PlayerStats,
): boolean {
  if (!snapshot.fixture || !stats.nextGame) return false;
  if (snapshot.fixture.date !== stats.nextGame.date) return false;
  const comparableSlugs: Array<
    [string | undefined, string | undefined]
  > = [
    [snapshot.fixture.homeTeamSlug, stats.nextGame.homeTeamSlug],
    [snapshot.fixture.awayTeamSlug, stats.nextGame.awayTeamSlug],
    [snapshot.fixture.playerTeamSlug, stats.nextGame.playerTeamSlug],
  ];
  return comparableSlugs.every(
    ([snapshotSlug, currentSlug]) =>
      !snapshotSlug ||
      !currentSlug ||
      snapshotSlug.toLocaleLowerCase() === currentSlug.toLocaleLowerCase(),
  );
}

function marketSnapshotIdentity(stats: PlayerStats): string | null {
  if (!stats.nextGame) return null;
  return `${stats.slug}:${stats.position}:${stats.nextGame.date}`;
}

function needsCachedGoalMarketRecheck(
  stats: PlayerStats,
  now = Date.now(),
): boolean {
  if (stats.position === 'Goalkeeper' || stats.nextGame?.marketOdds?.goal) {
    return false;
  }
  const kickoff = Date.parse(stats.nextGame?.date ?? '');
  return Number.isFinite(kickoff) && kickoff > now;
}

function mergePlayerMarketOdds(
  cached: PlayerMarketOdds | null | undefined,
  incoming: PlayerMarketOdds | null | undefined,
): PlayerMarketOdds | null | undefined {
  if (!cached) return incoming;
  if (!incoming) return cached;

  const reusedCachedGoal = !incoming.goal && Boolean(cached.goal);
  const reusedCachedAssist = !incoming.assist && Boolean(cached.assist);
  const reusedCachedDecisive = !incoming.decisive && Boolean(cached.decisive);
  if (!reusedCachedGoal && !reusedCachedAssist && !reusedCachedDecisive) {
    return incoming;
  }
  if (!incoming.goal && !incoming.assist && !incoming.decisive) return cached;

  return {
    source: incoming.source === cached.source ? incoming.source : 'mixed',
    capturedAt:
      incoming.capturedAt >= cached.capturedAt
        ? incoming.capturedAt
        : cached.capturedAt,
    goal: incoming.goal ?? cached.goal,
    assist: incoming.assist ?? cached.assist,
    decisive: incoming.decisive ?? cached.decisive ?? null,
  };
}

function mergeSharedFixtureTeamData(
  stats: PlayerStats,
  candidates: Iterable<PlayerStats>,
): PlayerStats {
  if (!stats.nextGame) return stats;
  let cleanSheetProbability = stats.nextGame.cleanSheetProbability;
  let matchProbabilities = stats.nextGame.matchProbabilities;

  for (const candidate of candidates) {
    const fixture = candidate.nextGame;
    if (!fixture || !samePlayerTeamFixture(stats.nextGame, fixture)) continue;
    cleanSheetProbability ??= fixture.cleanSheetProbability;
    if (fixture.matchProbabilities) {
      matchProbabilities = {
        win: matchProbabilities?.win ?? fixture.matchProbabilities.win,
        draw: matchProbabilities?.draw ?? fixture.matchProbabilities.draw,
        loss: matchProbabilities?.loss ?? fixture.matchProbabilities.loss,
      };
    }
  }

  if (
    cleanSheetProbability === stats.nextGame.cleanSheetProbability &&
    matchProbabilities?.win === stats.nextGame.matchProbabilities?.win &&
    matchProbabilities?.draw === stats.nextGame.matchProbabilities?.draw &&
    matchProbabilities?.loss === stats.nextGame.matchProbabilities?.loss
  ) {
    return stats;
  }
  return {
    ...stats,
    nextGame: {
      ...stats.nextGame,
      cleanSheetProbability,
      matchProbabilities,
    },
  };
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
  private readonly cacheMetadata = new Map<string, CachedAliasMetadata>();
  private readonly trackedViews = new Map<OverlayView, TargetIdentity>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly retryWork = new Map<string, ScheduledTargetWork>();
  private readonly deferredRetryUsed = new Set<string>();
  private readonly refreshAttempts = new Map<string, number>();
  private readonly refreshWork = new Map<string, PendingRefreshWork>();
  private readonly fixtureRefreshTargets = new Set<string>();
  private readonly marketSnapshotRequestKeys = new Set<string>();
  private readonly marketSnapshotCheckedAt = new Map<string, number>();
  private activeBatchCount = 0;
  private batchSequence = 0;
  private cacheSequence = 0;
  private timer: number | undefined;
  private includeHistoricalAssists = false;
  private readonly maxCachedAliases: number;
  private readonly cachedAliasTtlMs: number;
  private readonly marketSnapshotRecheckTtlMs: number;
  private readonly marketSnapshotBatchSize: number;
  private readonly marketSnapshotsFetcher: MarketSnapshotsFetcher;
  private marketCacheUpdateListener: MarketCacheUpdateListener | undefined;
  private readonly notifiedMarketGoalFingerprints = new Map<string, string>();

  constructor(
    private readonly fetcher: StatsFetcher = fetchPlayerStats,
    private readonly debounceMs = 40,
    private readonly retryDelaysMs: readonly number[] = [5_000, 30_000],
    private readonly progressiveBatchSize = 12,
    private readonly maxConcurrentBatches = 1,
    private readonly refreshDelaysMs: readonly number[] = [
      2_500,
      8_000,
      25_000,
      60_000,
    ],
    private readonly deferredRetryDelayMs = 750,
    options: StatsBatchCoordinatorOptions = {},
  ) {
    this.maxCachedAliases = Math.max(
      1,
      Math.floor(options.maxCachedAliases ?? defaultMaxCachedAliases),
    );
    this.cachedAliasTtlMs = Math.max(
      1,
      Math.floor(options.cachedAliasTtlMs ?? defaultCachedAliasTtlMs),
    );
    this.marketSnapshotRecheckTtlMs = Math.max(
      1,
      Math.floor(
        options.marketSnapshotRecheckTtlMs ??
          defaultMarketSnapshotRecheckTtlMs,
      ),
    );
    this.marketSnapshotBatchSize = Math.max(
      1,
      Math.floor(options.marketSnapshotBatchSize ?? 24),
    );
    this.marketSnapshotsFetcher =
      options.marketSnapshotsFetcher ?? fetchPlayerMarketSnapshots;
  }

  setIncludeHistoricalAssists(enabled: boolean): boolean {
    if (this.includeHistoricalAssists === enabled) return false;
    this.includeHistoricalAssists = enabled;
    return true;
  }

  enqueue(
    target: CardTarget,
    view: OverlayView,
    priority = 0,
    forceRefresh = false,
  ): void {
    if (!view.host.isConnected) return;
    const key = targetKey(target);
    this.trackedViews.set(view, target);
    this.clearRetry(key);
    const cached = this.cachedStatsForTarget(target);
    if (cached) {
      const requiresHistoricalHydration =
        this.includeHistoricalAssists && !cached.historicalAssists;
      const shouldForceRefresh = forceRefresh || requiresHistoricalHydration;
      logStatsDiagnostic('cache-hit-render', {
        key,
        target: {
          slug: target.slug ?? null,
          playerName: target.playerName ?? null,
          position: target.position ?? null,
        },
        rendered: summarizeStats(cached),
      });
      view.render(cached, this.cachedStatsValues());
      if (shouldForceRefresh) {
        this.clearPendingRefresh(key);
      } else if (cached.pendingRefreshes?.length) {
        this.schedulePendingRefresh(
          target,
          [view],
          cached.pendingRefreshes.includes('fixture'),
          priority,
          cached.pendingRefreshes.includes('marketOdds'),
        );
      } else if (
        this.queueCachedGoalMarketRecheck(target, [view], priority, cached)
      ) {
        // Keep rendering the complete cached form/fixture immediately while a
        // compact cache-only market read checks whether a bookmaker warm-up
        // has finished since this player snapshot was stored.
      } else {
        this.clearPendingRefresh(key);
      }
      if (!shouldForceRefresh) return;
    }

    this.queueTarget(target, [view], priority);
  }

  setMarketCacheUpdateListener(
    listener: MarketCacheUpdateListener | undefined,
  ): void {
    this.marketCacheUpdateListener = listener;
  }

  releaseView(view: OverlayView): void {
    this.trackedViews.delete(view);

    const detachFromTargets = (
      targets: Iterable<PendingTarget | ScheduledTargetWork>,
    ): void => {
      for (const target of targets) target.views.delete(view);
    };
    detachFromTargets(this.pending.values());
    detachFromTargets(this.inFlightTargets.values());
    detachFromTargets(this.afterFlightTargets.values());
    for (const job of this.batchQueue) detachFromTargets(job.batch);

    for (const [key, work] of this.retryWork) {
      work.views.delete(view);
      if (work.views.size === 0) this.clearRetry(key);
    }
    for (const [key, work] of this.refreshWork) {
      work.views.delete(view);
      if (work.views.size === 0) this.clearPendingRefresh(key);
    }
    for (const [key, target] of this.pending) {
      if (target.views.size === 0) this.pending.delete(key);
    }
    for (const [key, target] of this.afterFlightTargets) {
      if (target.views.size === 0) this.afterFlightTargets.delete(key);
    }
    if (this.pending.size === 0 && this.timer !== undefined) {
      window.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  setViewViewportActive(
    target: TargetIdentity,
    view: OverlayView,
    active: boolean,
    priority = 0,
  ): void {
    const key = targetKey(target);
    const retry = this.retryWork.get(key);
    if (retry) {
      retry.views.add(view);
      retry.priority = Math.max(retry.priority, priority);
      if (active || this.hasRetryEligibleViews(retry.views)) {
        this.startRetryWork(key, retry);
      } else {
        this.pauseScheduledWork(retry);
      }
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

    if (active) {
      this.queueCachedGoalMarketRecheck(target, [view], priority);
    }
  }

  reconcileMissingMarkets(teamSlugs: readonly string[]): void {
    if (teamSlugs.length === 0) return;
    const candidates = new Map<
      string,
      {
        target: TargetIdentity;
        views: Set<OverlayView>;
        stats: PlayerStats;
      }
    >();

    for (const [view, target] of this.trackedViews) {
      if (!view.host.isConnected) {
        this.releaseView(view);
        continue;
      }
      if (!view.isViewportPriorityActive()) continue;
      const stats = this.cachedStatsForTarget(target);
      if (!stats || !needsCachedGoalMarketRecheck(stats)) continue;
      const fixtureTeamSlugs = [
        stats.nextGame?.playerTeamSlug,
        stats.nextGame?.homeTeamSlug,
        stats.nextGame?.awayTeamSlug,
      ].filter((slug): slug is string => Boolean(slug));
      if (
        !teamSlugs.some((teamSlug) =>
          fixtureTeamSlugs.some((fixtureTeamSlug) =>
            teamSlugsLikelyMatch(teamSlug, fixtureTeamSlug),
          ),
        )
      ) {
        continue;
      }
      const key = targetKey(target);
      const candidate = candidates.get(key) ?? {
        target,
        views: new Set<OverlayView>(),
        stats,
      };
      candidate.views.add(view);
      candidates.set(key, candidate);
    }

    for (const { target, views, stats } of candidates.values()) {
      this.queueCachedGoalMarketRecheck(target, views, 1, stats, true);
    }
  }

  private queueTarget(
    target: TargetIdentity,
    views: Iterable<OverlayView>,
    priority = 0,
  ): void {
    const connectedViews = this.connectedViews(views);
    if (connectedViews.length === 0) return;
    const key = targetKey(target);
    const inFlight = this.inFlightTargets.get(key);
    if (inFlight) {
      const requiresFixtureRefresh = this.fixtureRefreshTargets.has(key);
      if (
        !requiresFixtureRefresh ||
        this.inFlightFixtureRefreshKeys.has(key)
      ) {
        for (const view of connectedViews) inFlight.views.add(view);
        inFlight.priority = Math.max(inFlight.priority, priority);
        return;
      }
      const followUp = this.afterFlightTargets.get(key) ?? {
        ...(target.slug ? { slug: target.slug } : {}),
        ...(target.playerName ? { playerName: target.playerName } : {}),
        ...(target.position ? { position: target.position } : {}),
        ...(target.teamSlug ? { teamSlug: target.teamSlug } : {}),
        views: new Set<OverlayView>(),
        priority,
      };
      for (const view of connectedViews) followUp.views.add(view);
      followUp.priority = Math.max(followUp.priority, priority);
      this.afterFlightTargets.set(key, followUp);
      return;
    }
    const pendingTarget = this.pending.get(key) ?? {
      ...(target.slug ? { slug: target.slug } : {}),
      ...(target.playerName ? { playerName: target.playerName } : {}),
      ...(target.position ? { position: target.position } : {}),
      ...(target.teamSlug ? { teamSlug: target.teamSlug } : {}),
      views: new Set<OverlayView>(),
      priority,
    };
    for (const view of connectedViews) pendingTarget.views.add(view);
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
    const marketSnapshotTargets: PendingTarget[] = [];
    const regularTargets: PendingTarget[] = [];
    for (const target of queued) {
      const key = targetKey(target);
      if (this.marketSnapshotRequestKeys.delete(key)) {
        marketSnapshotTargets.push(target);
      } else {
        regularTargets.push(target);
      }
    }
    const batches: Array<{
      batch: PendingTarget[];
      kind: BatchJob['kind'];
    }> = [
      ...conflictFreeBatches(
        marketSnapshotTargets,
        this.marketSnapshotBatchSize,
      ).map((batch) => ({ batch, kind: 'market-snapshots' as const })),
      ...conflictFreeBatches(
        regularTargets,
        Math.max(1, this.progressiveBatchSize),
      ).map((batch) => ({ batch, kind: 'stats' as const })),
    ];
    await Promise.all(
      batches.map(({ batch, kind }) => this.scheduleBatch(batch, kind)),
    );
  }

  private scheduleBatch(
    batch: PendingTarget[],
    kind: BatchJob['kind'],
  ): Promise<void> {
    return new Promise((resolve) => {
      this.batchQueue.push({
        batch,
        kind,
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
      if (job.kind === 'market-snapshots') {
        await this.loadMarketSnapshotBatch(job.batch);
      } else {
        await this.loadBatch(job.batch);
      }
    } finally {
      for (const target of job.batch) {
        const key = targetKey(target);
        this.marketSnapshotRequestKeys.delete(key);
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
    const playerTeams = Object.fromEntries(
      batch.flatMap(({ slug, playerName, teamSlug }) => {
        const identity = slug ?? playerName;
        return identity && teamSlug ? [[identity, teamSlug]] : [];
      }),
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
        ...(Object.keys(playerTeams).length ? { playerTeams } : {}),
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
      const deferredPlayerSlugs = new Set(
        response.meta.deferredPlayerSlugs ?? [],
      );
      const fixtureCandidates = [
        ...response.data,
        ...this.cachedStatsValues(),
      ];
      const responseDataWithSharedFixtures = response.data.map((stats) =>
        mergeSharedFixtureTeamData(stats, fixtureCandidates),
      );
      const responseData = responseDataWithSharedFixtures.map((stats) =>
        this.mergeWithCachedStats(stats),
      );
      for (const stats of responseData) {
        this.recordMarketSnapshotCheck(stats);
      }
      for (const mergedStats of responseData) {
        if (!canTrackStats(mergedStats)) continue;
        const changedKeys = this.cacheStatsAliases(mergedStats, batch);
        this.renderTrackedAliases(changedKeys, mergedStats);
      }
      this.notifyMarketCacheUpdated(responseData);
      for (const target of batch) {
        const key = targetKey(target);
        if (refreshFixtures) this.fixtureRefreshTargets.delete(key);
        const stats =
          this.getCachedStats(targetKey(target)) ??
          responseData.find(
            (candidate) =>
              canTrackStats(candidate) &&
              (target.position === undefined || candidate.position === target.position) &&
              targetMatchesStats(target, candidate),
          );
        const isDeferred = Boolean(
          (target.slug && deferredPlayerSlugs.has(target.slug)) ||
            (target.playerName &&
              deferredPlayerNames.has(normalizeName(target.playerName))),
        );
        logStatsDiagnostic('target-resolution', {
          requestId: diagnosticRequestId ?? null,
          target: {
            slug: target.slug ?? null,
            playerName: target.playerName ?? null,
            position: target.position ?? null,
          },
          resolved: stats ? summarizeStats(stats) : null,
          responsePlayers: responseData.map(summarizeStats),
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
            view.render(stats, fixtureCandidates);
          } else if (isDeferred) {
            view.retrying();
          } else {
            view.noData();
          }
        }
        if (stats && hasAnyDisplayData(stats)) {
          this.setCachedStats(key, stats);
          this.clearRetry(targetKey(target));
        } else if (stats?.pendingRefreshes?.length) {
          // A resolved zero-L10 player may only be waiting for its independent
          // fixture/market snapshot. The pending-refresh path below owns that
          // follow-up; a second generic retry would duplicate API traffic.
          this.clearRetry(targetKey(target));
        } else {
          this.scheduleRetry(
            target,
            isDeferred,
          );
        }
        if (stats?.pendingRefreshes?.length) {
          this.schedulePendingRefresh(
            target,
            target.views,
            stats?.pendingRefreshes?.includes('fixture') ?? false,
            target.priority,
            stats?.pendingRefreshes?.includes('marketOdds') ?? false,
          );
        } else if (stats) {
          this.clearPendingRefresh(
            key,
            this.fixtureRefreshTargets.has(key) && !refreshFixtures,
          );
        }
      }
      this.refreshTrackedFixturePresentations(responseData);
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
          if (cached) view.render(cached, this.cachedStatsValues());
          else if (retryScheduled) view.retrying();
          else view.error();
        }
      }
    }
  }

  private async loadMarketSnapshotBatch(
    batch: PendingTarget[],
  ): Promise<void> {
    const cachedByTarget = new Map<PendingTarget, PlayerStats>();
    const players = new Map<
      string,
      PlayerMarketSnapshotsRequest['players'][number]
    >();
    for (const target of batch) {
      const cached = this.cachedStatsForTarget(target);
      if (!cached?.nextGame) {
        this.clearPendingRefresh(targetKey(target));
        continue;
      }
      cachedByTarget.set(target, cached);
      players.set(`${cached.slug}:${cached.position}:${cached.nextGame.date}`, {
        slug: cached.slug,
        displayName: cached.displayName,
        position: cached.position,
        nextGame: cached.nextGame,
      });
    }
    if (players.size === 0) return;

    try {
      const response = await this.marketSnapshotsFetcher({
        players: [...players.values()],
      });
      for (const cached of cachedByTarget.values()) {
        this.recordMarketSnapshotCheck(cached);
      }
      const updatedStats: PlayerStats[] = [];
      const snapshotsByPlayer = new Map(
        response.data.map((snapshot) => [
          `${snapshot.slug}:${snapshot.position}`,
          snapshot,
        ]),
      );
      for (const target of batch) {
        const key = targetKey(target);
        const cached = cachedByTarget.get(target);
        if (!cached) continue;
        const snapshot = snapshotsByPlayer.get(
          `${cached.slug}:${cached.position}`,
        );
        if (!snapshot || !marketSnapshotMatchesStats(snapshot, cached)) {
          this.schedulePendingRefresh(
            target,
            target.views,
            false,
            target.priority,
            true,
          );
          continue;
        }

        const pending = new Set(cached.pendingRefreshes ?? []);
        if (snapshot.refreshState === 'pending') pending.add('marketOdds');
        else pending.delete('marketOdds');
        const merged: PlayerStats = {
          ...cached,
          nextGame: cached.nextGame
            ? {
                ...cached.nextGame,
                marketOdds: mergePlayerMarketOdds(
                  cached.nextGame.marketOdds,
                  snapshot.marketOdds,
                ),
              }
            : null,
          ...(pending.size > 0
            ? { pendingRefreshes: [...pending] }
            : { pendingRefreshes: undefined }),
        };
        const changedKeys = this.cacheStatsAliases(merged, [target]);
        this.renderTrackedAliases(changedKeys, merged);
        updatedStats.push(merged);
        this.clearRetry(key);
        if (snapshot.refreshState === 'pending') {
          this.schedulePendingRefresh(
            target,
            target.views,
            false,
            target.priority,
            true,
          );
        } else if (pending.size > 0) {
          this.schedulePendingRefresh(
            target,
            target.views,
            pending.has('fixture'),
            target.priority,
            false,
          );
        } else {
          this.clearPendingRefresh(key);
        }
        logStatsDiagnostic('market-snapshot-resolution', {
          target: {
            slug: target.slug ?? null,
            playerName: target.playerName ?? null,
            position: target.position ?? null,
          },
          resolvedSlug: snapshot.slug,
          refreshState: snapshot.refreshState,
          rendered: summarizeStats(merged),
        });
      }
      this.notifyMarketCacheUpdated(updatedStats);
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : 'UNKNOWN_ERROR: Marktquoten nicht verfügbar';
      console.warn('[Sorare Overlay] Marktcache-Abruf fehlgeschlagen:', error);
      for (const target of batch) {
        const cached = cachedByTarget.get(target);
        this.schedulePendingRefresh(
          target,
          target.views,
          false,
          target.priority,
          true,
        );
        logStatsDiagnostic('market-snapshots-request-failed', {
          target: {
            slug: target.slug ?? null,
            playerName: target.playerName ?? null,
            position: target.position ?? null,
          },
          message,
          retained: cached ? summarizeStats(cached) : null,
        });
        if (cached) {
          for (const view of target.views) {
            view.render(cached, this.cachedStatsValues());
          }
        }
      }
    }
  }

  private schedulePendingRefresh(
    target: TargetIdentity,
    views: Iterable<OverlayView>,
    refreshFixture = false,
    priority = 0,
    refreshMarketOdds = false,
  ): void {
    const key = targetKey(target);
    const connectedViews = this.connectedViews(views);
    if (refreshFixture) this.fixtureRefreshTargets.add(key);
    const existing = this.refreshWork.get(key);
    if (existing) {
      for (const view of connectedViews) existing.views.add(view);
      if (this.connectedViews(existing.views).length === 0) {
        this.clearPendingRefresh(key);
        return;
      }
      existing.priority = Math.max(existing.priority, priority);
      existing.refreshFixture ||= refreshFixture;
      existing.refreshMarketOdds ||= refreshMarketOdds;
      this.startRefreshWork(key, existing);
      return;
    }
    if (connectedViews.length === 0) {
      this.clearPendingRefresh(key);
      return;
    }
    const attempt = this.refreshAttempts.get(key) ?? 0;
    const delay = this.refreshDelaysMs[attempt];
    if (delay === undefined) {
      this.refreshAttempts.delete(key);
      this.refreshWork.delete(key);
      this.fixtureRefreshTargets.delete(key);
      this.marketSnapshotRequestKeys.delete(key);
      return;
    }

    this.refreshAttempts.set(key, attempt + 1);
    const work: PendingRefreshWork = {
      target,
      views: new Set(connectedViews),
      priority,
      remainingMs: delay,
      refreshFixture,
      refreshMarketOdds,
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
        this.marketSnapshotRequestKeys.delete(key);
        return;
      }
      const activeViews = connectedViews.filter((view) =>
        view.isViewportPriorityActive(),
      );
      if (activeViews.length === 0) return;
      this.refreshWork.delete(key);
      if (work.refreshMarketOdds && !work.refreshFixture) {
        this.marketSnapshotRequestKeys.add(key);
      }
      this.queueTarget(work.target, connectedViews, work.priority);
    }, work.remainingMs);
  }

  private cachedStatsForTarget(
    target: TargetIdentity,
  ): PlayerStats | undefined {
    this.pruneStatsCache();
    const exact = this.getCachedStats(targetKey(target));
    if (exact || target.position === undefined || target.teamSlug !== undefined) {
      return exact;
    }
    for (const [key, stats] of this.cache) {
      if (
        stats.position === target.position &&
        targetMatchesStats(target, stats)
      ) {
        this.touchCachedAlias(key);
        return stats;
      }
    }
    return undefined;
  }

  private notifyMarketCacheUpdated(statsPlayers: readonly PlayerStats[]): void {
    if (!this.marketCacheUpdateListener) return;
    const teamSlugs = new Set<string>();
    for (const stats of statsPlayers) {
      const nextGame = stats.nextGame;
      const marketOdds = nextGame?.marketOdds;
      const goal = marketOdds?.goal;
      if (!nextGame || !marketOdds || !goal) continue;
      const playerKey = `${stats.slug}:${stats.position}`;
      const fingerprint = [
        nextGame.date,
        nextGame.homeTeamSlug,
        nextGame.awayTeamSlug,
        marketOdds.source,
        marketOdds.capturedAt,
        goal.probability,
        goal.bookmakerCount,
      ].join('|');
      if (this.notifiedMarketGoalFingerprints.get(playerKey) === fingerprint) {
        continue;
      }
      this.notifiedMarketGoalFingerprints.delete(playerKey);
      this.notifiedMarketGoalFingerprints.set(playerKey, fingerprint);
      while (
        this.notifiedMarketGoalFingerprints.size > this.maxCachedAliases
      ) {
        const oldestKey = this.notifiedMarketGoalFingerprints.keys().next()
          .value;
        if (!oldestKey) break;
        this.notifiedMarketGoalFingerprints.delete(oldestKey);
      }
      for (const teamSlug of [
        nextGame.playerTeamSlug,
        nextGame.homeTeamSlug,
        nextGame.awayTeamSlug,
      ]) {
        if (teamSlug) teamSlugs.add(teamSlug);
      }
    }
    if (teamSlugs.size > 0) {
      this.marketCacheUpdateListener([...teamSlugs]);
    }
  }

  private queueCachedGoalMarketRecheck(
    target: TargetIdentity,
    views: Iterable<OverlayView>,
    priority: number,
    cachedStats?: PlayerStats,
    bypassCooldown = false,
  ): boolean {
    const connectedViews = this.connectedViews(views);
    if (connectedViews.length === 0) return false;
    const stats = cachedStats ?? this.cachedStatsForTarget(target);
    if (!stats || !needsCachedGoalMarketRecheck(stats)) return false;
    const snapshotIdentity = marketSnapshotIdentity(stats);
    if (!snapshotIdentity) return false;
    const checkedAt = this.marketSnapshotCheckedAt.get(snapshotIdentity) ?? 0;
    if (
      !bypassCooldown &&
      Date.now() - checkedAt < this.marketSnapshotRecheckTtlMs
    ) {
      return false;
    }

    const key = targetKey(target);
    if (
      this.pending.has(key) ||
      this.inFlightTargets.has(key) ||
      this.refreshWork.has(key) ||
      this.marketSnapshotRequestKeys.has(key)
    ) {
      return false;
    }

    this.recordMarketSnapshotCheck(stats);
    this.marketSnapshotRequestKeys.add(key);
    this.queueTarget(target, connectedViews, priority);
    return true;
  }

  private recordMarketSnapshotCheck(stats: PlayerStats): void {
    const identity = marketSnapshotIdentity(stats);
    if (!identity) return;
    this.marketSnapshotCheckedAt.delete(identity);
    this.marketSnapshotCheckedAt.set(identity, Date.now());
    while (this.marketSnapshotCheckedAt.size > this.maxCachedAliases) {
      const oldest = this.marketSnapshotCheckedAt.keys().next().value;
      if (!oldest) break;
      this.marketSnapshotCheckedAt.delete(oldest);
    }
  }

  private cacheStatsAliases(
    stats: PlayerStats,
    batch: readonly PendingTarget[],
  ): Set<string> {
    this.pruneStatsCache();
    const changedKeys = new Set<string>();
    const setAlias = (target: TargetIdentity): void => {
      const key = targetKey(target);
      this.setCachedStats(key, stats, false);
      changedKeys.add(key);
    };

    // Every alias already confirmed for this concrete scoring position follows
    // the newest response. Position variants remain isolated because their
    // cached PlayerStats.position differs.
    for (const [key, cached] of this.cache) {
      if (cached.slug !== stats.slug || cached.position !== stats.position) {
        continue;
      }
      this.setCachedStats(key, stats, false);
      changedKeys.add(key);
    }

    const matchingTargets = batch.filter((target) =>
      targetMatchesStats(target, stats),
    );
    const names = new Set([
      stats.displayName,
      ...matchingTargets.flatMap(({ playerName }) =>
        playerName ? [playerName] : [],
      ),
    ]);
    const canonicalTeamSlug = stats.nextGame?.playerTeamSlug
      ?.trim()
      .toLocaleLowerCase();
    const positions: Array<FootballPosition | undefined> = [stats.position];
    if (matchingTargets.some(({ position }) => position === undefined)) {
      positions.push(undefined);
    }
    const teamSlugs = canonicalTeamSlug
      ? [undefined, canonicalTeamSlug]
      : [undefined];

    for (const position of positions) {
      for (const teamSlug of teamSlugs) {
        setAlias({
          slug: stats.slug,
          ...(position ? { position } : {}),
          ...(teamSlug ? { teamSlug } : {}),
        });
        for (const playerName of names) {
          setAlias({
            playerName,
            ...(position ? { position } : {}),
            ...(teamSlug ? { teamSlug } : {}),
          });
        }
      }
    }

    this.pruneStatsCache();
    for (const key of changedKeys) {
      if (!this.cache.has(key)) changedKeys.delete(key);
    }
    return changedKeys;
  }

  private getCachedStats(key: string): PlayerStats | undefined {
    const stats = this.cache.get(key);
    if (stats) this.touchCachedAlias(key);
    return stats;
  }

  private setCachedStats(
    key: string,
    stats: PlayerStats,
    prune = true,
  ): void {
    this.cache.set(key, stats);
    this.touchCachedAlias(key);
    if (prune) this.pruneStatsCache();
  }

  private touchCachedAlias(key: string): void {
    this.cacheSequence += 1;
    this.cacheMetadata.set(key, {
      lastAccessedAt: Date.now(),
      sequence: this.cacheSequence,
    });
  }

  private cachedStatsValues(): PlayerStats[] {
    this.pruneStatsCache();
    return [...new Set(this.cache.values())];
  }

  private pruneStatsCache(): void {
    const now = Date.now();
    for (const [key, metadata] of this.cacheMetadata) {
      if (now - metadata.lastAccessedAt <= this.cachedAliasTtlMs) continue;
      this.cacheMetadata.delete(key);
      this.cache.delete(key);
    }

    const overflow = this.cache.size - this.maxCachedAliases;
    if (overflow <= 0) return;
    const leastRecentlyUsed = [...this.cacheMetadata]
      .sort((left, right) => left[1].sequence - right[1].sequence)
      .slice(0, overflow);
    for (const [key] of leastRecentlyUsed) {
      this.cacheMetadata.delete(key);
      this.cache.delete(key);
    }
  }

  private renderTrackedAliases(
    changedKeys: ReadonlySet<string>,
    stats: PlayerStats,
  ): void {
    if (!hasAnyDisplayData(stats)) return;
    const fixtureCandidates = this.cachedStatsValues();
    for (const [view, target] of this.trackedViews) {
      if (!view.host.isConnected) {
        this.releaseView(view);
        continue;
      }
      if (changedKeys.has(targetKey(target))) {
        view.render(stats, fixtureCandidates);
      }
    }
  }

  private refreshTrackedFixturePresentations(
    changedCandidates: readonly PlayerStats[],
  ): void {
    const affectedTeamSlugs = new Set(
      changedCandidates.flatMap(({ nextGame }) =>
        nextGame
          ? [nextGame.homeTeamSlug, nextGame.awayTeamSlug].filter(
              (slug): slug is string => Boolean(slug),
            )
          : [],
      ),
    );
    if (affectedTeamSlugs.size === 0) return;

    const fixtureCandidates = this.cachedStatsValues();
    const affectedTeams = [...affectedTeamSlugs];
    for (const [view, target] of this.trackedViews) {
      if (!view.host.isConnected) continue;
      const stats = this.cachedStatsForTarget(target);
      const teamSlug = stats?.nextGame?.playerTeamSlug ?? target.teamSlug;
      if (
        !stats ||
        !affectedTeams.some((candidateTeamSlug) =>
          teamSlugsLikelyMatch(candidateTeamSlug, teamSlug),
        )
      ) {
        continue;
      }
      view.refreshFixturePresentation(fixtureCandidates);
    }
  }

  private mergeWithCachedStats(incoming: PlayerStats): PlayerStats {
    const cached = this.cachedStatsForTarget({
      slug: incoming.slug,
      position: incoming.position,
    });
    const isPartialFormRefresh =
      incoming.pendingRefreshes?.includes('formHistory') === true;
    const cachedIsPartialForm =
      cached?.pendingRefreshes?.includes('formHistory') === true;
    let merged = incoming;
    if (cached && isPartialFormRefresh && !cachedIsPartialForm) {
      merged = {
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

    if (
      !cached?.nextGame ||
      !merged.nextGame ||
      !samePlayerFixture(cached.nextGame, merged.nextGame)
    ) {
      return merged;
    }
    const marketOdds = mergePlayerMarketOdds(
      cached.nextGame.marketOdds,
      merged.nextGame.marketOdds,
    );
    if (marketOdds === merged.nextGame.marketOdds) return merged;
    return {
      ...merged,
      nextGame: {
        ...merged.nextGame,
        marketOdds,
      },
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
    this.marketSnapshotRequestKeys.delete(key);
    if (!preserveFixtureRefresh) this.fixtureRefreshTargets.delete(key);
  }

  private scheduleRetry(target: PendingTarget, deferred = false): boolean {
    const key = targetKey(target);
    const connectedViews = this.connectedViews(target.views);
    const existing = this.retryWork.get(key);
    if (existing) {
      for (const view of connectedViews) existing.views.add(view);
      if (this.connectedViews(existing.views).length === 0) {
        this.clearRetry(key);
        return false;
      }
      existing.priority = Math.max(existing.priority, target.priority);
      this.startRetryWork(key, existing);
      return true;
    }
    if (connectedViews.length === 0) {
      this.clearRetry(key);
      return false;
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
      views: new Set(connectedViews),
      priority: target.priority,
      remainingMs: delay,
    };
    this.retryWork.set(key, work);
    this.startRetryWork(key, work);
    return true;
  }

  private startRetryWork(key: string, work: ScheduledTargetWork): void {
    if (work.timer !== undefined || !this.hasRetryEligibleViews(work.views)) {
      return;
    }
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
      if (!this.hasRetryEligibleViews(connectedViews)) return;
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

  private hasRetryEligibleViews(views: Iterable<OverlayView>): boolean {
    return this.connectedViews(views).some(
      (view) =>
        view.isViewportPriorityActive() ||
        view.requiresBackgroundLineupSortHydration(),
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
  private layoutObserver: MutationObserver | undefined;
  private visibilityObserver: IntersectionObserver | undefined;
  private root: HTMLElement | null = null;
  private readonly overlays = new Map<HTMLElement, MountedOverlay>();
  private readonly deferredOverlays = new Map<HTMLElement, DeferredOverlay>();
  private readonly layoutViewsByTarget = new Map<Element, Set<OverlayView>>();
  private layoutTargetsDirty = false;
  private readonly pendingScanRoots = new Set<Element>();
  private mutationScanBacklog: Element[] = [];
  private mutationBacklogLineupPosition:
    | FootballPosition
    | null
    | undefined;
  private readonly mutationHydrationTargets: CardTarget[] = [];
  private readonly pendingPositionScopes = new Set<Element>();
  private readonly pendingPictureNameRescanIds = new Set<string>();
  private pictureNameRescanTimer: number | undefined;
  private mutationFrame: number | undefined;
  private poolReadyScanFrame: number | undefined;
  private poolReadyScanGeneration = 0;
  private readonly lineupPoolGrids = new WeakSet<HTMLElement>();
  private readonly pendingPoolOverlayDemotions: Array<{
    grid: HTMLElement;
    container: HTMLElement;
  }> = [];
  private readonly pendingPoolOverlayDemotionContainers = new Set<HTMLElement>();
  private poolOverlayDemotionFrame: number | undefined;
  private shouldRefreshAllPositions = false;
  private readonly lineupSorter = new LineupCardSorter();
  private readonly pendingMarketReconcileTeams = new Set<string>();
  private marketReconcileTimer: number | undefined;
  private readonly handleLineupPoolProgress = (event: Event): void => {
    const grid = event.target;
    if (!(grid instanceof HTMLElement)) return;
    if (!this.lineupPoolGrids.has(grid)) {
      this.lineupPoolGrids.add(grid);
      this.queueInactivePoolOverlaysForDemotion(grid);
    }
    // Child-list mutations discover and pass only newly added card targets.
    // A progress pulse merely keeps the current queue pumping; rescanning the
    // complete, ever-growing grid here turns a large pool into quadratic work.
    void this.lineupSortHydrator.hydrate(grid, []);
  };
  private readonly handleLineupPoolReady = (event: Event): void => {
    const grid = event.target;
    if (!(grid instanceof HTMLElement)) return;
    this.lineupPoolGrids.add(grid);
    this.queueInactivePoolOverlaysForDemotion(grid);
    this.scheduleLineupPoolReadyScan(grid);
  };
  private readonly handleMarketCacheUpdate = (
    teamSlugs: readonly string[],
  ): void => {
    for (const teamSlug of teamSlugs) {
      this.pendingMarketReconcileTeams.add(teamSlug);
    }
    if (this.marketReconcileTimer !== undefined) return;
    this.marketReconcileTimer = window.setTimeout(() => {
      this.marketReconcileTimer = undefined;
      const pendingTeams = [...this.pendingMarketReconcileTeams];
      this.pendingMarketReconcileTeams.clear();
      if (pendingTeams.length > 0) {
        this.coordinator.reconcileMissingMarkets(pendingTeams);
        void this.lineupSortHydrator.reconcileMissingGoals(pendingTeams);
      }
    }, 120);
  };

  constructor(
    private readonly coordinator = new StatsBatchCoordinator(),
    private readonly onCardPictureNamesDiscovered?: (
      entries: Readonly<Record<string, string>>,
    ) => void,
    private readonly lineupSortHydrator = new LineupSortHydrator(),
  ) {}

  configureHistoricalAssistFallback(
    enabled: boolean,
    window: HistoricalMarketWindow = 15,
  ): void {
    const changed = this.coordinator.setIncludeHistoricalAssists(enabled);
    this.lineupSortHydrator.configureHistoricalGoalFallback(enabled, window);
    this.refreshAllOverlays(changed && enabled);
  }

  refreshAllOverlays(forceRefresh = false): void {
    for (const mounted of this.overlays.values()) {
      mounted.statsRequested = false;
      if (mounted.viewportActive) {
        this.requestStats(mounted, undefined, forceRefresh);
      }
    }
  }

  start(): void {
    if (this.observer) return;
    const root = document.body ?? document.documentElement;
    this.root = root;
    this.coordinator.setMarketCacheUpdateListener(
      this.handleMarketCacheUpdate,
    );
    root.addEventListener(
      lineupPoolProgressEvent,
      this.handleLineupPoolProgress,
    );
    root.addEventListener(lineupPoolReadyEvent, this.handleLineupPoolReady);
    this.lineupSorter.start(root);
    this.startVisibilityObserver();
    this.startLayoutObserver();
    this.scan(root);
    this.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const mutationElement = isElementNode(mutation.target)
          ? mutation.target
          : null;
        if (mutationElement?.closest(extensionMutationSelector)) continue;
        const externalAddedNodes =
          mutation.type === 'childList'
            ? [...mutation.addedNodes].filter(
                (node) =>
                  !(
                    isElementNode(node) &&
                    node.closest(extensionMutationSelector)
                  ),
              )
            : [];
        const externalRemovedNodes =
          mutation.type === 'childList'
            ? [...mutation.removedNodes].filter(
                (node) =>
                  !(
                    isElementNode(node) &&
                    node.matches(extensionMutationSelector)
                  ),
              )
            : [];
        const externalAddedElements = externalAddedNodes.filter(isElementNode);
        const externalRemovedElements =
          externalRemovedNodes.filter(isElementNode);
        if (
          mutation.type === 'childList' &&
          externalAddedNodes.length === 0 &&
          externalRemovedNodes.length === 0
        ) {
          continue;
        }
        for (const removed of externalRemovedElements) {
          this.releaseRemovedOverlays(removed);
        }
        if (mutation.type === 'attributes') {
          if (
            mutation.attributeName &&
            globalLayoutStateAttributes.some(
              (attribute) => attribute === mutation.attributeName,
            )
          ) {
            this.shouldRefreshAllPositions = true;
          } else {
            this.queuePositionContext(mutation.target);
          }
          if (mutation.attributeName && discoveryAttributes.has(mutation.attributeName)) {
            this.queueScanRoot(mutation.target as Element);
            this.queueScanContext(mutation.target);
          }
        } else {
          if (
            [...externalAddedElements, ...externalRemovedElements].some(
              (node) =>
                node.matches(globalOverlayLayoutSelector) ||
                Boolean(node.querySelector(globalOverlayLayoutSelector)),
            )
          ) {
            this.shouldRefreshAllPositions = true;
          } else {
            this.queuePositionContext(mutation.target);
          }
          for (const added of externalAddedElements) {
            this.queueScanRoot(added);
          }
          if (
            externalAddedElements.length > 0 ||
            externalRemovedElements.length > 0
          ) {
            this.queueScanContext(mutation.target);
          }
        }
      }
      this.scheduleMutationFlush();
    });
    this.observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        ...discoveryAttributes,
        ...globalLayoutStateAttributes,
      ],
    });
  }

  stop(): void {
    this.root?.removeEventListener(
      lineupPoolProgressEvent,
      this.handleLineupPoolProgress,
    );
    this.root?.removeEventListener(
      lineupPoolReadyEvent,
      this.handleLineupPoolReady,
    );
    this.root = null;
    this.coordinator.setMarketCacheUpdateListener(undefined);
    if (this.marketReconcileTimer !== undefined) {
      window.clearTimeout(this.marketReconcileTimer);
      this.marketReconcileTimer = undefined;
    }
    this.pendingMarketReconcileTeams.clear();
    this.observer?.disconnect();
    this.observer = undefined;
    this.layoutObserver?.disconnect();
    this.layoutObserver = undefined;
    this.layoutViewsByTarget.clear();
    this.layoutTargetsDirty = false;
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
    this.cancelLineupPoolReadyScan();
    this.cancelPoolOverlayDemotions();
    this.pendingScanRoots.clear();
    this.mutationScanBacklog = [];
    this.mutationBacklogLineupPosition = undefined;
    this.mutationHydrationTargets.length = 0;
    this.pendingPositionScopes.clear();
    if (this.pictureNameRescanTimer !== undefined) {
      window.clearTimeout(this.pictureNameRescanTimer);
      this.pictureNameRescanTimer = undefined;
    }
    this.pendingPictureNameRescanIds.clear();
    this.shouldRefreshAllPositions = false;
    this.lineupSorter.stop();
    this.lineupSortHydrator.stop();
    for (const [container, mounted] of [...this.overlays]) {
      this.releaseMountedOverlay(container, mounted);
    }
    for (const container of [...this.deferredOverlays.keys()]) {
      this.releaseDeferredOverlay(container);
    }
    this.layoutTargetsDirty = false;
    clearNativeSorareLineupProbabilityDecorations();
  }

  scan(
    root: ParentNode,
    refreshLayoutTargets = true,
    knownLineupPosition = activeLineupPosition(),
    hydrateLineupSortTargets = true,
    knownHydrationPriority?: number,
  ): CardTarget[] {
    decorateNativeSorareLineupProbabilities(root);
    this.lineupSorter.scan(root);
    const targets = this.discoverAndMountTargets(
      root,
      knownLineupPosition,
      knownHydrationPriority,
    );
    if (hydrateLineupSortTargets) this.hydrateLineupTargets(targets);
    if (refreshLayoutTargets) this.refreshLayoutObserverTargets();
    return targets;
  }

  private discoverAndMountTargets(
    root: ParentNode,
    knownLineupPosition: FootballPosition | null | undefined,
    knownHydrationPriority?: number,
    knownHydrationGrid?: HTMLElement,
  ): CardTarget[] {
    const rootHydrationGrid =
      knownHydrationGrid ??
      (root instanceof Element
        ? root.closest<HTMLElement>(
            `[${lineupSortHydrationGridAttribute}]`,
          )
        : null);
    const targets = rootHydrationGrid
      ? findCardTargets(root, {
          ...(knownLineupPosition !== undefined
            ? { activeLineupPosition: knownLineupPosition }
            : {}),
          // The active Sorare picker grid contains full-size selectable cards
          // by construction. Measuring every image here would synchronously
          // force layout once per lazy-loaded card.
          skipMiniatureCardCheck: true,
        })
      : findCardTargets(root);
    const discoveredPictureNames = drainDiscoveredCardPictureNames();
    if (Object.keys(discoveredPictureNames).length > 0) {
      this.onCardPictureNamesDiscovered?.(discoveredPictureNames);
      for (const pictureId of Object.keys(discoveredPictureNames)) {
        this.pendingPictureNameRescanIds.add(pictureId.toLowerCase());
      }
      this.schedulePictureNameRescans();
    }
    for (const target of targets) {
      this.mountTarget(
        target,
        rootHydrationGrid ? knownHydrationPriority : undefined,
        rootHydrationGrid ?? undefined,
      );
    }
    return targets;
  }

  private scheduleLineupPoolReadyScan(grid: HTMLElement): void {
    this.cancelLineupPoolReadyScan();
    const generation = this.poolReadyScanGeneration;
    const knownLineupPosition = activeLineupPosition();
    const roots = Array.from(grid.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement,
    );
    if (roots.length === 0) roots.push(grid);
    const targets = new Map<HTMLElement, CardTarget>();
    let nextRootIndex = 0;

    const scheduleNextFrame = (): void => {
      this.poolReadyScanFrame =
        typeof window.requestAnimationFrame === 'function'
          ? window.requestAnimationFrame(processFrame)
          : window.setTimeout(processFrame, 0);
    };
    const processFrame = (): void => {
      this.poolReadyScanFrame = undefined;
      if (
        generation !== this.poolReadyScanGeneration ||
        !grid.isConnected
      ) {
        return;
      }
      const startedAt = performance.now();
      let processedRoots = 0;
      while (nextRootIndex < roots.length) {
        const root = roots[nextRootIndex];
        nextRootIndex += 1;
        if (root?.isConnected && grid.contains(root)) {
          for (const target of this.discoverAndMountTargets(
            root,
            knownLineupPosition,
            // Pool membership is authoritative here. Keep identity
            // reconciliation layout-free; IntersectionObserver promotes
            // currently visible cards.
            0,
            grid,
          )) {
            targets.set(target.container, target);
          }
        }
        processedRoots += 1;
        if (
          processedRoots >= poolReadyScanMaxRoots ||
          performance.now() - startedAt >= poolReadyScanBudgetMs
        ) {
          break;
        }
      }
      if (nextRootIndex < roots.length) {
        scheduleNextFrame();
        return;
      }

      this.refreshLayoutObserverTargets();
      // A large pool can teach us hundreds of card-picture aliases. Revisit
      // only previously anonymized copies once the frame-budgeted pass has
      // learned every final pool identity.
      this.flushPictureNameRescans(grid);
      // The ready event is authoritative. Keep this explicit because the
      // hydration attribute can disappear immediately after the final card.
      void this.lineupSortHydrator
        .hydrate(grid, [...targets.values()])
        .then(() => this.lineupSortHydrator.reconcileMissingGoals());
    };

    scheduleNextFrame();
  }

  private cancelLineupPoolReadyScan(): void {
    this.poolReadyScanGeneration += 1;
    if (this.poolReadyScanFrame === undefined) return;
    if (typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(this.poolReadyScanFrame);
    } else {
      window.clearTimeout(this.poolReadyScanFrame);
    }
    this.poolReadyScanFrame = undefined;
  }

  private hydrateLineupTargets(targets: readonly CardTarget[]): void {
    const targetsByGrid = new Map<HTMLElement, CardTarget[]>();
    for (const target of targets) {
      const grid = target.container.closest<HTMLElement>(
        `[${lineupSortHydrationGridAttribute}]`,
      );
      if (!grid) continue;
      const gridTargets = targetsByGrid.get(grid) ?? [];
      gridTargets.push(target);
      targetsByGrid.set(grid, gridTargets);
    }
    for (const [grid, gridTargets] of targetsByGrid) {
      void this.lineupSortHydrator.hydrate(grid, gridTargets);
    }
  }

  private mountTarget(
    target: CardTarget,
    knownPriority?: number,
    knownHydrationGrid?: HTMLElement,
  ): void {
    const key = targetKey(target);
    const mounted = this.overlays.get(target.container);
    if (mounted?.key === key) return;
    const deferred = this.deferredOverlays.get(target.container);
    // IntersectionObserver owns promotion of an unchanged deferred card. A
    // later pool-wide reconciliation must not synchronously measure hundreds
    // of offscreen cards merely to rediscover that they are still offscreen.
    if (deferred?.key === key && knownPriority === undefined) return;
    const priority = this.visibilityObserver
      ? knownPriority ??
        viewportPriorityForRect(target.container.getBoundingClientRect())
      : viewportPriorityNearby;
    if (deferred?.key === key && priority === 0) return;
    if (deferred) {
      this.releaseDeferredOverlay(target.container);
    }
    if (mounted) {
      this.releaseMountedOverlay(target.container, mounted);
    }
    const shouldDeferFullOverlay = Boolean(
      this.visibilityObserver &&
        priority === 0 &&
        (knownHydrationGrid?.contains(target.container) ||
          target.container.closest(
            `[${lineupSortHydrationGridAttribute}]`,
          )),
    );
    if (shouldDeferFullOverlay) {
      this.deferredOverlays.set(target.container, { key, target });
      target.container.setAttribute(deferredOverlayKeyAttribute, key);
      this.visibilityObserver?.observe(target.container);
      setLineupSortPosition(target.container, target.position ?? null);
      if (
        target.container.getAttribute(lineupSortDataReadyAttribute) !== 'true'
      ) {
        setLineupSortDataReady(target.container, false);
      }
      return;
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
    const mountedOverlay: MountedOverlay = {
      key,
      target,
      view,
      viewportActive: priority > 0,
      statsRequested: false,
    };
    this.overlays.set(target.container, mountedOverlay);
    this.layoutTargetsDirty = true;
    if (this.visibilityObserver) {
      this.visibilityObserver.observe(target.container);
      view.setViewportPriorityActive(mountedOverlay.viewportActive);
    }
    if (mountedOverlay.viewportActive) this.requestStats(mountedOverlay, priority);
  }

  private reconcileMountedOverlays(
    scopes: readonly Element[],
    knownLineupPosition = activeLineupPosition(),
    alreadyScannedContainers: ReadonlySet<HTMLElement> = new Set(),
  ): void {
    const candidates =
      scopes.length > 0
        ? this.trackedOverlayContainersForScopes(scopes)
        : new Set([...this.overlays.keys(), ...this.deferredOverlays.keys()]);
    for (const container of candidates) {
      if (alreadyScannedContainers.has(container)) continue;
      const mounted = this.overlays.get(container);
      const deferred = this.deferredOverlays.get(container);
      if (!mounted && !deferred) continue;
      const hydrationGrid = container.closest<HTMLElement>(
        `[${lineupSortHydrationGridAttribute}]`,
      );
      const currentTarget = container.isConnected
        ? findCardTargets(
            container,
            hydrationGrid
              ? {
                  ...(knownLineupPosition !== undefined
                    ? { activeLineupPosition: knownLineupPosition }
                    : {}),
                  skipMiniatureCardCheck: true,
                }
              : {},
          ).find(
            (candidate) => candidate.container === container,
          )
        : undefined;
      if (!currentTarget) {
        if (mounted) this.releaseMountedOverlay(container, mounted);
        else this.releaseDeferredOverlay(container);
        continue;
      }
      const currentKey = targetKey(currentTarget);
      if (currentKey === (mounted?.key ?? deferred?.key)) continue;
      if (mounted) this.releaseMountedOverlay(container, mounted);
      else this.releaseDeferredOverlay(container);
      this.mountTarget(
        currentTarget,
        hydrationGrid
          ? mounted?.viewportActive
            ? viewportPriorityNearby
            : 0
          : undefined,
      );
    }
  }

  private trackedOverlayContainersForScopes(
    scopes: readonly Element[],
  ): Set<HTMLElement> {
    const candidates = new Set<HTMLElement>();
    for (const scope of scopes) {
      if (
        scope instanceof HTMLElement &&
        scope.matches(trackedOverlayContainerSelector)
      ) {
        candidates.add(scope);
      }
      for (const container of scope.querySelectorAll<HTMLElement>(
        trackedOverlayContainerSelector,
      )) {
        candidates.add(container);
      }
      let ancestor = scope.parentElement?.closest<HTMLElement>(
        trackedOverlayContainerSelector,
      );
      while (ancestor) {
        candidates.add(ancestor);
        ancestor = ancestor.parentElement?.closest<HTMLElement>(
          trackedOverlayContainerSelector,
        );
      }
    }
    return candidates;
  }

  private cleanupDisconnectedOverlays(): void {
    for (const [container, mounted] of this.overlays) {
      if (container.isConnected) continue;
      this.releaseMountedOverlay(container, mounted);
    }
    for (const container of [...this.deferredOverlays.keys()]) {
      if (!container.isConnected) this.releaseDeferredOverlay(container);
    }
  }

  private releaseRemovedOverlays(removedRoot: Element): void {
    const candidates = new Set<HTMLElement>();
    if (
      removedRoot instanceof HTMLElement &&
      removedRoot.matches(trackedOverlayContainerSelector)
    ) {
      candidates.add(removedRoot);
    }
    for (const container of removedRoot.querySelectorAll<HTMLElement>(
      trackedOverlayContainerSelector,
    )) {
      candidates.add(container);
    }
    for (const container of candidates) {
      const mounted = this.overlays.get(container);
      if (mounted) this.releaseMountedOverlay(container, mounted);
      else if (this.deferredOverlays.has(container)) {
        this.releaseDeferredOverlay(container);
      }
    }
  }

  private releaseDeferredOverlay(container: HTMLElement): void {
    this.visibilityObserver?.unobserve(container);
    this.deferredOverlays.delete(container);
    container.removeAttribute(deferredOverlayKeyAttribute);
  }

  private releaseMountedOverlay(
    container: HTMLElement,
    mounted: MountedOverlay,
  ): void {
    this.visibilityObserver?.unobserve(container);
    this.coordinator.releaseView(mounted.view);
    mounted.view.destroy();
    delete container.dataset.sorareOverlayKey;
    this.overlays.delete(container);
    this.layoutTargetsDirty = true;
  }

  private queueInactivePoolOverlaysForDemotion(grid: HTMLElement): void {
    if (!this.visibilityObserver || !grid.isConnected) return;
    for (const [container, mounted] of this.overlays) {
      if (
        mounted.viewportActive ||
        !grid.contains(container) ||
        this.pendingPoolOverlayDemotionContainers.has(container)
      ) {
        continue;
      }
      this.pendingPoolOverlayDemotionContainers.add(container);
      this.pendingPoolOverlayDemotions.push({ grid, container });
    }
    this.schedulePoolOverlayDemotions();
  }

  private schedulePoolOverlayDemotions(): void {
    if (
      this.poolOverlayDemotionFrame !== undefined ||
      this.pendingPoolOverlayDemotions.length === 0
    ) {
      return;
    }
    const callback = (): void => {
      this.poolOverlayDemotionFrame = undefined;
      const startedAt = performance.now();
      let processed = 0;
      while (this.pendingPoolOverlayDemotions.length > 0) {
        const candidate = this.pendingPoolOverlayDemotions.shift();
        if (!candidate) break;
        this.pendingPoolOverlayDemotionContainers.delete(candidate.container);
        const mounted = this.overlays.get(candidate.container);
        if (
          mounted &&
          !mounted.viewportActive &&
          candidate.grid.isConnected &&
          candidate.grid.contains(candidate.container)
        ) {
          this.deferMountedPoolOverlay(candidate.container, mounted);
        }
        processed += 1;
        if (
          processed >= poolOverlayDemotionMaxCards ||
          performance.now() - startedAt >= poolOverlayDemotionBudgetMs
        ) {
          break;
        }
      }
      this.schedulePoolOverlayDemotions();
    };
    this.poolOverlayDemotionFrame =
      typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame(callback)
        : window.setTimeout(callback, 0);
  }

  private cancelPoolOverlayDemotions(): void {
    if (this.poolOverlayDemotionFrame !== undefined) {
      if (typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(this.poolOverlayDemotionFrame);
      } else {
        window.clearTimeout(this.poolOverlayDemotionFrame);
      }
      this.poolOverlayDemotionFrame = undefined;
    }
    this.pendingPoolOverlayDemotions.length = 0;
    this.pendingPoolOverlayDemotionContainers.clear();
  }

  private isKnownLineupPoolContainer(container: HTMLElement): boolean {
    if (
      container.closest<HTMLElement>(`[${lineupSortHydrationGridAttribute}]`)
    ) {
      return true;
    }
    let ancestor = container.parentElement;
    while (ancestor) {
      if (this.lineupPoolGrids.has(ancestor)) return true;
      ancestor = ancestor.parentElement;
    }
    return false;
  }

  private deferMountedPoolOverlay(
    container: HTMLElement,
    mounted: MountedOverlay,
  ): void {
    if (!this.visibilityObserver || !this.isKnownLineupPoolContainer(container)) {
      return;
    }
    this.visibilityObserver.unobserve(container);
    this.coordinator.releaseView(mounted.view);
    mounted.view.destroy({ preserveLineupSortData: true });
    delete container.dataset.sorareOverlayKey;
    this.overlays.delete(container);
    if (container.getAttribute(lineupSortDataReadyAttribute) === 'true') {
      container.setAttribute(lineupSortLightweightReadyAttribute, mounted.key);
    }
    this.deferredOverlays.set(container, {
      key: mounted.key,
      target: mounted.target,
    });
    container.setAttribute(deferredOverlayKeyAttribute, mounted.key);
    this.visibilityObserver.observe(container);
    this.layoutTargetsDirty = true;
  }

  private startLayoutObserver(): void {
    if (this.layoutObserver || typeof MutationObserver === 'undefined') return;
    this.layoutObserver = new MutationObserver((mutations) => {
      const views = new Set<OverlayView>();
      for (const mutation of mutations) {
        const target = mutation.target;
        if (!isElementNode(target)) continue;
        for (const view of this.layoutViewsByTarget.get(target) ?? []) {
          views.add(view);
        }
        const container = target.closest<HTMLElement>(
          '[data-sorare-overlay-key]',
        );
        const mounted = container ? this.overlays.get(container) : undefined;
        if (mounted) views.add(mounted.view);
      }
      for (const view of views) view.refreshPosition();
    });
  }

  private refreshLayoutObserverTargets(): void {
    if (!this.layoutTargetsDirty || !this.layoutObserver) return;
    this.layoutTargetsDirty = false;
    this.layoutObserver.disconnect();
    this.layoutViewsByTarget.clear();
    for (const [container, { view }] of this.overlays) {
      let target: HTMLElement | null = container;
      for (let depth = 0; target && depth < 4; depth += 1) {
        const views = this.layoutViewsByTarget.get(target) ?? new Set<OverlayView>();
        views.add(view);
        this.layoutViewsByTarget.set(target, views);
        target = target.parentElement;
      }
    }
    for (const target of this.layoutViewsByTarget.keys()) {
      const tracksCardSubtree = this.overlays.has(target as HTMLElement);
      this.layoutObserver.observe(target, {
        attributes: true,
        subtree: tracksCardSubtree,
        attributeFilter: [
          'class',
          'style',
          'hidden',
          'inert',
          'aria-hidden',
        ],
      });
    }
  }

  private queueScanRoot(root: Element): void {
    this.pendingScanRoots.add(root);
  }

  private schedulePictureNameRescans(delayMs = 80): void {
    if (
      this.pictureNameRescanTimer !== undefined ||
      this.pendingPictureNameRescanIds.size === 0
    ) {
      return;
    }
    this.pictureNameRescanTimer = window.setTimeout(() => {
      this.pictureNameRescanTimer = undefined;
      if (!this.root || this.pendingPictureNameRescanIds.size === 0) return;
      if (
        document.querySelector(`[${lineupSortHydrationGridAttribute}]`)
      ) {
        this.schedulePictureNameRescans(750);
        return;
      }
      this.flushPictureNameRescans();
    }, delayMs);
  }

  private flushPictureNameRescans(alreadyScannedRoot?: Node): void {
    if (this.pictureNameRescanTimer !== undefined) {
      window.clearTimeout(this.pictureNameRescanTimer);
      this.pictureNameRescanTimer = undefined;
    }
    if (!this.root || this.pendingPictureNameRescanIds.size === 0) return;
    const pictureIds = new Set(this.pendingPictureNameRescanIds);
    this.pendingPictureNameRescanIds.clear();
    for (const image of document.querySelectorAll<HTMLImageElement>('img[alt]')) {
      if (
        alreadyScannedRoot &&
        (alreadyScannedRoot === image || alreadyScannedRoot.contains(image))
      ) {
        continue;
      }
      if (extractPlayerName(image)) continue;
      const pictureId = extractCardPictureId(image);
      if (pictureId && pictureIds.has(pictureId)) this.queueScanRoot(image);
    }
    this.scheduleMutationFlush();
  }

  private queueScanContext(node: Node): void {
    let context =
      isElementNode(node)
        ? node
        : node.parentElement;
    const hydrationGrid = context?.closest<HTMLElement>(
      `[${lineupSortHydrationGridAttribute}]`,
    );
    if (context && hydrationGrid) {
      // New lineup cards are appended directly to an ever-growing grid. The
      // added nodes themselves are already queued above, so scanning the grid
      // again would turn every lazy-load pulse into another full-pool pass.
      if (context === hydrationGrid) return;
      while (
        context.parentElement &&
        context.parentElement !== hydrationGrid
      ) {
        context = context.parentElement;
      }
      if (context.parentElement === hydrationGrid) {
        this.pendingScanRoots.add(context);
      }
      return;
    }
    for (let depth = 0; context && depth < 4; depth += 1) {
      if (context === document.body || context === document.documentElement) {
        break;
      }
      this.pendingScanRoots.add(context);
      context = context.parentElement;
    }
  }

  private queuePositionContext(node: Node): void {
    let context = isElementNode(node) ? node : node.parentElement;
    const hydrationGrid = context?.closest<HTMLElement>(
      `[${lineupSortHydrationGridAttribute}]`,
    );
    if (context && hydrationGrid) {
      // Appending another row at the end of the picker does not move the
      // already mounted cards. New cards position themselves when their
      // IntersectionObserver entry arrives; inner-card mutations only need
      // to refresh that card's direct grid cell.
      if (context === hydrationGrid) return;
      while (
        context.parentElement &&
        context.parentElement !== hydrationGrid
      ) {
        context = context.parentElement;
      }
      if (context.parentElement === hydrationGrid) {
        this.pendingPositionScopes.add(context);
      }
      return;
    }
    for (let depth = 0; context && depth < 3; depth += 1) {
      if (context === document.body || context === document.documentElement) {
        this.shouldRefreshAllPositions = true;
        return;
      }
      this.pendingPositionScopes.add(context);
      context = context.parentElement;
    }
  }

  private scheduleMutationFlush(): void {
    if (
      this.mutationFrame !== undefined ||
      (this.pendingScanRoots.size === 0 &&
        this.mutationScanBacklog.length === 0 &&
        this.pendingPositionScopes.size === 0 &&
        !this.shouldRefreshAllPositions)
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

  private takeMutationScanRoots(): Element[] {
    const incoming = outermostElements(this.pendingScanRoots);
    this.pendingScanRoots.clear();
    if (this.mutationScanBacklog.length === 0) return incoming;
    if (incoming.length === 0) {
      const backlog = this.mutationScanBacklog;
      this.mutationScanBacklog = [];
      return backlog;
    }
    const combined = outermostElements([
      ...this.mutationScanBacklog,
      ...incoming,
    ]);
    this.mutationScanBacklog = [];
    return combined;
  }

  private flushMutations(): void {
    const continuesBacklog = this.mutationScanBacklog.length > 0;
    const knownLineupPosition = continuesBacklog
      ? this.mutationBacklogLineupPosition
      : activeLineupPosition();
    const roots = this.takeMutationScanRoots();
    const positionScopes = outermostElements(this.pendingPositionScopes);
    const refreshAllPositions = this.shouldRefreshAllPositions;
    this.pendingPositionScopes.clear();
    this.shouldRefreshAllPositions = false;
    const processedRoots: Element[] = [];
    const processedTargets: CardTarget[] = [];
    const startedAt = performance.now();
    let processedCount = 0;
    while (processedCount < roots.length) {
      const root = roots[processedCount];
      if (!root) break;
      const targets = this.scan(
        root,
        false,
        knownLineupPosition,
        false,
        0,
      );
      processedTargets.push(...targets);
      this.mutationHydrationTargets.push(...targets);
      processedRoots.push(root);
      processedCount += 1;
      if (
        processedCount >= mutationFlushMaxRoots ||
        performance.now() - startedAt >= mutationFlushBudgetMs
      ) {
        break;
      }
    }
    this.mutationScanBacklog = roots.slice(processedCount);
    this.mutationBacklogLineupPosition =
      this.mutationScanBacklog.length > 0
        ? knownLineupPosition
        : undefined;
    if (
      this.mutationScanBacklog.length === 0 &&
      this.pendingScanRoots.size === 0 &&
      this.mutationHydrationTargets.length > 0
    ) {
      this.hydrateLineupTargets(this.mutationHydrationTargets);
      this.mutationHydrationTargets.length = 0;
    }
    if (processedRoots.length > 0) {
      this.reconcileMountedOverlays(
        processedRoots,
        knownLineupPosition,
        new Set(processedTargets.map(({ container }) => container)),
      );
    } else {
      this.cleanupDisconnectedOverlays();
    }
    this.refreshLayoutObserverTargets();
    for (const [container, { view, viewportActive }] of this.overlays) {
      if (
        viewportActive &&
        (refreshAllPositions ||
          positionScopes.some(
            (scope) => scope.contains(container) || container.contains(scope),
          ))
      ) {
        view.refreshPosition();
      }
    }
    this.scheduleMutationFlush();
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
          const deferred = this.deferredOverlays.get(entry.target);
          if (deferred && entry.isIntersecting) {
            const priority = Math.max(
              viewportPriorityNearby,
              viewportPriorityForRect(entry.boundingClientRect),
            );
            this.releaseDeferredOverlay(entry.target);
            this.mountTarget(deferred.target, priority);
            continue;
          }
          const mounted = this.overlays.get(entry.target);
          if (!mounted) continue;
          if (
            !entry.isIntersecting &&
            this.isKnownLineupPoolContainer(entry.target)
          ) {
            this.deferMountedPoolOverlay(entry.target, mounted);
            continue;
          }
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
    forceRefresh = false,
  ): void {
    if (mounted.statsRequested) return;
    mounted.statsRequested = true;
    this.coordinator.enqueue(
      mounted.target,
      mounted.view,
      priority,
      forceRefresh,
    );
  }
}
