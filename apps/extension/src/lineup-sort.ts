export const lineupGoalSortOptionAttribute =
  'data-sorare-overlay-goal-sort-option';
export const lineupGoalSortProbabilityAttribute =
  'data-sorare-overlay-goal-sort-probability';
export const lineupGoalSortSourceAttribute =
  'data-sorare-overlay-goal-sort-source';
export const lineupAaSortOptionAttribute =
  'data-sorare-overlay-aa-sort-option';
export const lineupAaSortValueAttribute =
  'data-sorare-overlay-aa-sort-value';
export const lineupSortValueChangedEvent =
  'sorare-overlay:lineup-sort-value-changed';

export type LineupGoalSortSource = 'market' | 'historical';
export type LineupSortMode = 'goal' | 'aa';

interface LineupSortConfig {
  mode: LineupSortMode;
  label: string;
  description: string;
  title: string;
  optionAttribute: string;
  valueAttribute: string;
}

const lineupSortConfigs: Record<LineupSortMode, LineupSortConfig> = {
  goal: {
    mode: 'goal',
    label: 'Torquote',
    description: 'Markt & Historie gemeinsam',
    title:
      'Nach Torwahrscheinlichkeit sortieren – Marktquoten und historische Werte werden gemeinsam verglichen.',
    optionAttribute: lineupGoalSortOptionAttribute,
    valueAttribute: lineupGoalSortProbabilityAttribute,
  },
  aa: {
    mode: 'aa',
    label: 'AA',
    description: 'L10 · mindestens 60 Minuten',
    title:
      'Nach dem durchschnittlichen All-Around Score der letzten zehn Spiele mit mindestens 60 Minuten sortieren.',
    optionAttribute: lineupAaSortOptionAttribute,
    valueAttribute: lineupAaSortValueAttribute,
  },
};

const cardImageSelector =
  'img[src*="/cardsamplepicture/"], img[alt$=" - common" i], img[alt$=" - limited" i], img[alt$=" - rare" i], img[alt$=" - super rare" i], img[alt$=" - unique" i]';
const nativeTriggerLabelAttribute =
  'data-sorare-overlay-lineup-sort-trigger-label';
const nativeMenuActiveAttribute =
  'data-sorare-overlay-lineup-sort-active';
const nativeMenuOptionAttribute =
  'data-sorare-overlay-native-sort-option';

interface OriginalOrder {
  value: string;
  priority: string;
}

interface SortableCell {
  cell: HTMLElement;
  originalIndex: number;
  value: number | null;
}

export function supportsLineupSortPath(pathname: string): boolean {
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
    new CustomEvent(lineupSortValueChangedEvent, { bubbles: true }),
  );
}

