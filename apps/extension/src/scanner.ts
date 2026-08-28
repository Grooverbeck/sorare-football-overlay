import type {
  FootballPosition,
  PlayerMarketOdds,
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
  LineupCardSorter,
  lineupAaSortOptionAttribute,
  lineupGoalSortOptionAttribute,
  lineupPoolProgressEvent,
  lineupPoolReadyEvent,
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
const extensionMountSelector =
  '[data-sorare-overlay-root], [data-sorare-overlay-companion]';
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
const defaultMaxCachedAliases = 8_192;
const defaultCachedAliasTtlMs = 6 * 60 * 60 * 1_000;

interface CachedAliasMetadata {
  lastAccessedAt: number;
  sequence: number;
}

export interface StatsBatchCoordinatorOptions {
  maxCachedAliases?: number;
  cachedAliasTtlMs?: number;
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
  isolateMarketOdds: boolean;
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

function isElementNode(node: Node): node is Element {
  return node.nodeType === 1;
}

function outermostElements(elements: Iterable<Element>): Element[] {
  const candidates = [...elements];
  return candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) => other !== candidate && other.contains(candidate),
      ),
  );
}

function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase();
}

function teamSlugsLikelyMatch(
  candidate: string | undefined,
  expected: string | undefined,
): boolean {
  if (!candidate || !expected) return false;
  const candidateNormalized = candidate.trim().toLowerCase();
  const expectedNormalized = expected.trim().toLowerCase();
  return (
    candidateNormalized === expectedNormalized ||
    candidateNormalized.startsWith(`${expectedNormalized}-`) ||
    expectedNormalized.startsWith(`${candidateNormalized}-`)
  );
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

function targetKey(
  target: TargetIdentity,
): string {
  const base = target.slug
    ? `slug:${target.slug}:${target.position ?? 'default'}`
    : `name:${normalizeName(target.playerName ?? '')}:${target.position ?? 'default'}`;
  return target.teamSlug ? `${base}:team:${target.teamSlug}` : base;
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

function hasIncompleteDisplayedMarketOdds(stats: PlayerStats): boolean {
  if (stats.position === 'Goalkeeper' || !stats.nextGame) return false;
  const odds = stats.nextGame.marketOdds;
  return !odds?.goal || !odds.assist;
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
  private readonly isolatedMarketRefreshKeys = new Set<string>();
  private readonly marketWarmupKeys = new Set<string>();
  private readonly cacheOnlyOddsRequestKeys = new Set<string>();
  private activeBatchCount = 0;
  private batchSequence = 0;
  private cacheSequence = 0;
  private timer: number | undefined;
  private includeHistoricalAssists = false;
  private readonly maxCachedAliases: number;
  private readonly cachedAliasTtlMs: number;

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
      } else {
        this.clearPendingRefresh(key);
      }
      if (!shouldForceRefresh) return;
    }

    this.queueTarget(target, [view], priority);
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
    const isolatedBatches: PendingTarget[][] = [];
    const regularTargets: PendingTarget[] = [];
    for (const target of queued) {
      const key = targetKey(target);
      if (this.isolatedMarketRefreshKeys.delete(key)) {
        isolatedBatches.push([target]);
      } else {
        regularTargets.push(target);
      }
    }
    const batches = [
      ...isolatedBatches,
      ...conflictFreeBatches(
        regularTargets,
        Math.max(1, this.progressiveBatchSize),
      ),
    ];
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
        this.cacheOnlyOddsRequestKeys.delete(key);
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
    const oddsCacheOnly =
      batch.length === 1 &&
      batch.every((target) =>
        this.cacheOnlyOddsRequestKeys.has(targetKey(target)),
      ) &&
      !refreshFixtures;
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
        ...(oddsCacheOnly ? { oddsCacheOnly: true } : {}),
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
      for (const mergedStats of responseData) {
        if (!canTrackStats(mergedStats)) continue;
        const changedKeys = this.cacheStatsAliases(mergedStats, batch);
        this.renderTrackedAliases(changedKeys, mergedStats);
      }
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
        const continueKnownMarketWarmup = Boolean(
          stats &&
            this.marketWarmupKeys.has(key) &&
            !stats.pendingRefreshes?.includes('marketOdds') &&
            hasIncompleteDisplayedMarketOdds(stats),
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
        if (stats?.pendingRefreshes?.length || continueKnownMarketWarmup) {
          this.schedulePendingRefresh(
            target,
            target.views,
            stats?.pendingRefreshes?.includes('fixture') ?? false,
            target.priority,
            (stats?.pendingRefreshes?.includes('marketOdds') ?? false) ||
              continueKnownMarketWarmup,
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
        if (oddsCacheOnly && this.marketWarmupKeys.has(key)) {
          this.schedulePendingRefresh(
            target,
            target.views,
            false,
            target.priority,
            true,
          );
          const retryScheduled = this.marketWarmupKeys.has(key);
          logStatsDiagnostic('request-failed', {
            target: {
              slug: target.slug ?? null,
              playerName: target.playerName ?? null,
              position: target.position ?? null,
            },
            message,
            retained: cached ? summarizeStats(cached) : null,
            retryScheduled,
            transient: true,
          });
          for (const view of target.views) {
            if (cached) view.render(cached, this.cachedStatsValues());
            else if (retryScheduled) view.retrying();
            else view.error();
          }
          continue;
        }
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

  private schedulePendingRefresh(
    target: TargetIdentity,
    views: Iterable<OverlayView>,
    refreshFixture = false,
    priority = 0,
    isolateMarketOdds = false,
  ): void {
    const key = targetKey(target);
    const connectedViews = this.connectedViews(views);
    if (refreshFixture) this.fixtureRefreshTargets.add(key);
    if (isolateMarketOdds) this.marketWarmupKeys.add(key);
    const existing = this.refreshWork.get(key);
    if (existing) {
      for (const view of connectedViews) existing.views.add(view);
      if (this.connectedViews(existing.views).length === 0) {
        this.clearPendingRefresh(key);
        return;
      }
      existing.priority = Math.max(existing.priority, priority);
      existing.refreshFixture ||= refreshFixture;
      existing.isolateMarketOdds ||= isolateMarketOdds;
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
      this.fixtureRefreshTargets.delete(key);
      this.isolatedMarketRefreshKeys.delete(key);
      this.marketWarmupKeys.delete(key);
      this.cacheOnlyOddsRequestKeys.delete(key);
      return;
    }

    this.refreshAttempts.set(key, attempt + 1);
    const work: PendingRefreshWork = {
      target,
      views: new Set(connectedViews),
      priority,
      remainingMs: delay,
      refreshFixture,
      isolateMarketOdds,
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
        this.isolatedMarketRefreshKeys.delete(key);
        this.marketWarmupKeys.delete(key);
        this.cacheOnlyOddsRequestKeys.delete(key);
        return;
      }
      const activeViews = connectedViews.filter((view) =>
        view.isViewportPriorityActive(),
      );
      if (activeViews.length === 0) return;
      this.refreshWork.delete(key);
      if (work.isolateMarketOdds) {
        this.isolatedMarketRefreshKeys.add(key);
        this.cacheOnlyOddsRequestKeys.add(key);
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
    this.isolatedMarketRefreshKeys.delete(key);
    this.marketWarmupKeys.delete(key);
    this.cacheOnlyOddsRequestKeys.delete(key);
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
  private readonly layoutViewsByTarget = new Map<Element, Set<OverlayView>>();
  private layoutTargetsDirty = false;
  private readonly pendingScanRoots = new Set<Element>();
  private readonly pendingPositionScopes = new Set<Element>();
  private mutationFrame: number | undefined;
  private shouldRefreshAllPositions = false;
  private readonly lineupSorter = new LineupCardSorter();
  private readonly handleLineupPoolReady = (event: Event): void => {
    const grid = event.target;
    if (!(grid instanceof HTMLElement)) return;
    this.scan(grid);
    for (const [container, mounted] of this.overlays) {
      if (grid.contains(container)) {
        this.requestStats(mounted, viewportPriorityNearby);
      }
    }
  };

  constructor(
    private readonly coordinator = new StatsBatchCoordinator(),
    private readonly onCardPictureNamesDiscovered?: (
      entries: Readonly<Record<string, string>>,
    ) => void,
  ) {}

  configureHistoricalAssistFallback(enabled: boolean): void {
    const changed = this.coordinator.setIncludeHistoricalAssists(enabled);
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
    root.addEventListener(lineupPoolProgressEvent, this.handleLineupPoolReady);
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
      this.handleLineupPoolReady,
    );
    this.root?.removeEventListener(
      lineupPoolReadyEvent,
      this.handleLineupPoolReady,
    );
    this.root = null;
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
    this.pendingScanRoots.clear();
    this.pendingPositionScopes.clear();
    this.shouldRefreshAllPositions = false;
    this.lineupSorter.stop();
    for (const [container, mounted] of [...this.overlays]) {
      this.releaseMountedOverlay(container, mounted);
    }
    this.layoutTargetsDirty = false;
    clearNativeSorareLineupProbabilityDecorations();
  }

  scan(root: ParentNode, refreshLayoutTargets = true): void {
    decorateNativeSorareLineupProbabilities(root);
    this.lineupSorter.scan(root);
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
    if (refreshLayoutTargets) this.refreshLayoutObserverTargets();
  }

  private mountTarget(target: CardTarget): void {
    const key = targetKey(target);
    const mounted = this.overlays.get(target.container);
    if (mounted?.key === key) return;
    if (mounted) {
      this.releaseMountedOverlay(target.container, mounted);
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
    this.layoutTargetsDirty = true;
    if (this.visibilityObserver) {
      this.visibilityObserver.observe(target.container);
      view.setViewportPriorityActive(mountedOverlay.viewportActive);
    }
    const requiresBackgroundHydration =
      view.requiresBackgroundLineupSortHydration();
    if (mountedOverlay.viewportActive || requiresBackgroundHydration) {
      this.requestStats(
        mountedOverlay,
        mountedOverlay.viewportActive ? priority : viewportPriorityNearby,
      );
    }
  }

  private reconcileMountedOverlays(scopes: readonly Element[]): void {
    for (const [container, mounted] of [...this.overlays]) {
      if (
        scopes.length > 0 &&
        !scopes.some(
          (scope) => scope.contains(container) || container.contains(scope),
        )
      ) {
        continue;
      }
      const currentTarget = container.isConnected
        ? findCardTargets(container).find(
            (candidate) => candidate.container === container,
          )
        : undefined;
      if (!currentTarget) {
        this.releaseMountedOverlay(container, mounted);
        continue;
      }
      if (targetKey(currentTarget) === mounted.key) continue;
      this.releaseMountedOverlay(container, mounted);
      this.mountTarget(currentTarget);
    }
  }

  private cleanupDisconnectedOverlays(): void {
    for (const [container, mounted] of this.overlays) {
      if (container.isConnected) continue;
      this.releaseMountedOverlay(container, mounted);
    }
  }

  private releaseRemovedOverlays(removedRoot: Element): void {
    for (const [container, mounted] of [...this.overlays]) {
      if (container === removedRoot || removedRoot.contains(container)) {
        this.releaseMountedOverlay(container, mounted);
      }
    }
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

  private queueScanContext(node: Node): void {
    let context =
      isElementNode(node)
        ? node
        : node.parentElement;
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

  private flushMutations(): void {
    const roots = outermostElements(this.pendingScanRoots);
    const positionScopes = outermostElements(this.pendingPositionScopes);
    const refreshAllPositions = this.shouldRefreshAllPositions;
    this.pendingScanRoots.clear();
    this.pendingPositionScopes.clear();
    this.shouldRefreshAllPositions = false;
    for (const root of roots) this.scan(root, false);
    if (roots.length > 0) {
      this.reconcileMountedOverlays(roots);
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
