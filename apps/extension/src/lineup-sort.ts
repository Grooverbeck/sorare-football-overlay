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
export const lineupSortDataReadyAttribute =
  'data-sorare-overlay-sort-data-ready';
export const lineupSortValueChangedEvent =
  'sorare-overlay:lineup-sort-value-changed';
export const lineupPoolReadyEvent =
  'sorare-overlay:lineup-pool-ready';

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
const nativeTriggerLoadingAttribute =
  'data-sorare-overlay-lineup-sort-loading';
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
  revealGridEnd?: (grid: HTMLElement) => Promise<boolean>;
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
  return (
    /\/compose-team(?:\/|$)/i.test(pathname) ||
    /\/series\/squad\/compose(?:\/|$)/i.test(pathname)
  );
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

export function setLineupSortDataReady(
  container: HTMLElement,
  ready: boolean | null,
): void {
  const nextValue = ready === null ? null : String(ready);
  if (container.getAttribute(lineupSortDataReadyAttribute) === nextValue) {
    return;
  }
  if (nextValue === null) {
    container.removeAttribute(lineupSortDataReadyAttribute);
  } else {
    container.setAttribute(lineupSortDataReadyAttribute, nextValue);
  }
  container.dispatchEvent(
    new CustomEvent(lineupSortValueChangedEvent, { bubbles: true }),
  );
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

function isNativeFilterButton(button: HTMLButtonElement): boolean {
  const toolbar = button.parentElement;
  return Boolean(
    button.matches('button[aria-haspopup="dialog"]') &&
      button.querySelector('svg[data-icon="iconFilter"]') &&
      toolbar?.querySelector('input[type="search"]') &&
      toolbar.querySelector(
        'svg[data-icon="iconChevronDown"], svg[data-icon="iconChevronUp"]',
      ),
  );
}

function nativeFilterButton(): HTMLButtonElement | null {
  return (
    Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        'button[aria-haspopup="dialog"]',
      ),
    ).find(isNativeFilterButton) ?? null
  );
}

function nativeFilterIsOpen(): boolean {
  const trigger = nativeFilterButton();
  if (!trigger) return false;
  if (trigger.getAttribute('aria-expanded') === 'true') return true;
  const controls = trigger.getAttribute('aria-controls');
  if (!controls) return false;
  const dialog = document.getElementById(controls);
  return Boolean(
    dialog?.getAttribute('role') === 'dialog' &&
      dialog.getAttribute('data-state') !== 'closed' &&
      dialog.getAttribute('aria-hidden') !== 'true',
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

function dismissNativeSortDialog(): void {
  const trigger = nativeSortButton();
  if (!trigger || !nativeSortDialog(trigger)) return;

  // Radix listens for Escape on the document and can dismiss the current
  // popover even when React replaces its trigger while we update the label.
  document.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true,
    }),
  );

  // Keep a delayed click fallback for Sorare variants that do not expose the
  // Radix escape listener. Resolve the trigger again so React replacements do
  // not leave us holding a disconnected element.
  window.setTimeout(() => {
    const currentTrigger = nativeSortButton();
    if (
      currentTrigger?.isConnected &&
      currentTrigger.getAttribute('aria-expanded') === 'true' &&
      nativeSortDialog(currentTrigger)
    ) {
      currentTrigger.click();
    }
  }, 80);
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

function cellSortDataIsReady(cell: HTMLElement): boolean {
  const states = Array.from(
    cell.querySelectorAll<HTMLElement>(`[${lineupSortDataReadyAttribute}]`),
  );
  return (
    states.length > 0 &&
    states.every(
      (container) =>
        container.getAttribute(lineupSortDataReadyAttribute) === 'true',
    )
  );
}

function gridLoadingCell(grid: HTMLElement): HTMLElement | null {
  return (
    Array.from(grid.children).find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement &&
        !child.querySelector(cardImageSelector) &&
        Boolean(
          child.querySelector(
            '[role="progressbar"][aria-busy="true"]',
          ),
        ),
    ) ?? null
  );
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

interface InlineStyleValue {
  property: string;
  value: string;
  priority: string;
}

function preserveInlineStyles(
  element: HTMLElement,
  properties: readonly string[],
): InlineStyleValue[] {
  return properties.map((property) => ({
    property,
    value: element.style.getPropertyValue(property),
    priority: element.style.getPropertyPriority(property),
  }));
}

