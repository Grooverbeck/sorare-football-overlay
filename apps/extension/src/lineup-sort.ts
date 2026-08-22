import type { FootballPosition } from '@sorare-overlay/shared';

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
export const lineupSortPositionAttribute =
  'data-sorare-overlay-sort-position';
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

export interface LineupPoolLoadContext {
  isCancelled: () => boolean;
  onProgress: (cardCount: number) => void;
}

export type LineupPoolLoader = (
  context: LineupPoolLoadContext,
) => Promise<HTMLElement | null>;

interface LineupPoolLoadOptions {
  getGrid?: () => HTMLElement | null;
  pulseGridEnd?: (grid: HTMLElement) => Promise<void>;
  waitForGrowth?: (
    grid: HTMLElement,
    previousCount: number,
    isCancelled: () => boolean,
  ) => Promise<boolean>;
  maxPulses?: number;
  stableMissesRequired?: number;
}

const lineupPositionAliases: Readonly<
  Record<string, FootballPosition | null>
> = {
  gk: 'Goalkeeper',
  tw: 'Goalkeeper',
  def: 'Defender',
  df: 'Defender',
  ver: 'Defender',
  mid: 'Midfielder',
  mf: 'Midfielder',
  fwd: 'Forward',
  fw: 'Forward',
  st: 'Forward',
  ex: null,
  extra: null,
};

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

export function setLineupSortPosition(
  container: HTMLElement,
  position: FootballPosition | null,
): void {
  if (position) {
    container.setAttribute(lineupSortPositionAttribute, position);
  } else {
    container.removeAttribute(lineupSortPositionAttribute);
  }
}

function lineupPositionFromButton(
  button: HTMLButtonElement | null,
): FootballPosition | null | undefined {
  if (!button || button.closest('[role="dialog"]')) return undefined;
  const marker = button.textContent?.trim().toLocaleLowerCase() ?? '';
  if (!(marker in lineupPositionAliases)) return undefined;
  return lineupPositionAliases[marker];
}

function activeLineupPosition(): FootballPosition | null | undefined {
  const positions = new Set<FootballPosition | null>();
  for (const button of document.querySelectorAll<HTMLButtonElement>('button')) {
    const position = lineupPositionFromButton(button);
    if (position === undefined) continue;
    const active =
      button.getAttribute('aria-pressed') === 'true' ||
      button.dataset.state === 'active' ||
      button.classList.contains('active') ||
      button.classList.contains('highlighted');
    if (active) positions.add(position);
  }
  return positions.size === 1 ? [...positions][0] : undefined;
}

