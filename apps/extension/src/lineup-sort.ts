import type { FootballPosition } from '@sorare-overlay/shared';
import { logStatsDiagnostic } from './stats-diagnostics.js';

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
export const lineupCleanSheetSortOptionAttribute =
  'data-sorare-overlay-clean-sheet-sort-option';
export const lineupCleanSheetSortProbabilityAttribute =
  'data-sorare-overlay-clean-sheet-sort-probability';
export const lineupSortPositionAttribute =
  'data-sorare-overlay-sort-position';
export const lineupSortDataReadyAttribute =
  'data-sorare-overlay-sort-data-ready';
export const lineupSortLightweightReadyAttribute =
  'data-sorare-overlay-sort-lightweight-ready';
export const lineupSortFullDataRevisionAttribute =
  'data-sorare-overlay-sort-full-data-revision';
export const lineupSortHydrationGridAttribute =
  'data-sorare-overlay-lineup-sort-hydration';
export const lineupSortValueChangedEvent =
  'sorare-overlay:lineup-sort-value-changed';
export const lineupPoolReadyEvent =
  'sorare-overlay:lineup-pool-ready';
export const lineupPoolProgressEvent =
  'sorare-overlay:lineup-pool-progress';

export type LineupGoalSortSource = 'market' | 'historical';
export type LineupSortMode = 'goal' | 'aa' | 'clean-sheet';

interface LineupSortConfig {
  mode: LineupSortMode;
  label: string;
  description: string;
  title: string;
  loadingDescription: string;
  missingValueDescription: string;
  optionAttribute: string;
  valueAttribute: string;
  supportedPositions?: readonly FootballPosition[];
}

const lineupSortConfigs: Record<LineupSortMode, LineupSortConfig> = {
  goal: {
    mode: 'goal',
    label: 'Torquote',
    description: 'Markt & Historie gemeinsam',
    title:
      'Nach Torwahrscheinlichkeit sortieren – Marktquoten und historische Werte werden gemeinsam verglichen.',
    loadingDescription:
      'Torquoten und historische Vergleichswerte werden abgeglichen.',
    missingValueDescription:
      'Karten ohne verfügbare Torquote stehen am Ende.',
    optionAttribute: lineupGoalSortOptionAttribute,
    valueAttribute: lineupGoalSortProbabilityAttribute,
  },
  aa: {
    mode: 'aa',
    label: 'AA',
    description: 'L10 · mindestens 60 Minuten',
    title:
      'Nach dem durchschnittlichen All-Around Score der letzten zehn Spiele mit mindestens 60 Minuten sortieren.',
    loadingDescription: 'AA-Werte werden abgeglichen.',
    missingValueDescription:
      'Karten ohne verfügbaren AA-Wert stehen am Ende.',
    optionAttribute: lineupAaSortOptionAttribute,
    valueAttribute: lineupAaSortValueAttribute,
  },
  'clean-sheet': {
    mode: 'clean-sheet',
    label: 'Clean Sheet',
    description: 'Chance im nächsten Spiel',
    title:
      'Torhüter und Verteidiger nach der Clean-Sheet-Wahrscheinlichkeit ihres Teams im nächsten Spiel sortieren.',
    loadingDescription: 'Clean-Sheet-Wahrscheinlichkeiten werden abgeglichen.',
    missingValueDescription:
      'Spieler ohne verfügbare Clean-Sheet-Wahrscheinlichkeit stehen am Ende.',
    optionAttribute: lineupCleanSheetSortOptionAttribute,
    valueAttribute: lineupCleanSheetSortProbabilityAttribute,
    supportedPositions: ['Goalkeeper', 'Defender'],
  },
};

function lineupSortConfigSupportsPosition(
  config: LineupSortConfig,
  position: FootballPosition | null | undefined,
): boolean {
  return !config.supportedPositions ||
    (position !== null &&
      position !== undefined &&
      config.supportedPositions.includes(position));
}

function availableLineupSortConfigs(
  position: FootballPosition | null | undefined = activeLineupPosition(),
): LineupSortConfig[] {
  return Object.values(lineupSortConfigs).filter((config) =>
    lineupSortConfigSupportsPosition(config, position),
  );
}

const cardImageSelector =
  'img[src*="/cardsamplepicture/"], img[alt$=" - common" i], img[alt$=" - limited" i], img[alt$=" - rare" i], img[alt$=" - super rare" i], img[alt$=" - unique" i]';
const nativeTriggerLabelAttribute =
  'data-sorare-overlay-lineup-sort-trigger-label';
const nativeTriggerLoadingAttribute =
  'data-sorare-overlay-lineup-sort-loading';
const nativeTriggerPlayerStatusAttribute =
  'data-sorare-overlay-lineup-sort-player-status';
const nativeTriggerPlayerStatusLabelAttribute =
  'data-sorare-overlay-lineup-sort-player-status-label';
const nativeMenuActiveAttribute =
  'data-sorare-overlay-lineup-sort-active';
const nativeMenuOptionAttribute =
  'data-sorare-overlay-native-sort-option';
const hydrationUiSettleDelayMs = 600;
const gridGrowthWaitMs = 1_800;
const settledGridGrowthWaitMs = 300;
const defaultMaximumPoolPulses = 96;