export function setLineupAaSortValue(
  container: HTMLElement,
  value: number | null,
): void {
  if (value === null || !Number.isFinite(value)) {
    container.removeAttribute(lineupAaSortValueAttribute);
  } else {
    container.setAttribute(lineupAaSortValueAttribute, value.toString());
  }
  container.dispatchEvent(
    new CustomEvent(lineupSortValueChangedEvent, { bubbles: true }),
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

function nativeSortDialog(trigger: HTMLButtonElement): HTMLElement | null {
  const controls = trigger.getAttribute('aria-controls');
  if (!controls) return null;
  const dialog = document.getElementById(controls);
  return dialog?.getAttribute('role') === 'dialog' &&
    dialog.getAttribute('data-state') !== 'closed'
    ? dialog
    : null;
}

function nativeSortOptions(dialog: HTMLElement): HTMLButtonElement[] {
  return Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).filter(
    (button) =>
      !button.hasAttribute(lineupGoalSortOptionAttribute) &&
      !button.hasAttribute(lineupAaSortOptionAttribute) &&
      Boolean(button.querySelector('input[type="radio"]')),
  );
}

function nativeSortTriggerLabel(
  trigger: HTMLButtonElement,
): HTMLElement | null {
  const leaves = Array.from(trigger.querySelectorAll<HTMLElement>('div')).filter(
    (element) =>
      element.children.length === 0 && Boolean(element.textContent?.trim()),
  );
  return leaves[0] ?? null;
}

function setRadioVisual(button: HTMLButtonElement, checked: boolean): void {
  const radio = button.querySelector<HTMLInputElement>('input[type="radio"]');
  if (radio) {
    radio.checked = checked;
    radio.toggleAttribute('checked', checked);
  }
  const graphic = button.querySelector<SVGSVGElement>('svg');
  const circles = graphic?.querySelectorAll<SVGCircleElement>('circle');
  if (!graphic || !circles || circles.length < 2) return;
  const tone = 'var(--c-blue-400)';
  graphic.setAttribute('fill', checked ? tone : 'none');
  circles[0]?.setAttribute('stroke', checked ? tone : 'currentColor');
  circles[0]?.setAttribute('fill', 'transparent');
  circles[1]?.setAttribute('fill', checked ? tone : 'transparent');
}

function createNativeSortOption(
  template: HTMLButtonElement,
  config: LineupSortConfig,
): HTMLButtonElement | null {
  const option = template.cloneNode(true) as HTMLButtonElement;
  option.setAttribute(config.optionAttribute, 'true');
  option.title = config.title;
  for (const element of option.querySelectorAll<HTMLElement>('[id]')) {
    element.removeAttribute('id');
  }
  const textLeaves = Array.from(option.querySelectorAll<HTMLElement>('div')).filter(
    (element) =>
      element.children.length === 0 && Boolean(element.textContent?.trim()),
  );
  const label = textLeaves[0];
  const description = textLeaves[textLeaves.length - 1];
  if (!label || !description || label === description) return null;
  label.textContent = config.label;
  description.textContent = config.description;
  setRadioVisual(option, false);
  return option;
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

function valueForCell(cell: HTMLElement, valueAttribute: string): number | null {
  const values = Array.from(
    cell.querySelectorAll<HTMLElement>(`[${valueAttribute}]`),
  ).flatMap((container) => {
    const value = Number(container.getAttribute(valueAttribute));
    return Number.isFinite(value) ? [value] : [];
  });
  return values.length > 0 ? Math.max(...values) : null;
}

function sortableGrid(valueAttribute: string): HTMLElement | null {
  const trackedByGrid = new Map<HTMLElement, Set<HTMLElement>>();
  for (const container of document.querySelectorAll<HTMLElement>(
    `[${valueAttribute}]`,
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

export class LineupCardSorter {
  private root: HTMLElement | null = null;
  private nativeTrigger: HTMLButtonElement | null = null;
  private nativeTriggerLabel: HTMLElement | null = null;
  private originalTriggerLabel = '';
  private nativeMenu: HTMLElement | null = null;
  private readonly menuOptions = new Map<
    LineupSortMode,
    HTMLButtonElement
  >();
  private readonly nativeRadioStates = new Map<HTMLInputElement, boolean>();
  private activeMode: LineupSortMode | null = null;
  private sortFrame: number | undefined;
  private readonly originalOrders = new Map<HTMLElement, OriginalOrder>();

  private readonly handleSortValueChange = (): void => {
    if (this.activeMode) this.scheduleSort();
  };

  private readonly handleDocumentClick = (event: Event): void => {
    if (!this.activeMode || !(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>('button');
    if ([...this.menuOptions.values()].includes(button as HTMLButtonElement)) {
      return;
    }
    if (
      button &&
      this.nativeMenu?.contains(button) &&
      button.querySelector('input[type="radio"]')
    ) {
      this.setActiveMode(null);
    }
  };

  private readonly handleRouteChange = (): void => {
    this.scan(document);
  };

  start(root = document.body ?? document.documentElement): void {
    if (this.root) return;
    this.root = root;
    root.addEventListener(
      lineupSortValueChangedEvent,
      this.handleSortValueChange,
    );
    document.addEventListener('click', this.handleDocumentClick, true);
    window.addEventListener('popstate', this.handleRouteChange);
    window.addEventListener('hashchange', this.handleRouteChange);
    this.scan(document);
  }

  stop(): void {
    if (this.root) {
      this.root.removeEventListener(
        lineupSortValueChangedEvent,
        this.handleSortValueChange,
      );
    }
    document.removeEventListener('click', this.handleDocumentClick, true);
    window.removeEventListener('popstate', this.handleRouteChange);
    window.removeEventListener('hashchange', this.handleRouteChange);
    this.cancelSortFrame();
    this.setActiveMode(null);
    this.removeMenuOptions();
    this.restoreNativeTrigger();
    this.root = null;
  }

  scan(_root: ParentNode): void {
    if (!supportsLineupSortPath(window.location.pathname)) {
      this.setActiveMode(null);
      this.removeMenuOptions();
      this.restoreNativeTrigger();
      return;
    }
    this.syncNativeSortUi();
    if (this.activeMode) this.scheduleSort();
  }

  private syncNativeSortUi(): void {
    const trigger = nativeSortButton();
    if (!trigger) {
      this.removeMenuOptions();
      this.restoreNativeTrigger();
      return;
    }
    this.syncNativeTrigger(trigger);
    const dialog = nativeSortDialog(trigger);
    if (!dialog) {
      this.removeMenuOptions();
      return;
    }
    this.mountMenuOptions(dialog, trigger);
  }

  private syncNativeTrigger(trigger: HTMLButtonElement): void {
    if (trigger !== this.nativeTrigger) {
      this.restoreNativeTrigger();
      this.nativeTrigger = trigger;
    }
    const label = nativeSortTriggerLabel(trigger);
    if (!label) return;
    if (label !== this.nativeTriggerLabel) {
      this.nativeTriggerLabel = label;
      this.originalTriggerLabel = label.textContent?.trim() ?? '';
    }
    if (this.activeMode) {
      if (!label.hasAttribute(nativeTriggerLabelAttribute)) {
        this.originalTriggerLabel = label.textContent?.trim() ?? '';
      }
      label.setAttribute(nativeTriggerLabelAttribute, 'true');
      label.textContent = lineupSortConfigs[this.activeMode].label;
    } else if (label.hasAttribute(nativeTriggerLabelAttribute)) {
      label.textContent = this.originalTriggerLabel;
      label.removeAttribute(nativeTriggerLabelAttribute);
    } else {
      this.originalTriggerLabel = label.textContent?.trim() ?? '';
    }
  }

  private restoreNativeTrigger(): void {
    if (this.nativeTriggerLabel?.hasAttribute(nativeTriggerLabelAttribute)) {
      this.nativeTriggerLabel.textContent = this.originalTriggerLabel;
      this.nativeTriggerLabel.removeAttribute(nativeTriggerLabelAttribute);
    }
    this.nativeTrigger = null;
    this.nativeTriggerLabel = null;
    this.originalTriggerLabel = '';
  }

  private mountMenuOptions(
    dialog: HTMLElement,
    trigger: HTMLButtonElement,
  ): void {
    if (
      this.nativeMenu === dialog &&
      this.menuOptions.size === Object.keys(lineupSortConfigs).length &&
      [...this.menuOptions.values()].every((option) => option.isConnected)
    ) {
      this.updateMenuSelection();
      return;
    }
    this.removeMenuOptions();
    const nativeOptions = nativeSortOptions(dialog);
    const template = nativeOptions[nativeOptions.length - 1];
    const parent = template?.parentElement;
    if (!template || !parent) return;
    this.nativeMenu = dialog;
    for (const config of Object.values(lineupSortConfigs)) {
      const option = createNativeSortOption(template, config);
      if (!option) continue;
      option.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.setActiveMode(config.mode);
        if (trigger.getAttribute('aria-expanded') === 'true') trigger.click();
      });
      parent.append(option);
      this.menuOptions.set(config.mode, option);
    }
    this.updateMenuSelection();
  }

  private updateMenuSelection(): void {
    if (!this.nativeMenu || this.menuOptions.size === 0) return;
    this.nativeMenu.toggleAttribute(
      nativeMenuActiveAttribute,
      this.activeMode !== null,
    );
    for (const [mode, option] of this.menuOptions) {
      setRadioVisual(option, mode === this.activeMode);
    }
    if (this.activeMode) {
      for (const button of nativeSortOptions(this.nativeMenu)) {
        button.setAttribute(nativeMenuOptionAttribute, 'true');
        const radio = button.querySelector<HTMLInputElement>(
          'input[type="radio"]',
        );
        if (!radio) continue;
        if (!this.nativeRadioStates.has(radio)) {
          this.nativeRadioStates.set(radio, radio.checked);
        }
        radio.checked = false;
      }
    } else {
      this.restoreNativeRadioStates();
    }
  }

  private restoreNativeRadioStates(): void {
    for (const [radio, checked] of this.nativeRadioStates) {
      if (radio.isConnected) radio.checked = checked;
    }
    this.nativeRadioStates.clear();
    for (const button of this.nativeMenu?.querySelectorAll<HTMLElement>(
      `[${nativeMenuOptionAttribute}]`,
    ) ?? []) {
      button.removeAttribute(nativeMenuOptionAttribute);
    }
    this.nativeMenu?.removeAttribute(nativeMenuActiveAttribute);
  }

  private removeMenuOptions(): void {
    this.restoreNativeRadioStates();
    for (const option of this.menuOptions.values()) option.remove();
    this.menuOptions.clear();
    this.nativeMenu = null;
  }

  private setActiveMode(mode: LineupSortMode | null): void {
    if (this.activeMode === mode) {
      this.syncNativeSortUi();
      return;
    }
    this.cancelSortFrame();
    if (this.activeMode) this.restoreOriginalOrders();
    this.activeMode = mode;
    this.syncNativeSortUi();
    if (mode) {
      this.scheduleSort();
    } else {
      this.restoreOriginalOrders();
    }
  }

  private scheduleSort(): void {
    if (!this.activeMode || this.sortFrame !== undefined) return;
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
    if (!this.activeMode) return;
    const config = lineupSortConfigs[this.activeMode];
    const grid = sortableGrid(config.valueAttribute);
    if (!grid) {
      this.restoreOriginalOrders();
      return;
    }

    const cells: SortableCell[] = Array.from(grid.children).flatMap(
      (child, originalIndex) =>
        child instanceof HTMLElement && child.querySelector(cardImageSelector)
          ? [
              {
                cell: child,
                originalIndex,
                value: valueForCell(child, config.valueAttribute),
              },
            ]
          : [],
    );
    if (cells.length < 2) {
      this.restoreOriginalOrders();
      return;
    }

    for (const { cell } of cells) {
      if (!this.originalOrders.has(cell)) {
        this.originalOrders.set(cell, {
          value: cell.style.getPropertyValue('order'),
          priority: cell.style.getPropertyPriority('order'),
        });
      }
    }

    cells.sort((left, right) => {
      if (left.value === null && right.value === null) {
        return left.originalIndex - right.originalIndex;
      }
      if (left.value === null) return 1;
      if (right.value === null) return -1;
      return right.value - left.value || left.originalIndex - right.originalIndex;
    });
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
