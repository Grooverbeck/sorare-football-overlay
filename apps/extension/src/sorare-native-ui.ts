const nativeLineupTriggerSelector =
  'span[type="button"][aria-haspopup="dialog"]';
const nativeLineupAttribute = 'data-sorare-overlay-native-lineup';
const nativeLineupSurfaceAttribute =
  'data-sorare-overlay-native-lineup-surface';
const nativeLineupContentAttribute =
  'data-sorare-overlay-native-lineup-content';
const nativeLineupIconAttribute =
  'data-sorare-overlay-native-lineup-icon';
const nativeLineupValueAttribute =
  'data-sorare-overlay-native-lineup-value';
const nativeLineupFoldAttribute =
  'data-sorare-overlay-native-lineup-fold';
const nativeLineupToneAttribute =
  'data-sorare-overlay-native-lineup-tone';
const cardImageSelector =
  'img[src*="/cardsamplepicture/"], img[alt$=" - common" i], img[alt$=" - limited" i], img[alt$=" - rare" i], img[alt$=" - super rare" i], img[alt$=" - unique" i]';
const percentagePattern = /^(\d{1,3})\s*%$/;

type NativeLineupTone =
  | 'very-low'
  | 'low'
  | 'balanced'
  | 'good'
  | 'strong'
  | 'elite';

function lineupTone(percentage: number): NativeLineupTone {
  if (percentage < 40) return 'very-low';
  if (percentage < 60) return 'low';
  if (percentage < 70) return 'balanced';
  if (percentage < 80) return 'good';
  if (percentage < 90) return 'strong';
  return 'elite';
}

function hasNearbyCardImage(trigger: HTMLElement): boolean {
  let scope = trigger.parentElement;
  for (let depth = 0; scope && depth < 5; depth += 1) {
    if (scope.querySelector(cardImageSelector)) return true;
    scope = scope.parentElement;
  }
  return false;
}

function nativeLineupTriggers(root: ParentNode): HTMLElement[] {
  const triggers = new Set<HTMLElement>();
  if (root instanceof Element) {
    const closest = root.closest<HTMLElement>(nativeLineupTriggerSelector);
    if (closest) triggers.add(closest);
  }
  for (const trigger of root.querySelectorAll<HTMLElement>(
    nativeLineupTriggerSelector,
  )) {
    triggers.add(trigger);
  }
  return [...triggers];
}

export function decorateNativeSorareLineupProbabilities(
  root: ParentNode,
): void {
  for (const trigger of nativeLineupTriggers(root)) {
    if (
      trigger.closest(
        '[data-sorare-overlay-root], [data-sorare-overlay-companion]',
      ) ||
      !hasNearbyCardImage(trigger)
    ) {
      continue;
    }

    const surface = [...trigger.children].find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement &&
        Boolean(child.style.getPropertyValue('--bg')),
    );
    if (!surface) continue;

    const content = [...surface.children].find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement &&
        child.querySelector(':scope > svg') instanceof SVGElement &&
        child.querySelector(':scope > p') instanceof HTMLParagraphElement,
    );
    if (!content) continue;

    const icon = content.querySelector<SVGElement>(':scope > svg');
    const value = content.querySelector<HTMLParagraphElement>(':scope > p');
    const match = value?.textContent?.trim().match(percentagePattern);
    const percentage = match ? Number(match[1]) : Number.NaN;
    if (!icon || !value || !Number.isInteger(percentage) || percentage > 100) {
      continue;
    }

    const fold = [...surface.children].find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child !== content,
    );

    trigger.setAttribute(nativeLineupAttribute, 'true');
    surface.setAttribute(nativeLineupSurfaceAttribute, 'true');
    surface.setAttribute(nativeLineupToneAttribute, lineupTone(percentage));
    content.setAttribute(nativeLineupContentAttribute, 'true');
    icon.setAttribute(nativeLineupIconAttribute, 'true');
    value.setAttribute(nativeLineupValueAttribute, 'true');
    fold?.setAttribute(nativeLineupFoldAttribute, 'true');
  }
}

export function clearNativeSorareLineupProbabilityDecorations(): void {
  for (const trigger of document.querySelectorAll<HTMLElement>(
    `[${nativeLineupAttribute}]`,
  )) {
    trigger.removeAttribute(nativeLineupAttribute);
  }
  for (const surface of document.querySelectorAll<HTMLElement>(
    `[${nativeLineupSurfaceAttribute}]`,
  )) {
    surface.removeAttribute(nativeLineupSurfaceAttribute);
    surface.removeAttribute(nativeLineupToneAttribute);
  }
  for (const element of document.querySelectorAll<HTMLElement>(
    `[${nativeLineupContentAttribute}], [${nativeLineupIconAttribute}], [${nativeLineupValueAttribute}], [${nativeLineupFoldAttribute}]`,
  )) {
    element.removeAttribute(nativeLineupContentAttribute);
    element.removeAttribute(nativeLineupIconAttribute);
    element.removeAttribute(nativeLineupValueAttribute);
    element.removeAttribute(nativeLineupFoldAttribute);
  }
}