interface OriginalOrder {
  value: string;
  priority: string;
}

interface SortableCellRecord {
  cell: HTMLElement;
  originalIndex: number;
  ready: boolean;
  values: Record<LineupSortMode, number | null>;
}

export interface LineupPoolLoadContext {
  isCancelled: () => boolean;
  onProgress: (cardCount: number) => void;
  onGridUpdate?: (grid: HTMLElement) => void;
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
    timeoutMs?: number,
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

export function activeLineupPosition(): FootballPosition | null | undefined {
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
  if (positions.size === 1) return [...positions][0];
  if (positions.size > 1) return undefined;
  return dominantLineupGridPosition();
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

function nativeSortButton(root: ParentNode = document): HTMLButtonElement | null {
  const direct =
    root instanceof HTMLButtonElement &&
    root.matches('button[aria-haspopup="dialog"]')
      ? [root]
      : [];
  return (
    [
      ...direct,
      ...Array.from(
        root.querySelectorAll<HTMLButtonElement>(
          'button[aria-haspopup="dialog"]',
        ),
      ),
    ].find(isNativeSortButton) ?? null
  );
}

export function setLineupCleanSheetSortValue(
  container: HTMLElement,
  probability: number | null,
): void {
  if (
    probability === null ||
    !Number.isFinite(probability) ||
    probability < 0 ||
    probability > 1
  ) {
    container.removeAttribute(lineupCleanSheetSortProbabilityAttribute);
  } else {
    container.setAttribute(
      lineupCleanSheetSortProbabilityAttribute,
      probability.toString(),
    );
  }
  container.dispatchEvent(
    new CustomEvent(lineupSortValueChangedEvent, { bubbles: true }),
  );
}

export function markLineupSortFullDataUpdated(container: HTMLElement): void {
  const currentRevision = Number.parseInt(
    container.getAttribute(lineupSortFullDataRevisionAttribute) ?? '0',
    10,
  );
  container.setAttribute(
    lineupSortFullDataRevisionAttribute,
    String(Number.isFinite(currentRevision) ? currentRevision + 1 : 1),
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
  const containers = [
    ...(cell.hasAttribute(valueAttribute) ? [cell] : []),
    ...cell.querySelectorAll<HTMLElement>(`[${valueAttribute}]`),
  ];
  const values = containers.flatMap((container) => {
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

function cardCellIdentity(cell: HTMLElement): string | null {
  const image = cell.querySelector<HTMLImageElement>(cardImageSelector);
  if (!image) return null;
  const playerLink =
    image.closest<HTMLAnchorElement>('a[href*="/football/players/"]') ??
    cell.querySelector<HTMLAnchorElement>('a[href*="/football/players/"]');
  const playerSlug = playerLink
    ?.getAttribute('href')
    ?.match(/\/football\/players\/([^/?#]+)/i)?.[1];
  if (playerSlug) return `slug:${playerSlug.toLocaleLowerCase()}`;
  const playerName = image
    .getAttribute('alt')
    ?.replace(/\s+-\s+(?:common|limited|rare|super rare|unique)\s*$/i, '')
    .trim()
    .toLocaleLowerCase();
  return playerName ? `name:${playerName}` : null;
}

function directGridChild(
  target: HTMLElement,
  grid: HTMLElement,
): HTMLElement | null {
  let candidate: HTMLElement | null = target;
  while (candidate?.parentElement && candidate.parentElement !== grid) {
    candidate = candidate.parentElement;
  }
  return candidate?.parentElement === grid ? candidate : null;
}

function gridCardCount(grid: HTMLElement): number {
  return gridCardCells(grid).length;
}

function cellSortDataIsReady(cell: HTMLElement): boolean {
  const states = [
    ...(cell.hasAttribute(lineupSortDataReadyAttribute) ? [cell] : []),
    ...cell.querySelectorAll<HTMLElement>(
      `[${lineupSortDataReadyAttribute}]`,
    ),
  ];
  return (
    states.length > 0 &&
    states.every(
      (container) =>
        container.getAttribute(lineupSortDataReadyAttribute) === 'true',
    )
  );
}

function sortableCellRecord(
  cell: HTMLElement,
  originalIndex: number,
): SortableCellRecord {
  return {
    cell,
    originalIndex,
    ready: cellSortDataIsReady(cell),
    values: {
      goal: valueForCell(
        cell,
        lineupSortConfigs.goal.valueAttribute,
      ),
      aa: valueForCell(cell, lineupSortConfigs.aa.valueAttribute),
      'clean-sheet': valueForCell(
        cell,
        lineupSortConfigs['clean-sheet'].valueAttribute,
      ),
    },
  };
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

function dominantLineupGridPosition(): FootballPosition | undefined {
  const grid = lineupPlayerGrid();
  if (!grid) return undefined;
  const positions = gridCardCells(grid).flatMap((cell) => {
    const position = cellPosition(cell);
    return position ? [position] : [];
  });
  if (positions.length === 0) return undefined;
  const counts = new Map<FootballPosition, number>();
  for (const position of positions) {
    counts.set(position, (counts.get(position) ?? 0) + 1);
  }
  const dominant = [...counts].sort((left, right) => right[1] - left[1])[0];
  return dominant && dominant[1] > positions.length / 2
    ? dominant[0]
    : undefined;
}

function gridMatchesPosition(
  grid: HTMLElement,
  position: FootballPosition | null | undefined,
): boolean {
  if (!position) return true;
  const concretePositions = gridCardCells(grid).flatMap((cell) => {
    const concretePosition = cellPosition(cell);
    return concretePosition ? [concretePosition] : [];
  });
  if (concretePositions.length === 0) return true;

  // Sorare selects by the card's playable position, while our stats contain
  // the player's current position. Those can legitimately differ after a
  // position change, so one conflicting player must not invalidate the pool.
  // A stale grid from the previously selected slot still has a conflicting
  // majority and is therefore rejected.
  const matchingPositions = concretePositions.filter(
    (concretePosition) => concretePosition === position,
  ).length;
  return matchingPositions > concretePositions.length / 2;
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

interface LineupPoolProbeScrollEvent extends Event {
  sorareOverlayPoolProbe?: boolean;
}

export function isLineupPoolProbeScrollEvent(event: Event): boolean {
  return (event as LineupPoolProbeScrollEvent).sorareOverlayPoolProbe === true;
}

function dispatchLineupPoolProbeScrollEvents(): void {
  const createEvent = (): LineupPoolProbeScrollEvent => {
    const event = new Event('scroll') as LineupPoolProbeScrollEvent;
    event.sorareOverlayPoolProbe = true;
    return event;
  };
  window.dispatchEvent(createEvent());
  document.dispatchEvent(createEvent());
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
  if (!loadingCell) {
    await animationFrames(2);
    return true;
  }
  const trigger = loadingCell;
  if (!trigger.isConnected) return false;

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
    dispatchLineupPoolProbeScrollEvents();
    await animationFrames(4);
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
    dispatchLineupPoolProbeScrollEvents();
    await animationFrames(4);
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
  timeoutMs = gridGrowthWaitMs,
): Promise<boolean> {
  if (
    isCancelled() ||
    !grid.isConnected ||
    gridCardCount(grid) > previousCount
  ) {
    return !isCancelled();
  }
  if (typeof MutationObserver === 'undefined') {
    const pollIntervalMs = Math.min(90, Math.max(16, timeoutMs));
    const attempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await delay(pollIntervalMs);
      if (isCancelled()) return false;
      if (!grid.isConnected || gridCardCount(grid) > previousCount) return true;
    }
    return false;
  }

  return new Promise((resolve) => {
    let settled = false;
    let observer: MutationObserver;
    let timeout: number;
    let cancellationTimer: number;
    const finish = (grew: boolean): void => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      window.clearTimeout(timeout);
      window.clearInterval(cancellationTimer);
      resolve(grew);
    };
    observer = new MutationObserver(() => {
      if (isCancelled()) {
        finish(false);
      } else if (!grid.isConnected || gridCardCount(grid) > previousCount) {
        finish(true);
      }
    });
    timeout = window.setTimeout(() => {
      finish(
        !isCancelled() &&
          (!grid.isConnected || gridCardCount(grid) > previousCount),
      );
    }, timeoutMs);
    cancellationTimer = window.setInterval(() => {
      if (isCancelled()) finish(false);
      else if (!grid.isConnected) finish(true);
    }, 90);
    observer.observe(grid, { childList: true });
  });
}

export async function loadCompleteLineupPool(
  context: LineupPoolLoadContext,
  options: LineupPoolLoadOptions = {},
): Promise<HTMLElement | null> {
  const getGrid = options.getGrid ?? lineupPlayerGrid;
  const revealEnd = options.revealGridEnd ?? revealGridEndSilently;
  const waitForGrowth = options.waitForGrowth ?? waitForGridGrowth;
  const maxPulses = options.maxPulses ?? defaultMaximumPoolPulses;
  const stableMissesRequired = options.stableMissesRequired ?? 2;
  let stableMisses = 0;
  let observedGrowth = false;
  let grid: HTMLElement | null = null;

  for (let pulse = 0; pulse < maxPulses; pulse += 1) {
    if (context.isCancelled()) return null;
    if (!grid?.isConnected) {
      grid = getGrid();
      if (grid) context.onGridUpdate?.(grid);
    }
    if (!grid) {
      await delay(100);
      continue;
    }
    const previousCount = gridCardCount(grid);
    context.onProgress(previousCount);
    const endWasRevealed = await revealEnd(grid);
    if (context.isCancelled()) return null;
    const growthWaitMs = gridLoadingCell(grid)
      ? gridGrowthWaitMs
      : settledGridGrowthWaitMs;
    const grew = await waitForGrowth(
      grid,
      previousCount,
      context.isCancelled,
      growthWaitMs,
    );
    if (context.isCancelled()) return null;
    if (!grid.isConnected) {
      grid = null;
      stableMisses = 0;
      continue;
    }
    const currentCount = gridCardCount(grid);
    if (currentCount > previousCount) {
      observedGrowth = true;
      context.onGridUpdate?.(grid);
    }
    if (grew || currentCount > previousCount) {
      stableMisses = 0;
      continue;
    }
    stableMisses += 1;
    if (stableMisses >= stableMissesRequired) {
      if (gridLoadingCell(grid)) return null;
      if (!observedGrowth && !endWasRevealed) return null;
      context.onProgress(currentCount);
      return grid;
    }
  }

  // A large pool can grow on every allowed probe and finish exactly on the
  // final one. In that case there is no stable follow-up probe left, even
  // though Sorare has already removed its loading cell. Treat that terminal
  // state as complete instead of leaving a fully hydrated pool on retry.
  if (grid?.isConnected && observedGrowth && !gridLoadingCell(grid)) {
    context.onProgress(gridCardCount(grid));
    return grid;
  }

  return null;
}

export class LineupCardSorter {
  private root: HTMLElement | null = null;
  private supportedPathActive = false;
  private nativeTrigger: HTMLButtonElement | null = null;
  private nativeTriggerLabel: HTMLElement | null = null;
  private originalTriggerLabel = '';
  private originalTriggerTitle: string | null = null;
  private nativeMenu: HTMLElement | null = null;
  private readonly menuOptions = new Map<
    LineupSortMode,
    HTMLButtonElement
  >();
  private readonly nativeRadioStates = new Map<HTMLInputElement, boolean>();
  private activeMode: LineupSortMode | null = null;
  private sortFrame: number | undefined;
  private sortRefreshPending = false;
  private poolStartTimer: number | undefined;
  private poolGeneration = 0;
  private poolLoading = false;
  private poolLoadFailed = false;
  private poolCardCount = 0;
  private displayedPoolCardCount = 0;
  private poolHydrating = false;
  private poolHydrationUiPending = false;
  private poolHydrationUiComplete = false;
  private poolHydrationUiTimer: number | undefined;
  private poolReadyCount = 0;
  private poolValueCount = 0;
  private loadingGrid: HTMLElement | null = null;
  private completedGrid: HTMLElement | null = null;
  private completedCells = new Set<HTMLElement>();
  private completedCellRecords: SortableCellRecord[] = [];
  private readonly completedCellRecordByCell = new Map<
    HTMLElement,
    SortableCellRecord
  >();
  private readonly sortedCellRecords = new Map<
    LineupSortMode,
    SortableCellRecord[]
  >();
  private readonly dirtyCompletedCells = new Set<HTMLElement>();
  private gridNeedsReconciliation = false;
  private failedGrid: HTMLElement | null = null;
  private failedCells = new Set<HTMLElement>();
  private hydrationGrid: HTMLElement | null = null;
  private gridObserver: MutationObserver | undefined;
  private gridReconcileTimer: number | undefined;
  private readonly pendingReplacementCells = new Set<HTMLElement>();
  private requestedPosition: FootballPosition | null | undefined;
  private menuPositionHint: FootballPosition | null | undefined;
  private filterSuspended = false;
  private readonly originalOrders = new Map<HTMLElement, OriginalOrder>();

  constructor(
    private readonly poolLoader: LineupPoolLoader = loadCompleteLineupPool,
  ) {}

  private readonly handleSortValueChange = (event: Event): void => {
    if (!this.activeMode || this.poolLoading || this.filterSuspended) return;
    if (event.target instanceof HTMLElement && this.completedGrid) {
      const cell = directGridChild(event.target, this.completedGrid);
      if (cell && this.completedCells.has(cell)) {
        this.dirtyCompletedCells.add(cell);
      }
    }
    this.sortRefreshPending = true;
    this.scheduleSort();
  };

  private readonly handleDocumentClick = (event: Event): void => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>('button');
    const requestedPosition = lineupPositionFromButton(button);
    if (requestedPosition !== undefined) {
      // Sorare updates the highlighted slot after the captured click. Keep the
      // clicked position as an authoritative short-lived hint so an option
      // from the previous slot cannot survive that transition.
      this.menuPositionHint = requestedPosition;
      if (!this.activeMode) {
        window.setTimeout(() => this.scan(document), 0);
        return;
      }
      if (
        !lineupSortConfigSupportsPosition(
          lineupSortConfigs[this.activeMode],
          requestedPosition,
        )
      ) {
        this.setActiveMode(null);
        window.setTimeout(() => this.scan(document), 0);
        return;
      }
      this.requestedPosition = requestedPosition;
      this.restartCompleteSort(120);
      return;
    }
    if (!this.activeMode) return;
    if (button && isNativeFilterButton(button)) {
      window.setTimeout(() => this.scan(document), 0);
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

  scan(root: ParentNode): void {
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
    if (
      this.menuPositionHint !== undefined &&
      activeLineupPosition() === this.menuPositionHint
    ) {
      this.menuPositionHint = undefined;
    }
    this.syncNativeSortUi(root);
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
    const grid = this.poolLoadFailed ? this.failedGrid : this.completedGrid;
    if (!grid) return;
    if (!grid.isConnected) {
      this.restartCompleteSort(80);
      return;
    }
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
      if (this.poolLoadFailed) this.restartCompleteSort(80);
      else this.scheduleGridReconciliation(grid);
      return;
    }
    this.refreshHydrationProgress();
    this.syncNativeSortUi();
    this.scheduleSort();
  }

  private syncNativeSortUi(searchRoot?: ParentNode): void {
    const scopedTrigger = searchRoot ? nativeSortButton(searchRoot) : null;
    const retainedTrigger =
      this.nativeTrigger?.isConnected && isNativeSortButton(this.nativeTrigger)
        ? this.nativeTrigger
        : null;
    const trigger = scopedTrigger ?? retainedTrigger ?? nativeSortButton();
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
      this.originalTriggerTitle = label.getAttribute('title');
    }
    if (this.activeMode) {
      if (!label.hasAttribute(nativeTriggerLabelAttribute)) {
        this.originalTriggerLabel = label.textContent?.trim() ?? '';
        this.originalTriggerTitle = label.getAttribute('title');
      }
      label.setAttribute(nativeTriggerLabelAttribute, 'true');
      const config = lineupSortConfigs[this.activeMode];
      const baseLabel = config.label;
      const loading = this.poolLoading || this.poolHydrationUiPending;
      const displayedPlayerCount = this.displayedPoolCardCount;
      const loadingPlayerDescription =
        displayedPlayerCount > 0
          ? `${displayedPlayerCount} Spieler bisher geladen. `
          : '';
      const totalPlayerDescription =
        displayedPlayerCount > 0
          ? `${displayedPlayerCount} Spieler insgesamt. `
          : '';
      label.toggleAttribute(nativeTriggerLoadingAttribute, loading);
      this.syncNativeTriggerPlayerStatus(
        trigger,
        this.poolLoadFailed
          ? displayedPlayerCount > 0
            ? `${displayedPlayerCount} Spieler · unvollständig`
            : 'Spielerliste unvollständig'
          : displayedPlayerCount > 0
            ? `${displayedPlayerCount} Spieler ${loading ? 'geladen' : 'sortiert'}`
            : null,
      );
      const nextLabel = loading
        ? `${baseLabel} lädt …`
        : this.poolLoadFailed
          ? `${baseLabel} · Wiederholen`
          : baseLabel;
      const nextTitle = this.poolLoading
        ? `${loadingPlayerDescription}Die vollständige Spielerliste wird geladen. Danach wird automatisch sortiert.`
        : this.poolHydrationUiPending
          ? `${totalPlayerDescription}${config.loadingDescription} Die Sortierung aktualisiert sich automatisch.`
          : this.poolLoadFailed
            ? `${loadingPlayerDescription}Die Spielerliste konnte nicht vollständig geladen werden. Öffne das Sortiermenü und wähle „${baseLabel}“ erneut.`
            : this.poolCardCount > 0 &&
                this.poolValueCount < this.poolCardCount
              ? `${totalPlayerDescription}Nach ${baseLabel} sortiert. ${config.missingValueDescription}`
              : `${totalPlayerDescription}Nach ${baseLabel} sortiert.`;
      if (label.textContent !== nextLabel) label.textContent = nextLabel;
      if (label.title !== nextTitle) label.title = nextTitle;
    } else if (label.hasAttribute(nativeTriggerLabelAttribute)) {
      label.textContent = this.originalTriggerLabel;
      if (this.originalTriggerTitle === null) {
        label.removeAttribute('title');
      } else {
        label.setAttribute('title', this.originalTriggerTitle);
      }
      label.removeAttribute(nativeTriggerLabelAttribute);
      label.removeAttribute(nativeTriggerLoadingAttribute);
      this.syncNativeTriggerPlayerStatus(trigger, null);
    } else {
      this.originalTriggerLabel = label.textContent?.trim() ?? '';
      this.originalTriggerTitle = label.getAttribute('title');
    }
  }

  private syncNativeTriggerPlayerStatus(
    trigger: HTMLButtonElement,
    text: string | null,
  ): void {
    let status = trigger.querySelector<HTMLSpanElement>(
      `:scope > [${nativeTriggerPlayerStatusLabelAttribute}]`,
    );
    if (!text) {
      status?.remove();
      trigger.removeAttribute(nativeTriggerPlayerStatusAttribute);
      return;
    }
    if (!status) {
      status = document.createElement('span');
      status.setAttribute(nativeTriggerPlayerStatusLabelAttribute, 'true');
      status.setAttribute('aria-hidden', 'true');
      trigger.append(status);
    }
    if (status.textContent !== text) status.textContent = text;
    trigger.setAttribute(nativeTriggerPlayerStatusAttribute, 'true');
  }

  private restoreNativeTrigger(): void {
    if (this.nativeTrigger) {
      this.syncNativeTriggerPlayerStatus(this.nativeTrigger, null);
    }
    if (this.nativeTriggerLabel?.hasAttribute(nativeTriggerLabelAttribute)) {
      this.nativeTriggerLabel.textContent = this.originalTriggerLabel;
      if (this.originalTriggerTitle === null) {
        this.nativeTriggerLabel.removeAttribute('title');
      } else {
        this.nativeTriggerLabel.setAttribute(
          'title',
          this.originalTriggerTitle,
        );
      }
      this.nativeTriggerLabel.removeAttribute(nativeTriggerLabelAttribute);
      this.nativeTriggerLabel.removeAttribute(nativeTriggerLoadingAttribute);
    }
    this.nativeTrigger = null;
    this.nativeTriggerLabel = null;
    this.originalTriggerLabel = '';
    this.originalTriggerTitle = null;
  }

  private mountMenuOptions(dialog: HTMLElement): void {
    const configs =
      this.menuPositionHint === undefined
        ? availableLineupSortConfigs()
        : availableLineupSortConfigs(this.menuPositionHint);
    if (
      this.nativeMenu === dialog &&
      this.menuOptions.size === configs.length &&
      configs.every((config) => this.menuOptions.has(config.mode)) &&
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
    for (const config of configs) {
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

  private clearCompletedCellRecords(): void {
    this.completedCellRecords = [];
    this.completedCellRecordByCell.clear();
    this.sortedCellRecords.clear();
    this.dirtyCompletedCells.clear();
  }

  private rebuildCompletedCellRecords(cells: readonly HTMLElement[]): void {
    this.clearCompletedCellRecords();
    this.completedCellRecords = cells.map((cell, originalIndex) =>
      sortableCellRecord(cell, originalIndex),
    );
    for (const record of this.completedCellRecords) {
      this.completedCellRecordByCell.set(record.cell, record);
    }
  }

  private refreshDirtyCompletedCellRecords(): void {
    if (this.dirtyCompletedCells.size === 0) return;
    let changed = false;
    for (const cell of this.dirtyCompletedCells) {
      const previous = this.completedCellRecordByCell.get(cell);
      if (!previous || !cell.isConnected || !this.completedCells.has(cell)) {
        continue;
      }
      const current = sortableCellRecord(cell, previous.originalIndex);
      this.completedCellRecords[previous.originalIndex] = current;
      this.completedCellRecordByCell.set(cell, current);
      if (this.pendingReplacementCells.has(cell) && current.ready) {
        this.pendingReplacementCells.delete(cell);
      }
      changed = true;
    }
    this.dirtyCompletedCells.clear();
    if (changed) this.sortedCellRecords.clear();
  }

  private sortedRecordsForMode(mode: LineupSortMode): SortableCellRecord[] {
    const cached = this.sortedCellRecords.get(mode);
    if (cached) return cached;
    const sorted = [...this.completedCellRecords].sort((left, right) => {
      const leftValue = left.values[mode];
      const rightValue = right.values[mode];
      if (leftValue === null && rightValue === null) {
        return left.originalIndex - right.originalIndex;
      }
      if (leftValue === null) return 1;
      if (rightValue === null) return -1;
      return (
        rightValue - leftValue || left.originalIndex - right.originalIndex
      );
    });
    this.sortedCellRecords.set(mode, sorted);
    return sorted;
  }

  private reusableCompletedGrid(): HTMLElement | null {
    const grid = this.completedGrid;
    if (!grid?.isConnected || this.gridNeedsReconciliation) return null;
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
    this.menuPositionHint = undefined;
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
    if (mode && reusableGrid && this.activeMode) {
      // The complete pool and its original Sorare orders are already known.
      // Switching between our modes can go directly from the current rank to
      // the next one without restoring and laying out the native order first.
      this.cancelSortFrame();
      this.activeMode = mode;
      this.filterSuspended = false;
      this.refreshDirtyCompletedCellRecords();
      this.refreshHydrationProgress();
      this.syncNativeSortUi();
      this.scheduleSort();
      return;
    }
    this.cancelSortFrame();
    if (this.activeMode) this.restoreOriginalOrders();
    this.cancelPoolLoad();
    this.activeMode = mode;
    this.filterSuspended = false;
    this.requestedPosition = mode
      ? this.menuPositionHint === undefined
        ? activeLineupPosition()
        : this.menuPositionHint
      : undefined;
    if (mode && reusableGrid) {
      this.completedGrid = reusableGrid;
      const cells = gridCardCells(reusableGrid);
      this.completedCells = new Set(cells);
      this.rebuildCompletedCellRecords(cells);
      this.gridNeedsReconciliation = false;
      this.observeGrid(reusableGrid);
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
    this.displayedPoolCardCount = 0;
    this.poolHydrating = false;
    this.resetHydrationUiState();
    this.poolReadyCount = 0;
    this.poolValueCount = 0;
    this.setHydrationGrid(null);
    this.loadingGrid = null;
    this.completedGrid = null;
    this.completedCells.clear();
    this.clearCompletedCellRecords();
    this.gridNeedsReconciliation = false;
    this.failedGrid = null;
    this.failedCells.clear();
    this.pendingReplacementCells.clear();
    this.gridObserver?.disconnect();
    this.gridObserver = undefined;
    if (this.gridReconcileTimer !== undefined) {
      window.clearTimeout(this.gridReconcileTimer);
      this.gridReconcileTimer = undefined;
    }
  }

  private rememberFailedPool(
    grid = this.loadingGrid?.isConnected ? this.loadingGrid : lineupPlayerGrid(),
  ): void {
    this.poolLoadFailed = true;
    this.poolHydrating = false;
    this.resetHydrationUiState();
    this.poolReadyCount = 0;
    this.poolValueCount = 0;
    this.failedGrid = grid;
    this.failedCells = new Set(grid ? gridCardCells(grid) : []);
    this.setHydrationGrid(null);
    this.observeGrid(grid);
    this.loadingGrid = null;
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
    const startedAt = performance.now();
    logStatsDiagnostic('lineup-sort-pool-start', {
      mode: this.activeMode,
    });
    const isCancelled = (): boolean =>
      generation !== this.poolGeneration || !this.activeMode;
    const grid = await this.poolLoader({
      isCancelled,
      onProgress: (cardCount) => {
        if (isCancelled()) return;
        this.poolCardCount = cardCount;
        this.displayedPoolCardCount = Math.max(
          this.displayedPoolCardCount,
          cardCount,
        );
        this.syncNativeSortUi();
      },
      onGridUpdate: (activeGrid) => {
        if (isCancelled()) return;
        this.loadingGrid = activeGrid;
        this.setHydrationGrid(activeGrid);
        activeGrid.dispatchEvent(
          new CustomEvent(lineupPoolProgressEvent, { bubbles: true }),
        );
      },
    });
    if (isCancelled()) return;
    this.poolLoading = false;
    if (!grid) {
      this.rememberFailedPool();
      logStatsDiagnostic('lineup-sort-pool-failed', {
        mode: this.activeMode,
        players: this.poolCardCount,
        durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
        reason: 'incomplete-grid',
      });
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
      logStatsDiagnostic('lineup-sort-pool-failed', {
        mode: this.activeMode,
        players: gridCardCount(grid),
        durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
        reason: 'position-mismatch',
      });
      this.syncNativeSortUi();
      return;
    }

    this.poolLoadFailed = false;
    this.loadingGrid = null;
    this.completedGrid = grid;
    const completedCells = gridCardCells(grid);
    this.completedCells = new Set(completedCells);
    this.rebuildCompletedCellRecords(completedCells);
    this.gridNeedsReconciliation = false;
    this.poolCardCount = this.completedCells.size;
    this.displayedPoolCardCount = Math.max(
      this.displayedPoolCardCount,
      this.poolCardCount,
    );
    this.setHydrationGrid(grid);
    this.observeGrid(grid);
    grid.dispatchEvent(
      new CustomEvent(lineupPoolReadyEvent, { bubbles: true }),
    );
    logStatsDiagnostic('lineup-sort-pool-complete', {
      mode: this.activeMode,
      players: this.poolCardCount,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    });
    this.refreshHydrationProgress();
    this.syncNativeSortUi();
    this.scheduleSort();
  }

  private refreshHydrationProgress(): void {
    const grid = this.completedGrid;
    if (!grid?.isConnected) {
      this.poolHydrating = false;
      this.resetHydrationUiState();
      this.poolReadyCount = 0;
      this.poolValueCount = 0;
      this.setHydrationGrid(null);
      return;
    }
    this.refreshDirtyCompletedCellRecords();
    const records = this.completedCellRecords;
    this.poolCardCount = records.length;
    this.displayedPoolCardCount = Math.max(
      this.displayedPoolCardCount,
      this.poolCardCount,
    );
    this.poolReadyCount = records.filter(({ ready }) => ready).length;
    const activeMode = this.activeMode;
    this.poolValueCount = activeMode
      ? records.filter(({ values }) => values[activeMode] !== null).length
      : 0;
    this.poolHydrating =
      this.poolCardCount > 0 && this.poolReadyCount < this.poolCardCount;
    this.refreshHydrationUiState();
    this.setHydrationGrid(this.poolHydrating ? grid : null);
  }

  private refreshHydrationUiState(): void {
    if (this.poolHydrationUiComplete) return;
    if (!this.poolHydrationUiPending && !this.poolHydrating) {
      this.poolHydrationUiComplete = true;
      return;
    }
    if (this.poolHydrating) {
      this.poolHydrationUiPending = true;
      if (this.poolHydrationUiTimer !== undefined) {
        window.clearTimeout(this.poolHydrationUiTimer);
        this.poolHydrationUiTimer = undefined;
      }
      return;
    }
    if (this.poolHydrationUiTimer !== undefined) return;
    const generation = this.poolGeneration;
    this.poolHydrationUiTimer = window.setTimeout(() => {
      this.poolHydrationUiTimer = undefined;
      if (
        generation !== this.poolGeneration ||
        !this.activeMode ||
        this.poolHydrating ||
        !this.completedGrid?.isConnected
      ) {
        return;
      }
      this.poolHydrationUiPending = false;
      this.poolHydrationUiComplete = true;
      this.syncNativeSortUi();
    }, hydrationUiSettleDelayMs);
  }

  private resetHydrationUiState(): void {
    if (this.poolHydrationUiTimer !== undefined) {
      window.clearTimeout(this.poolHydrationUiTimer);
      this.poolHydrationUiTimer = undefined;
    }
    this.poolHydrationUiPending = false;
    this.poolHydrationUiComplete = false;
  }

  private setHydrationGrid(grid: HTMLElement | null): void {
    if (this.hydrationGrid === grid) {
      if (grid) grid.setAttribute(lineupSortHydrationGridAttribute, 'true');
      return;
    }
    this.hydrationGrid?.removeAttribute(lineupSortHydrationGridAttribute);
    this.hydrationGrid = grid;
    grid?.setAttribute(lineupSortHydrationGridAttribute, 'true');
  }

  private observeGrid(grid: HTMLElement | null): void {
    this.gridObserver?.disconnect();
    this.gridObserver = undefined;
    if (!grid || typeof MutationObserver === 'undefined') return;
    this.gridObserver = new MutationObserver((mutations) => {
      if (
        !this.activeMode ||
        this.poolLoading ||
        this.filterSuspended ||
        !mutations.some((mutation) => mutation.type === 'childList')
      ) {
        return;
      }
      this.gridNeedsReconciliation = true;
      if (this.poolLoadFailed) {
        this.restartCompleteSort(80);
        return;
      }
      if (this.adoptEquivalentGridReplacements(grid)) return;
      this.scheduleGridReconciliation(grid);
    });
    this.gridObserver.observe(grid, { childList: true });
  }

  private adoptEquivalentGridReplacements(grid: HTMLElement): boolean {
    if (grid !== this.completedGrid || !grid.isConnected) return false;
    const previousCells = [...this.completedCells];
    const currentCells = gridCardCells(grid);
    if (previousCells.length !== currentCells.length) return false;

    const replacements: Array<{
      previous: HTMLElement;
      current: HTMLElement;
    }> = [];
    for (let index = 0; index < currentCells.length; index += 1) {
      const previous = previousCells[index];
      const current = currentCells[index];
      if (!previous || !current || previous === current) continue;
      const previousIdentity = cardCellIdentity(previous);
      if (!previousIdentity || previousIdentity !== cardCellIdentity(current)) {
        return false;
      }
      replacements.push({ previous, current });
    }

    if (replacements.length === 0) {
      this.gridNeedsReconciliation = false;
      return true;
    }
    for (const { previous, current } of replacements) {
      const order = previous.style.getPropertyValue('order');
      const priority = previous.style.getPropertyPriority('order');
      if (order) current.style.setProperty('order', order, priority);
      else current.style.removeProperty('order');

      const originalOrder = this.originalOrders.get(previous);
      if (originalOrder) this.originalOrders.set(current, originalOrder);
      this.originalOrders.delete(previous);
      this.pendingReplacementCells.delete(previous);
      this.dirtyCompletedCells.delete(previous);
      this.dirtyCompletedCells.delete(current);
      const previousRecord = this.completedCellRecordByCell.get(previous);
      this.completedCellRecordByCell.delete(previous);
      if (previousRecord) {
        const currentRecord = sortableCellRecord(
          current,
          previousRecord.originalIndex,
        );
        this.completedCellRecords[previousRecord.originalIndex] = currentRecord;
        this.completedCellRecordByCell.set(current, currentRecord);
      }
      if (!this.completedCellRecordByCell.get(current)?.ready) {
        this.pendingReplacementCells.add(current);
      }
    }
    this.completedCells = new Set(currentCells);
    this.sortedCellRecords.clear();
    this.gridNeedsReconciliation = false;
    if (this.gridReconcileTimer !== undefined) {
      window.clearTimeout(this.gridReconcileTimer);
      this.gridReconcileTimer = undefined;
    }
    this.sortRefreshPending = true;
    this.scheduleSort();
    logStatsDiagnostic('lineup-sort-card-remount', {
      players: replacements.length,
    });
    return true;
  }

  private scheduleGridReconciliation(
    grid: HTMLElement,
    delayMs = 80,
  ): void {
    if (this.gridReconcileTimer !== undefined) return;
    this.gridReconcileTimer = window.setTimeout(() => {
      this.gridReconcileTimer = undefined;
      if (
        !this.activeMode ||
        this.poolLoading ||
        this.filterSuspended ||
        grid !== this.completedGrid
      ) {
        return;
      }
      if (this.adoptEquivalentGridReplacements(grid)) return;
      this.restartCompleteSort();
    }, Math.max(0, delayMs));
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
      if (this.sortRefreshPending) {
        this.sortRefreshPending = false;
        if (!this.activeMode || this.poolLoading || this.filterSuspended) return;
        this.refreshHydrationProgress();
        this.syncNativeSortUi();
      }
      this.applySort();
    };
    this.sortFrame =
      typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame(callback)
        : window.setTimeout(callback, 0);
  }

  private cancelSortFrame(): void {
    this.sortRefreshPending = false;
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
    const grid = this.completedGrid;
    if (!grid?.isConnected) {
      this.restoreOriginalOrders();
      this.restartCompleteSort(80);
      return;
    }
    if (this.gridNeedsReconciliation) return;

    this.refreshDirtyCompletedCellRecords();

    let waitsForReplacementData = false;
    for (const cell of this.pendingReplacementCells) {
      if (!grid.contains(cell) || !this.completedCells.has(cell)) {
        this.pendingReplacementCells.delete(cell);
      } else if (this.completedCellRecordByCell.get(cell)?.ready) {
        this.pendingReplacementCells.delete(cell);
      } else {
        waitsForReplacementData = true;
      }
    }
    if (waitsForReplacementData) return;

    const records = this.sortedRecordsForMode(this.activeMode);
    if (records.length < 2) {
      this.restoreOriginalOrders();
      return;
    }

    for (const { cell } of records) {
      if (!this.originalOrders.has(cell)) {
        this.originalOrders.set(cell, {
          value: cell.style.getPropertyValue('order'),
          priority: cell.style.getPropertyPriority('order'),
        });
      }
    }
    const firstOrder = -records.length;
    records.forEach(({ cell }, index) => {
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
