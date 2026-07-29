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

function chunks<T>(values: readonly T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
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
  private readonly cache = new Map<string, PlayerStats>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly retryTimers = new Map<string, number>();
  private readonly refreshAttempts = new Map<string, number>();
  private readonly refreshTimers = new Map<string, number>();
  private readonly refreshViews = new Map<string, Set<OverlayView>>();
  private readonly fixtureRefreshTargets = new Set<string>();
  private timer: number | undefined;
  private includeHistoricalAssists = false;

  constructor(
    private readonly fetcher: StatsFetcher = fetchPlayerStats,
    private readonly debounceMs = 40,
    private readonly retryDelaysMs: readonly number[] = [5_000, 30_000],
    private readonly progressiveBatchSize = 3,
    private readonly maxConcurrentBatches = 2,
    private readonly refreshDelaysMs: readonly number[] = [2_500, 8_000],
  ) {}

  setIncludeHistoricalAssists(enabled: boolean): void {
    if (this.includeHistoricalAssists === enabled) return;
    this.includeHistoricalAssists = enabled;
    if (enabled) this.cache.clear();
  }

  enqueue(target: CardTarget, view: OverlayView, priority = 0): void {
    const key = targetKey(target);
    this.clearRetry(key);
    const exact = this.cache.get(key);
    const cached =
      exact ??
      [...this.cache.values()].find(
        (stats) =>
          (target.position === undefined || stats.position === target.position) &&
          ((target.slug !== undefined && stats.slug === target.slug) ||
            (target.playerName !== undefined &&
              namesLikelyMatch(target.playerName, stats.displayName))),
      );
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

  private queueTarget(
    target: Pick<PendingTarget, 'slug' | 'playerName' | 'position'>,
    views: Iterable<OverlayView>,
    priority = 0,
  ): void {
    const key = targetKey(target);
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

    const batches = chunks(
      queued,
      Math.max(1, this.progressiveBatchSize),
    );
    let nextBatch = 0;
    const workers = Array.from(
      {
        length: Math.min(
          Math.max(1, this.maxConcurrentBatches),
          batches.length,
        ),
      },
      async () => {
        while (nextBatch < batches.length) {
          const batch = batches[nextBatch];
          nextBatch += 1;
          if (batch) await this.loadBatch(batch);
        }
      },
    );
    await Promise.all(workers);
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

    try {
      const response = await this.fetcher({
        slugs,
        playerNames,
        ...(Object.keys(positions).length ? { positions } : {}),
        ...(includeHistoricalAssists
          ? { includeHistoricalAssists: true }
          : {}),
        ...(refreshFixtures ? { refreshFixtures: true } : {}),
      });
      const diagnosticRequestId = statsDiagnosticRequestId(response);
      if (includeHistoricalAssists !== this.includeHistoricalAssists) {
        for (const target of batch) {
          this.queueTarget(target, target.views, target.priority);
        }
        return;
      }
      const deferredPlayerNames = new Set(
        (response.meta.deferredPlayerNames ?? []).map(normalizeName),
      );
      for (const stats of response.data) {
        if (!hasAnyDisplayData(stats)) continue;
        this.cache.set(targetKey({ slug: stats.slug, position: stats.position }), stats);
        this.cache.set(targetKey({ slug: stats.slug }), stats);
        this.cache.set(
          targetKey({ playerName: stats.displayName, position: stats.position }),
          stats,
        );
        this.cache.set(targetKey({ playerName: stats.displayName }), stats);
      }
      for (const target of batch) {
        this.fixtureRefreshTargets.delete(targetKey(target));
        const stats =
          this.cache.get(targetKey(target)) ??
          response.data.find(
            (candidate) =>
              hasAnyDisplayData(candidate) &&
              (target.position === undefined || candidate.position === target.position) &&
              ((target.slug !== undefined && candidate.slug === target.slug) ||
                (target.playerName !== undefined &&
                namesLikelyMatch(target.playerName, candidate.displayName))),
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
        if (stats && hasAnyDisplayData(stats)) this.clearRetry(targetKey(target));
        else this.scheduleRetry(target);
        if (stats?.pendingRefreshes?.length) {
          this.schedulePendingRefresh(
            target,
            target.views,
            stats.pendingRefreshes.includes('fixture'),
            target.priority,
          );
        } else if (stats) {
          this.clearPendingRefresh(targetKey(target));
        }
      }
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : 'UNKNOWN_ERROR: Stats nicht verfügbar';
      console.warn('[Sorare Overlay] Statistikabruf fehlgeschlagen:', error);
      for (const target of batch) {
        for (const view of target.views) view.error(message);
        this.scheduleRetry(target);
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
    const activeCandidates =
      this.refreshViews.get(key) ?? new Set<OverlayView>();
    for (const view of views) activeCandidates.add(view);
    this.refreshViews.set(key, activeCandidates);
    if (this.refreshTimers.has(key)) return;
    const attempt = this.refreshAttempts.get(key) ?? 0;
    const delay = this.refreshDelaysMs[attempt];
    if (delay === undefined) {
      this.refreshViews.delete(key);
      this.fixtureRefreshTargets.delete(key);
      return;
    }

    this.refreshAttempts.set(key, attempt + 1);
    const timer = window.setTimeout(() => {
      this.refreshTimers.delete(key);
      const activeViews = [...(this.refreshViews.get(key) ?? [])].filter(
        (view) => view.host.isConnected,
      );
      this.refreshViews.delete(key);
      if (activeViews.length === 0) {
        this.refreshAttempts.delete(key);
        this.fixtureRefreshTargets.delete(key);
        return;
      }
      this.removeCachedTarget(target);
      this.queueTarget(target, activeViews, priority);
    }, delay);
    this.refreshTimers.set(key, timer);
  }

  private removeCachedTarget(
    target: Pick<PendingTarget, 'slug' | 'playerName' | 'position'>,
  ): void {
    for (const [key, stats] of this.cache) {
      const identityMatches =
        (target.slug !== undefined && stats.slug === target.slug) ||
        (target.playerName !== undefined &&
          namesLikelyMatch(target.playerName, stats.displayName));
      const positionMatches =
        target.position === undefined || stats.position === target.position;
      if (identityMatches && positionMatches) this.cache.delete(key);
    }
  }

  private clearPendingRefresh(key: string): void {
    const timer = this.refreshTimers.get(key);
    if (timer !== undefined) window.clearTimeout(timer);
    this.refreshTimers.delete(key);
    this.refreshViews.delete(key);
    this.refreshAttempts.delete(key);
    this.fixtureRefreshTargets.delete(key);
  }

  private scheduleRetry(target: PendingTarget): void {
    const key = targetKey(target);
    if (this.retryTimers.has(key)) return;
    const attempt = this.retryAttempts.get(key) ?? 0;
    const delay = this.retryDelaysMs[attempt];
    if (delay === undefined) return;

    const views = new Set(target.views);
    this.retryAttempts.set(key, attempt + 1);
    const timer = window.setTimeout(() => {
      this.retryTimers.delete(key);
      const activeViews = [...views].filter((view) => view.host.isConnected);
      if (activeViews.length === 0) {
        this.retryAttempts.delete(key);
        return;
      }
      this.queueTarget(target, activeViews, target.priority);
    }, delay);
    this.retryTimers.set(key, timer);
  }

  private clearRetry(key: string): void {
    const timer = this.retryTimers.get(key);
    if (timer !== undefined) window.clearTimeout(timer);
    this.retryTimers.delete(key);
    this.retryAttempts.delete(key);
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