function isNativeSortButton(button: HTMLButtonElement): boolean {
  const toolbar = button.parentElement;
  return Boolean(
    button.matches('button[aria-haspopup="dialog"]') &&
      button.querySelector(
        'svg[data-icon="iconChevronDown"], svg[data-icon="iconChevronUp"]',
      ) &&
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

function gridCardCells(grid: HTMLElement): HTMLElement[] {
  return Array.from(grid.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && Boolean(child.querySelector(cardImageSelector)),
  );
}

function gridCardCount(grid: HTMLElement): number {
  return gridCardCells(grid).length;
}

function lineupPlayerGrid(): HTMLElement | null {
  const trackedByGrid = new Map<HTMLElement, Set<HTMLElement>>();
  for (const image of document.querySelectorAll<HTMLImageElement>(
    cardImageSelector,
  )) {
    const cell = directGridCell(image);
    const grid = cell?.parentElement;
    if (!cell || !grid) continue;
    const cells = trackedByGrid.get(grid) ?? new Set<HTMLElement>();
    cells.add(cell);
    trackedByGrid.set(grid, cells);
  }

  return (
    [...trackedByGrid]
      .filter(([, cells]) => cells.size > 1)
      .sort(
        ([leftGrid, leftCells], [rightGrid, rightCells]) =>
          rightCells.size - leftCells.size ||
          rightGrid.querySelectorAll(cardImageSelector).length -
            leftGrid.querySelectorAll(cardImageSelector).length,
      )[0]?.[0] ?? null
  );
}

function cellPosition(cell: HTMLElement): FootballPosition | undefined {
  const positions = new Set(
    Array.from(
      cell.querySelectorAll<HTMLElement>(`[${lineupSortPositionAttribute}]`),
    )
      .map((container) =>
        container.getAttribute(lineupSortPositionAttribute),
      )
      .filter(
        (position): position is FootballPosition =>
          position === 'Goalkeeper' ||
          position === 'Defender' ||
          position === 'Midfielder' ||
          position === 'Forward',
      ),
  );
  return positions.size === 1 ? [...positions][0] : undefined;
}

function gridMatchesPosition(
  grid: HTMLElement,
  position: FootballPosition | null | undefined,
): boolean {
  if (!position) return true;
  return gridCardCells(grid).every((cell) => {
    const concretePosition = cellPosition(cell);
    return !concretePosition || concretePosition === position;
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function animationFrames(count: number): Promise<void> {
  for (let frame = 0; frame < count; frame += 1) {
    await new Promise<void>((resolve) => {
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => resolve());
      } else {
        window.setTimeout(resolve, 16);
      }
    });
  }
}

async function pulseGridEnd(grid: HTMLElement): Promise<void> {
  const scrollingElement = document.scrollingElement;
  if (!scrollingElement) return;
  const savedX = window.scrollX;
  const savedY = window.scrollY;
  const gridBottom = savedY + grid.getBoundingClientRect().bottom;
  const maximumY = Math.max(0, scrollingElement.scrollHeight - window.innerHeight);
  const targetY = Math.min(maximumY, Math.max(savedY, gridBottom - window.innerHeight + 48));
  if (targetY <= savedY) {
    await animationFrames(2);
    return;
  }

  const root = document.documentElement;
  const previousBehavior = root.style.getPropertyValue('scroll-behavior');
  const previousPriority = root.style.getPropertyPriority('scroll-behavior');
  root.style.setProperty('scroll-behavior', 'auto', 'important');
  try {
    window.scrollTo(savedX, targetY);
    await animationFrames(5);
  } finally {
    window.scrollTo(savedX, savedY);
    if (previousBehavior) {
      root.style.setProperty(
        'scroll-behavior',
        previousBehavior,
        previousPriority,
      );
    } else {
      root.style.removeProperty('scroll-behavior');
    }
  }
}

async function waitForGridGrowth(
  grid: HTMLElement,
  previousCount: number,
  isCancelled: () => boolean,
): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await delay(90);
    if (isCancelled()) return false;
    const currentGrid = lineupPlayerGrid();
    if (currentGrid && currentGrid !== grid) return true;
    if (currentGrid && gridCardCount(currentGrid) > previousCount) return true;
  }
  return false;
}

export async function loadCompleteLineupPool(
  context: LineupPoolLoadContext,
  options: LineupPoolLoadOptions = {},
): Promise<HTMLElement | null> {
  const getGrid = options.getGrid ?? lineupPlayerGrid;
  const revealEnd = options.pulseGridEnd ?? pulseGridEnd;
  const waitForGrowth = options.waitForGrowth ?? waitForGridGrowth;
  const maxPulses = options.maxPulses ?? 32;
  const stableMissesRequired = options.stableMissesRequired ?? 2;
  let stableMisses = 0;

  for (let pulse = 0; pulse < maxPulses; pulse += 1) {
    if (context.isCancelled()) return null;
    const grid = getGrid();
    if (!grid) {
      await delay(100);
      continue;
    }
    const previousCount = gridCardCount(grid);
    context.onProgress(previousCount);
    await revealEnd(grid);
    if (context.isCancelled()) return null;
    const grew = await waitForGrowth(
      grid,
      previousCount,
      context.isCancelled,
    );
    if (context.isCancelled()) return null;
    const currentGrid = getGrid();
    if (
      grew ||
      (currentGrid && currentGrid !== grid) ||
      (currentGrid && gridCardCount(currentGrid) > previousCount)
    ) {
      stableMisses = 0;
      continue;
    }
    stableMisses += 1;
    if (stableMisses >= stableMissesRequired) {
      context.onProgress(previousCount);
      return grid;
    }
  }

  return null;
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
  private poolStartTimer: number | undefined;
  private poolGeneration = 0;
  private poolLoading = false;
  private poolLoadFailed = false;
  private poolCardCount = 0;
  private completedGrid: HTMLElement | null = null;
  private completedCells = new Set<HTMLElement>();
  private requestedPosition: FootballPosition | null | undefined;
  private readonly originalOrders = new Map<HTMLElement, OriginalOrder>();

  constructor(
    private readonly poolLoader: LineupPoolLoader = loadCompleteLineupPool,
  ) {}

  private readonly handleSortValueChange = (): void => {
    if (this.activeMode && !this.poolLoading) this.scheduleSort();
  };

  private readonly handleDocumentClick = (event: Event): void => {
    if (!this.activeMode || !(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>('button');
    const requestedPosition = lineupPositionFromButton(button);
    if (requestedPosition !== undefined) {
      this.requestedPosition = requestedPosition;
      this.restartCompleteSort(120);
      return;
    }
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
    this.cancelPoolLoad();
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
    if (!this.activeMode || this.poolLoading) return;
    const grid = lineupPlayerGrid();
    if (!grid) return;
    const cells = gridCardCells(grid);
    const sameCompletedPool =
      grid === this.completedGrid &&
      cells.length === this.completedCells.size &&
      cells.every((cell) => this.completedCells.has(cell));
    if (!sameCompletedPool) {
      this.restartCompleteSort(80);
      return;
    }
    this.scheduleSort();
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
      const baseLabel = lineupSortConfigs[this.activeMode].label;
      label.textContent = this.poolLoading
        ? `${baseLabel} lädt${this.poolCardCount > 0 ? ` ${this.poolCardCount}` : ''}…`
        : this.poolLoadFailed
          ? `${baseLabel} erneut`
          : baseLabel;
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
      if (mode) this.restartCompleteSort();
      return;
    }
    this.cancelSortFrame();
    if (this.activeMode) this.restoreOriginalOrders();
    this.cancelPoolLoad();
    this.activeMode = mode;
    this.requestedPosition = mode ? activeLineupPosition() : undefined;
    this.syncNativeSortUi();
    if (mode) {
      this.restartCompleteSort();
    } else {
      this.restoreOriginalOrders();
    }
  }

  private cancelPoolLoad(): void {
    this.poolGeneration += 1;
    if (this.poolStartTimer !== undefined) {
      window.clearTimeout(this.poolStartTimer);
      this.poolStartTimer = undefined;
    }
    this.poolLoading = false;
    this.poolCardCount = 0;
    this.completedGrid = null;
    this.completedCells.clear();
  }

  private restartCompleteSort(delayMs = 0): void {
    if (!this.activeMode) return;
    this.cancelSortFrame();
    this.restoreOriginalOrders();
    this.cancelPoolLoad();
    this.poolLoading = true;
    this.poolLoadFailed = false;
    const generation = this.poolGeneration;
    this.syncNativeSortUi();
    this.poolStartTimer = window.setTimeout(() => {
      this.poolStartTimer = undefined;
      void this.completePoolAndSort(generation);
    }, delayMs);
  }

  private async completePoolAndSort(generation: number): Promise<void> {
    const isCancelled = (): boolean =>
      generation !== this.poolGeneration || !this.activeMode;
    const grid = await this.poolLoader({
      isCancelled,
      onProgress: (cardCount) => {
        if (isCancelled()) return;
        this.poolCardCount = cardCount;
        this.syncNativeSortUi();
      },
    });
    if (isCancelled()) return;
    this.poolLoading = false;
    if (!grid) {
      this.poolLoadFailed = true;
      this.syncNativeSortUi();
      return;
    }

    const activePosition = activeLineupPosition();
    if (
      this.requestedPosition !== undefined &&
      activePosition !== undefined &&
      this.requestedPosition !== activePosition
    ) {
      this.requestedPosition = activePosition;
      this.restartCompleteSort(120);
      return;
    }
    const expectedPosition = this.requestedPosition ?? activePosition;
    if (!gridMatchesPosition(grid, expectedPosition)) {
      this.poolLoadFailed = true;
      this.restoreOriginalOrders();
      this.syncNativeSortUi();
      return;
    }

    this.poolLoadFailed = false;
    this.completedGrid = grid;
    this.completedCells = new Set(gridCardCells(grid));
    this.syncNativeSortUi();
    this.scheduleSort();
  }

  private scheduleSort(): void {
    if (
      !this.activeMode ||
      this.poolLoading ||
      !this.completedGrid ||
      this.sortFrame !== undefined
    ) {
      return;
    }
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
    const grid = this.completedGrid;
    if (!grid?.isConnected) {
      this.restoreOriginalOrders();
      this.restartCompleteSort(80);
      return;
    }

    const currentCells = gridCardCells(grid);
    if (
      currentCells.length !== this.completedCells.size ||
      currentCells.some((cell) => !this.completedCells.has(cell))
    ) {
      this.restartCompleteSort(80);
      return;
    }
    const expectedPosition = this.requestedPosition ?? activeLineupPosition();
    if (!gridMatchesPosition(grid, expectedPosition)) {
      this.restoreOriginalOrders();
      this.poolLoadFailed = true;
      this.syncNativeSortUi();
      return;
    }

    const cells: SortableCell[] = currentCells.map((cell, originalIndex) => ({
      cell,
      originalIndex,
      value: valueForCell(cell, config.valueAttribute),
    }));
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