function restoreInlineStyles(
  element: HTMLElement,
  values: readonly InlineStyleValue[],
): void {
  for (const { property, value, priority } of values) {
    if (value) {
      element.style.setProperty(property, value, priority);
    } else {
      element.style.removeProperty(property);
    }
  }
}

async function revealGridEndSilently(grid: HTMLElement): Promise<boolean> {
  const loadingCell = gridLoadingCell(grid);
  const trigger = loadingCell ?? gridCardCells(grid).at(-1);
  if (!trigger?.isConnected) {
    await animationFrames(2);
    return false;
  }

  const rectangle = trigger.getBoundingClientRect();
  if (rectangle.width <= 0 || rectangle.height <= 0) {
    await animationFrames(2);
    return false;
  }

  const isAlreadyVisible =
    rectangle.bottom > 0 &&
    rectangle.top < window.innerHeight &&
    rectangle.right > 0 &&
    rectangle.left < window.innerWidth;
  if (isAlreadyVisible) {
    window.dispatchEvent(new Event('scroll'));
    document.dispatchEvent(new Event('scroll'));
    await animationFrames(8);
    return true;
  }

  const overriddenProperties = [
    'position',
    'top',
    'right',
    'bottom',
    'left',
    'width',
    'height',
    'opacity',
    'pointer-events',
    'transform',
    'z-index',
  ] as const;
  const originalStyles = preserveInlineStyles(
    trigger,
    overriddenProperties,
  );
  const originalGridMinHeight = preserveInlineStyles(grid, ['min-height']);
  const triggerHadStyleAttribute = trigger.hasAttribute('style');
  const gridHadStyleAttribute = grid.hasAttribute('style');
  const gridRectangle = grid.getBoundingClientRect();
  const viewportLeft = Math.max(
    0,
    Math.min(
      Math.max(0, window.innerWidth - rectangle.width),
      gridRectangle.left,
    ),
  );
  try {
    grid.style.setProperty(
      'min-height',
      `${gridRectangle.height}px`,
      'important',
    );
    trigger.style.setProperty('position', 'fixed', 'important');
    trigger.style.setProperty('top', '0', 'important');
    trigger.style.setProperty('right', 'auto', 'important');
    trigger.style.setProperty('bottom', 'auto', 'important');
    trigger.style.setProperty('left', `${viewportLeft}px`, 'important');
    trigger.style.setProperty('width', `${rectangle.width}px`, 'important');
    trigger.style.setProperty('height', `${rectangle.height}px`, 'important');
    trigger.style.setProperty('opacity', '0', 'important');
    trigger.style.setProperty('pointer-events', 'none', 'important');
    trigger.style.setProperty('transform', 'none', 'important');
    trigger.style.setProperty('z-index', '-2147483647', 'important');
    window.dispatchEvent(new Event('scroll'));
    document.dispatchEvent(new Event('scroll'));
    await animationFrames(8);
  } finally {
    restoreInlineStyles(trigger, originalStyles);
    restoreInlineStyles(grid, originalGridMinHeight);
    if (!triggerHadStyleAttribute && trigger.getAttribute('style') === '') {
      trigger.removeAttribute('style');
    }
    if (!gridHadStyleAttribute && grid.getAttribute('style') === '') {
      grid.removeAttribute('style');
    }
  }
  // Reaching either Sorare's loading cell or the current final card proves
  // that the end-of-grid probe ran. A loading cell that is still present after
  // the stability wait is rejected separately by loadCompleteLineupPool.
  return true;
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
  const revealEnd = options.revealGridEnd ?? revealGridEndSilently;
  const waitForGrowth = options.waitForGrowth ?? waitForGridGrowth;
  const maxPulses = options.maxPulses ?? 32;
  const stableMissesRequired = options.stableMissesRequired ?? 2;
  let stableMisses = 0;
  let observedGrowth = false;

  for (let pulse = 0; pulse < maxPulses; pulse += 1) {
    if (context.isCancelled()) return null;
    const grid = getGrid();
    if (!grid) {
      await delay(100);
      continue;
    }
    const previousCount = gridCardCount(grid);
    context.onProgress(previousCount);
    const endWasRevealed = await revealEnd(grid);
    if (context.isCancelled()) return null;
    const grew = await waitForGrowth(
      grid,
      previousCount,
      context.isCancelled,
    );
    if (context.isCancelled()) return null;
    const currentGrid = getGrid();
    if (currentGrid && gridCardCount(currentGrid) > previousCount) {
      observedGrowth = true;
    }
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
      if (currentGrid && gridLoadingCell(currentGrid)) return null;
      if (!observedGrowth && !endWasRevealed) return null;
      context.onProgress(previousCount);
      return grid;
    }
  }

  return null;
}

