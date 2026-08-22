export const lineupGoalSortControlAttribute =
  'data-sorare-overlay-goal-sort-control';
export const lineupGoalSortProbabilityAttribute =
  'data-sorare-overlay-goal-sort-probability';
export const lineupGoalSortSourceAttribute =
  'data-sorare-overlay-goal-sort-source';
export const lineupGoalSortValueChangedEvent =
  'sorare-overlay:goal-sort-value-changed';

export type LineupGoalSortSource = 'market' | 'historical';

const cardImageSelector =
  'img[src*="/cardsamplepicture/"], img[alt$=" - common" i], img[alt$=" - limited" i], img[alt$=" - rare" i], img[alt$=" - super rare" i], img[alt$=" - unique" i]';

interface OriginalOrder {
  value: string;
  priority: string;
}

interface SortableCell {
  cell: HTMLElement;
  originalIndex: number;
  probability: number | null;
}

export function supportsLineupGoalSortPath(pathname: string): boolean {
  return /\/compose-team(?:\/|$)/i.test(pathname);
}

export function setLineupGoalSortValue(
  container: HTMLElement,
  probability: number | null,
  source?: LineupGoalSortSource,
): void {
  if (
    probability === null ||
    !Number.isFinite(probability) ||
    probability < 0 ||
    probability > 1 ||
    !source
  ) {
    container.removeAttribute(lineupGoalSortProbabilityAttribute);
    container.removeAttribute(lineupGoalSortSourceAttribute);
  } else {
    container.setAttribute(
      lineupGoalSortProbabilityAttribute,
      probability.toString(),
    );
    container.setAttribute(lineupGoalSortSourceAttribute, source);
  }
  container.dispatchEvent(
    new CustomEvent(lineupGoalSortValueChangedEvent, { bubbles: true }),
  );
}

function isNativeSortButton(button: HTMLButtonElement): boolean {
  const toolbar = button.parentElement;
  return Boolean(
    button.matches('button[aria-haspopup="dialog"]') &&
      button.querySelector('svg[data-icon="iconChevronDown"]') &&
      toolbar?.querySelector('input[type="search"]') &&
      toolbar.querySelector('svg[data-icon="iconFilter"]'),
  );
}

function nativeSortButton(): HTMLButtonElement | null {
  return (
    Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        'button[aria-haspopup="dialog"]',
      ),
    ).find(isNativeSortButton) ?? null
  );
}

function createBallIcon(): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const circle = document.createElementNS(namespace, 'circle');
  circle.setAttribute('cx', '8');
  circle.setAttribute('cy', '8');
  circle.setAttribute('r', '6.5');
  circle.setAttribute('fill', 'none');
  circle.setAttribute('stroke', 'currentColor');
  circle.setAttribute('stroke-width', '1.4');

  const center = document.createElementNS(namespace, 'path');
  center.setAttribute('d', 'M8 4.4 10.2 6 9.35 8.6H6.65L5.8 6Z');
  center.setAttribute('fill', 'currentColor');

  const seams = document.createElementNS(namespace, 'path');
  seams.setAttribute(
    'd',
    'M8 4.4V1.6M5.8 6 3.15 5.15M6.65 8.6 5.05 11.05M9.35 8.6 10.95 11.05M10.2 6 12.85 5.15',
  );
  seams.setAttribute('fill', 'none');
  seams.setAttribute('stroke', 'currentColor');
  seams.setAttribute('stroke-width', '1.1');
  seams.setAttribute('stroke-linecap', 'round');

  svg.append(circle, center, seams);
  return svg;
}

function directGridCell(container: HTMLElement): HTMLElement | null {
  let candidate: HTMLElement = container;
  for (let depth = 0; candidate.parentElement && depth < 14; depth += 1) {
    const parent = candidate.parentElement;
    const display = window.getComputedStyle(parent).display;
    if (
      display.includes('grid') &&
      parent.children.length > 1 &&
      !parent.closest('[class~="slots5"]')
    ) {
      return candidate;
    }
    candidate = parent;
  }
  return null;
}

function probabilityForCell(cell: HTMLElement): number | null {
  const values = Array.from(
    cell.querySelectorAll<HTMLElement>(
      `[${lineupGoalSortProbabilityAttribute}]`,
    ),
  ).flatMap((container) => {
    const probability = Number(
      container.getAttribute(lineupGoalSortProbabilityAttribute),
    );
    return Number.isFinite(probability) && probability >= 0 && probability <= 1
      ? [probability]
      : [];
  });
  return values.length > 0 ? Math.max(...values) : null;
}

function sortableGrid(): HTMLElement | null {
  const trackedByGrid = new Map<HTMLElement, Set<HTMLElement>>();
  for (const container of document.querySelectorAll<HTMLElement>(
    `[${lineupGoalSortProbabilityAttribute}]`,
  )) {
    const cell = directGridCell(container);
    const grid = cell?.parentElement;
    if (!cell || !grid) continue;
    const cells = trackedByGrid.get(grid) ?? new Set<HTMLElement>();
    cells.add(cell);
    trackedByGrid.set(grid, cells);
  }

  return (
    [...trackedByGrid]
      .filter(([grid]) => grid.querySelectorAll(cardImageSelector).length > 1)
      .sort(
        ([leftGrid, leftCells], [rightGrid, rightCells]) =>
          rightCells.size - leftCells.size ||
          rightGrid.querySelectorAll(cardImageSelector).length -
            leftGrid.querySelectorAll(cardImageSelector).length,
      )[0]?.[0] ?? null
  );
}

