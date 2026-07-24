import type {
  FootballPosition,
  PlayerStats,
  PlayerStatsRequest,
  PlayerStatsSuccessResponse,
} from '@sorare-overlay/shared';
import { hasAnyDisplayData } from '@sorare-overlay/shared';
import { fetchPlayerStats } from './api.js';
import { findCardTargets, type CardTarget } from './dom.js';
import { OverlayView } from './overlay.js';

type StatsFetcher = (request: PlayerStatsRequest) => Promise<PlayerStatsSuccessResponse>;

interface PendingTarget {
  slug?: string;
  playerName?: string;
  position?: FootballPosition;
  views: Set<OverlayView>;
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

export class StatsBatchCoordinator {
  private readonly pending = new Map<string, PendingTarget>();
  private readonly cache = new Map<string, PlayerStats>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly retryTimers = new Map<string, number>();
  private timer: number | undefined;

  constructor(
    private readonly fetcher: StatsFetcher = fetchPlayerStats,
    private readonly debounceMs = 40,
    private readonly retryDelaysMs: readonly number[] = [5_000, 30_000],
  ) {}

  enqueue(target: CardTarget, view: OverlayView): void {
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
      view.render(cached);
      return;
    }

    this.queueTarget(target, [view]);
  }

  private queueTarget(
    target: Pick<PendingTarget, 'slug' | 'playerName' | 'position'>,
    views: Iterable<OverlayView>,
  ): void {
    const key = targetKey(target);
    const pendingTarget = this.pending.get(key) ?? {
      ...(target.slug ? { slug: target.slug } : {}),
      ...(target.playerName ? { playerName: target.playerName } : {}),
      ...(target.position ? { position: target.position } : {}),
      views: new Set<OverlayView>(),
    };
    for (const view of views) pendingTarget.views.add(view);
    this.pending.set(key, pendingTarget);
    if (this.timer === undefined) {
      this.timer = window.setTimeout(() => void this.flush(), this.debounceMs);
    }
  }

  async flush(): Promise<void> {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
    const batch = [...this.pending.values()];
    this.pending.clear();
    if (batch.length === 0) return;

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

    try {
      const response = await this.fetcher({
        slugs,
        playerNames,
        ...(Object.keys(positions).length ? { positions } : {}),
      });
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
        for (const view of target.views) {
          if (stats && hasAnyDisplayData(stats)) {
            view.render(stats);
          } else {
            view.noData();
          }
        }
        if (stats && hasAnyDisplayData(stats)) this.clearRetry(targetKey(target));
        else this.scheduleRetry(target);
      }
    } catch {
      for (const target of batch) {
        for (const view of target.views) view.error();
        this.scheduleRetry(target);
      }
    }
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
      this.queueTarget(target, activeViews);
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
  private readonly overlays = new Map<HTMLElement, { key: string; view: OverlayView }>();

  constructor(private readonly coordinator = new StatsBatchCoordinator()) {}

  start(): void {
    if (this.observer) return;
    const root = document.body ?? document.documentElement;
    this.scan(root);
    this.observer = new MutationObserver((mutations) => {
      let shouldRefresh = false;
      for (const mutation of mutations) {
        const mutationElement = mutation.target instanceof Element ? mutation.target : null;
        if (mutationElement?.closest('[data-sorare-overlay-root]')) continue;
        const externalAddedNodes =
          mutation.type === 'childList'
            ? [...mutation.addedNodes].filter(
                (node) =>
                  !(node instanceof Element && node.closest('[data-sorare-overlay-root]')),
              )
            : [];
        if (
          mutation.type === 'childList' &&
          externalAddedNodes.length === 0 &&
          mutation.removedNodes.length === 0
        ) {
          continue;
        }
        shouldRefresh = true;
        if (mutation.type === 'attributes') {
          this.scan(mutation.target as Element);
        } else {
          for (const added of externalAddedNodes) {
            if (added instanceof Element) this.scan(added);
          }
        }
        this.scanMutationContext(mutation.target);
      }
      if (shouldRefresh) {
        this.cleanupDisconnectedOverlays();
        for (const { view } of this.overlays.values()) view.refreshPosition();
      }
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
    for (const { view } of this.overlays.values()) view.destroy();
    this.overlays.clear();
  }

  scan(root: ParentNode): void {
    for (const target of findCardTargets(root)) {
      const key = targetKey(target);
      const mounted = this.overlays.get(target.container);
      if (mounted?.key === key) continue;
      if (mounted) mounted.view.destroy();
      const view = new OverlayView(
        target.container,
        { ...(target.slug ? { slug: target.slug } : {}), ...(target.playerName ? { playerName: target.playerName } : {}) },
        target.position,
      );
      target.container.dataset.sorareOverlayKey = key;
      this.overlays.set(target.container, { key, view });
      this.coordinator.enqueue(target, view);
    }
  }

  private cleanupDisconnectedOverlays(): void {
    for (const [container, { view }] of this.overlays) {
      if (container.isConnected) continue;
      view.destroy();
      this.overlays.delete(container);
    }
  }

  private scanMutationContext(node: Node): void {
    let context =
      node instanceof Element
        ? node
        : node.parentElement;
    for (let depth = 0; context && depth < 4; depth += 1) {
      this.scan(context);
      context = context.parentElement;
    }
  }
}