export class LineupCardSorter {
  private root: HTMLElement | null = null;
  private supportedPathActive = false;
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
  private poolHydrating = false;
  private poolReadyCount = 0;
  private completedGrid: HTMLElement | null = null;
  private completedCells = new Set<HTMLElement>();
  private failedGrid: HTMLElement | null = null;
  private failedCells = new Set<HTMLElement>();
  private requestedPosition: FootballPosition | null | undefined;
  private filterSuspended = false;
  private readonly originalOrders = new Map<HTMLElement, OriginalOrder>();

  constructor(
    private readonly poolLoader: LineupPoolLoader = loadCompleteLineupPool,
  ) {}

  private readonly handleSortValueChange = (): void => {
    if (!this.activeMode || this.poolLoading || this.filterSuspended) return;
    this.refreshHydrationProgress();
    this.syncNativeSortUi();
    this.scheduleSort();
  };

  private readonly handleDocumentClick = (event: Event): void => {
    if (!this.activeMode || !(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>('button');
    if (button && isNativeFilterButton(button)) {
      window.setTimeout(() => this.scan(document), 0);
      return;
    }
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
    this.deactivateWithoutNativeSync();
    this.removeMenuOptions();
    this.restoreNativeTrigger();
    this.supportedPathActive = false;
    this.root = null;
  }

  scan(_root: ParentNode): void {
    if (!supportsLineupSortPath(window.location.pathname)) {
      if (this.supportedPathActive) {
        this.deactivateWithoutNativeSync();
        this.removeMenuOptions();
        this.restoreNativeTrigger();
        this.supportedPathActive = false;
      }
      return;
    }
    this.supportedPathActive = true;
    this.syncNativeSortUi();
    if (!this.activeMode) return;
    if (nativeFilterIsOpen()) {
      if (!this.filterSuspended) {
        this.filterSuspended = true;
        this.cancelSortFrame();
        this.cancelPoolLoad();
        this.restoreOriginalOrders();
        this.syncNativeSortUi();
      }
      return;
    }
    if (this.filterSuspended) {
      this.filterSuspended = false;
      this.restartCompleteSort(120);
      return;
    }
    if (this.poolLoading) return;
    const grid = lineupPlayerGrid();
    if (!grid) return;
    const cells = gridCardCells(grid);
    const sameCompletedPool =
      grid === this.completedGrid &&
      cells.length === this.completedCells.size &&
      cells.every((cell) => this.completedCells.has(cell));
    const sameFailedPool =
      this.poolLoadFailed &&
      grid === this.failedGrid &&
      cells.length === this.failedCells.size &&
      cells.every((cell) => this.failedCells.has(cell));
    if (sameFailedPool) return;
    if (!sameCompletedPool) {
      this.restartCompleteSort(80);
      return;
    }
    this.refreshHydrationProgress();
    this.syncNativeSortUi();
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
    this.mountMenuOptions(dialog);
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
      const loading = this.poolLoading || this.poolHydrating;
      label.toggleAttribute(nativeTriggerLoadingAttribute, loading);
      const nextLabel = this.poolLoading
        ? `${baseLabel} · Spieler laden${this.poolCardCount > 0 ? ` (${this.poolCardCount})` : ''}`
        : this.poolHydrating
          ? `${baseLabel} · Werte laden (${this.poolReadyCount}/${this.poolCardCount})`
          : this.poolLoadFailed
            ? `${baseLabel} · Erneut versuchen`
            : baseLabel;
      if (label.textContent !== nextLabel) label.textContent = nextLabel;
    } else if (label.hasAttribute(nativeTriggerLabelAttribute)) {
      label.textContent = this.originalTriggerLabel;
      label.removeAttribute(nativeTriggerLabelAttribute);
      label.removeAttribute(nativeTriggerLoadingAttribute);
    } else {
      this.originalTriggerLabel = label.textContent?.trim() ?? '';
    }
  }

  private restoreNativeTrigger(): void {
    if (this.nativeTriggerLabel?.hasAttribute(nativeTriggerLabelAttribute)) {
      this.nativeTriggerLabel.textContent = this.originalTriggerLabel;
      this.nativeTriggerLabel.removeAttribute(nativeTriggerLabelAttribute);
      this.nativeTriggerLabel.removeAttribute(nativeTriggerLoadingAttribute);
    }
    this.nativeTrigger = null;
    this.nativeTriggerLabel = null;
    this.originalTriggerLabel = '';
  }

  private mountMenuOptions(dialog: HTMLElement): void {
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
        window.setTimeout(dismissNativeSortDialog, 0);
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

  private reusableCompletedGrid(): HTMLElement | null {
    const grid = this.completedGrid;
    if (!grid?.isConnected) return null;
    const cells = gridCardCells(grid);
    if (
      cells.length !== this.completedCells.size ||
      cells.some((cell) => !this.completedCells.has(cell)) ||
      !gridMatchesPosition(grid, activeLineupPosition())
    ) {
      return null;
    }
    return grid;
  }

  private deactivateWithoutNativeSync(): void {
    this.cancelSortFrame();
    if (this.activeMode) this.restoreOriginalOrders();
    this.cancelPoolLoad();
    this.activeMode = null;
    this.filterSuspended = false;
    this.requestedPosition = undefined;
  }

  private setActiveMode(mode: LineupSortMode | null): void {
    const reusableGrid = mode ? this.reusableCompletedGrid() : null;
    if (this.activeMode === mode) {
      if (reusableGrid) this.refreshHydrationProgress();
      this.syncNativeSortUi();
      if (mode) {
        if (reusableGrid) this.scheduleSort();
        else this.restartCompleteSort();
      }
      return;
    }
    this.cancelSortFrame();
    if (this.activeMode) this.restoreOriginalOrders();
    this.cancelPoolLoad();
    this.activeMode = mode;
    this.filterSuspended = false;
    this.requestedPosition = mode ? activeLineupPosition() : undefined;
    if (mode && reusableGrid) {
      this.completedGrid = reusableGrid;
      this.completedCells = new Set(gridCardCells(reusableGrid));
      this.refreshHydrationProgress();
      this.syncNativeSortUi();
      this.scheduleSort();
    } else if (mode) {
      this.syncNativeSortUi();
      this.restartCompleteSort();
    } else {
      this.syncNativeSortUi();
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
    this.poolHydrating = false;
    this.poolReadyCount = 0;
    this.completedGrid = null;
    this.completedCells.clear();
    this.failedGrid = null;
    this.failedCells.clear();
  }

  private rememberFailedPool(grid = lineupPlayerGrid()): void {
    this.poolLoadFailed = true;
    this.poolHydrating = false;
    this.poolReadyCount = 0;
    this.failedGrid = grid;
    this.failedCells = new Set(grid ? gridCardCells(grid) : []);
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
      this.rememberFailedPool();
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
      this.rememberFailedPool(grid);
      this.restoreOriginalOrders();
      this.syncNativeSortUi();
      return;
    }

    this.poolLoadFailed = false;
    this.completedGrid = grid;
    this.completedCells = new Set(gridCardCells(grid));
    this.poolCardCount = this.completedCells.size;
    grid.dispatchEvent(
      new CustomEvent(lineupPoolReadyEvent, { bubbles: true }),
    );
    this.refreshHydrationProgress();
    this.syncNativeSortUi();
    this.scheduleSort();
  }

  private refreshHydrationProgress(): void {
    const grid = this.completedGrid;
    if (!grid?.isConnected) {
      this.poolHydrating = false;
      this.poolReadyCount = 0;
      return;
    }
    const cells = gridCardCells(grid);
    this.poolCardCount = cells.length;
    this.poolReadyCount = cells.filter(cellSortDataIsReady).length;
    this.poolHydrating =
      this.poolCardCount > 0 && this.poolReadyCount < this.poolCardCount;
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
      this.rememberFailedPool(grid);
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