export class LineupGoalOddsSorter {
  private root: HTMLElement | null = null;
  private control: HTMLButtonElement | null = null;
  private active = false;
  private sortFrame: number | undefined;
  private readonly originalOrders = new Map<HTMLElement, OriginalOrder>();

  private readonly handleGoalValueChange = (): void => {
    if (this.active) this.scheduleSort();
  };

  private readonly handleDocumentClick = (event: Event): void => {
    if (!this.active || !(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>('button');
    if (button && button !== this.control && isNativeSortButton(button)) {
      this.setActive(false);
    }
  };

  private readonly handleRouteChange = (): void => {
    this.scan(document);
  };

  start(root = document.body ?? document.documentElement): void {
    if (this.root) return;
    this.root = root;
    root.addEventListener(
      lineupGoalSortValueChangedEvent,
      this.handleGoalValueChange,
    );
    document.addEventListener('click', this.handleDocumentClick, true);
    window.addEventListener('popstate', this.handleRouteChange);
    window.addEventListener('hashchange', this.handleRouteChange);
    this.scan(document);
  }

  stop(): void {
    if (this.root) {
      this.root.removeEventListener(
        lineupGoalSortValueChangedEvent,
        this.handleGoalValueChange,
      );
    }
    document.removeEventListener('click', this.handleDocumentClick, true);
    window.removeEventListener('popstate', this.handleRouteChange);
    window.removeEventListener('hashchange', this.handleRouteChange);
    this.cancelSortFrame();
    this.setActive(false);
    this.removeControl();
    this.root = null;
  }

  scan(_root: ParentNode): void {
    if (!supportsLineupGoalSortPath(window.location.pathname)) {
      this.setActive(false);
      this.removeControl();
      return;
    }
    this.mountControl();
    if (this.active) this.scheduleSort();
  }

  private mountControl(): void {
    const nativeSort = nativeSortButton();
    if (!nativeSort?.parentElement) return;
    if (
      this.control?.isConnected &&
      this.control.parentElement === nativeSort.parentElement
    ) {
      return;
    }
    this.removeControl();

    const control = document.createElement('button');
    control.type = 'button';
    control.setAttribute(lineupGoalSortControlAttribute, 'true');
    control.setAttribute('aria-pressed', 'false');
    control.title =
      'Nach Torwahrscheinlichkeit sortieren – Marktquoten und historische Werte werden gemeinsam verglichen.';
    const label = document.createElement('span');
    label.dataset.sorareOverlayGoalSortLabel = 'true';
    label.textContent = 'Torquote';
    control.append(createBallIcon(), label);
    control.addEventListener('click', () => this.setActive(!this.active));
    nativeSort.insertAdjacentElement('afterend', control);
    this.control = control;
    this.updateControl();
  }

  private removeControl(): void {
    this.control?.remove();
    this.control = null;
  }

  private setActive(active: boolean): void {
    if (this.active === active) {
      this.updateControl();
      return;
    }
    this.active = active;
    this.updateControl();
    if (active) {
      this.scheduleSort();
    } else {
      this.cancelSortFrame();
      this.restoreOriginalOrders();
    }
  }

  private updateControl(): void {
    if (!this.control) return;
    this.control.setAttribute('aria-pressed', String(this.active));
    const label = this.control.querySelector<HTMLElement>(
      '[data-sorare-overlay-goal-sort-label]',
    );
    if (label) label.textContent = this.active ? 'Torquote ↓' : 'Torquote';
  }

  private scheduleSort(): void {
    if (!this.active || this.sortFrame !== undefined) return;
    const callback = (): void => {
      this.sortFrame = undefined;
      this.applySort();
    };
    this.sortFrame =
      typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame(callback)
        : window.setTimeout(callback, 0);
  }

  private cancelSortFrame(): void {
    if (this.sortFrame === undefined) return;
    if (typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(this.sortFrame);
    } else {
      window.clearTimeout(this.sortFrame);
    }
    this.sortFrame = undefined;
  }

  private applySort(): void {
    if (!this.active) return;
    const grid = sortableGrid();
    if (!grid) return;

    const cells: SortableCell[] = Array.from(grid.children).flatMap(
      (child, originalIndex) =>
        child instanceof HTMLElement && child.querySelector(cardImageSelector)
          ? [
              {
                cell: child,
                originalIndex,
                probability: probabilityForCell(child),
              },
            ]
          : [],
    );
    if (cells.length < 2) return;

    for (const { cell } of cells) {
      if (!this.originalOrders.has(cell)) {
        this.originalOrders.set(cell, {
          value: cell.style.getPropertyValue('order'),
          priority: cell.style.getPropertyPriority('order'),
        });
      }
    }

    cells.sort(
      (left, right) =>
        (right.probability ?? -1) - (left.probability ?? -1) ||
        left.originalIndex - right.originalIndex,
    );
    const firstOrder = -cells.length;
    cells.forEach(({ cell }, index) => {
      const order = String(firstOrder + index);
      if (
        cell.style.getPropertyValue('order') !== order ||
        cell.style.getPropertyPriority('order') !== ''
      ) {
        cell.style.setProperty('order', order);
      }
    });

    for (const cell of [...this.originalOrders.keys()]) {
      if (!cell.isConnected) this.originalOrders.delete(cell);
    }
  }

  private restoreOriginalOrders(): void {
    for (const [cell, order] of this.originalOrders) {
      if (!cell.isConnected) continue;
      if (order.value) {
        cell.style.setProperty('order', order.value, order.priority);
      } else {
        cell.style.removeProperty('order');
      }
    }
    this.originalOrders.clear();
  }
}
