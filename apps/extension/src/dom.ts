import type { FootballPosition } from '@sorare-overlay/shared';

export interface CardTarget {
  slug?: string;
  playerName?: string;
  position?: FootballPosition;
  container: HTMLElement;
}

const playerPath = /\/(?:football\/)?players\/([a-z0-9]+(?:-[a-z0-9]+)*)/i;
const cardImageAlt = /^(.+?)\s+-\s+(?:common|limited|rare|super rare|unique)$/i;
const cardPicturePath = /\/cardsamplepicture\/([a-z0-9-]+)\//i;
const knownPlayerNamesByPictureId = new Map<string, string>();
const discoveredPlayerNamesByPictureId = new Map<string, string>();
const positionAliases: Readonly<Record<string, FootballPosition>> = {
  gk: 'Goalkeeper',
  goalkeeper: 'Goalkeeper',
  keeper: 'Goalkeeper',
  torwart: 'Goalkeeper',
  tw: 'Goalkeeper',
  def: 'Defender',
  defender: 'Defender',
  df: 'Defender',
  ver: 'Defender',
  verteidiger: 'Defender',
  mf: 'Midfielder',
  mid: 'Midfielder',
  midfielder: 'Midfielder',
  mittelfeld: 'Midfielder',
  forward: 'Forward',
  fw: 'Forward',
  fwd: 'Forward',
  st: 'Forward',
  striker: 'Forward',
  stuermer: 'Forward',
  sturmer: 'Forward',
};
const compactPositionAliases = new Set(['gk', 'tw', 'def', 'df', 'ver', 'mid', 'mf', 'fwd', 'fw', 'st']);
const positionToken =
  /\b(?:goalkeeper|keeper|torwart|gk|tw|defender|verteidiger|def|df|ver|midfielder|mittelfeld|mid|mf|forward|striker|stuermer|sturmer|fwd|fw|st)\b/i;
const packPositionIsolationText =
  /\b(?:deine\s+karten|your\s+cards|neuverpflichtungen|new\s+signings)\b/i;

export function extractPlayerSlug(anchor: HTMLAnchorElement): string | null {
  try {
    const url = new URL(anchor.href, location.href);
    if (!['sorare.com', 'www.sorare.com'].includes(url.hostname)) return null;
    return url.pathname.match(playerPath)?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

function normalizePositionText(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase();
}

function normalizePosition(value: string | null | undefined): FootballPosition | undefined {
  return positionAliases[normalizePositionText(value)];
}

function findPositionToken(value: string | null | undefined): FootballPosition | undefined {
  const match = normalizePositionText(value).match(positionToken);
  return match ? positionAliases[match[0]] : undefined;
}

export function inferCardPosition(container: HTMLElement): FootballPosition | undefined {
  const direct = normalizePosition(container.dataset.cardPosition ?? container.dataset.position);
  if (direct) return direct;

  const stablePositionNodes = Array.from(container.querySelectorAll<HTMLElement>(
    '[data-position], [data-card-position], [data-testid*="position" i], [aria-label*="position" i]',
  ));

  // A short marker printed on the concrete card (for example Sorare's German
  // "MF") is more specific than a player's broader/base position elsewhere
  // in the same profile component.
  for (const node of stablePositionNodes) {
    for (const value of [node.dataset.cardPosition, node.textContent, node.getAttribute('aria-label')]) {
      if (!compactPositionAliases.has(normalizePositionText(value))) continue;
      const compactPosition = normalizePosition(value);
      if (compactPosition) return compactPosition;
    }
  }

  const visiblePosition = findPositionToken(container.textContent);
  if (visiblePosition) return visiblePosition;

  for (const node of stablePositionNodes) {
    for (const value of [
      node.dataset.cardPosition,
      node.dataset.position,
      node.textContent,
      node.getAttribute('aria-label'),
    ]) {
      const structured = normalizePosition(value) ?? findPositionToken(value);
      if (structured) return structured;
    }
  }

  return undefined;
}

function inferActivePositionSelection(
  container: HTMLElement,
): FootballPosition | undefined {
  const body = container.ownerDocument.body;
  if (container.closest('[role="dialog"]')) return undefined;
  let packScope: HTMLElement | null = container;
  for (let depth = 0; packScope && packScope !== body && depth < 8; depth += 1) {
    if (packPositionIsolationText.test(packScope.textContent ?? '')) {
      return undefined;
    }
    packScope = packScope.parentElement;
  }

  let scope = container.parentElement;
  while (scope && scope !== body) {
    const positions = new Set<FootballPosition>();
    for (const button of scope.querySelectorAll<HTMLButtonElement>('button')) {
      const isActive =
        button.getAttribute('aria-pressed') === 'true' ||
        button.dataset.state === 'active' ||
        button.classList.contains('highlighted');
      if (!isActive) continue;
      const marker = normalizePositionText(button.textContent);
      if (!compactPositionAliases.has(marker)) continue;
      const position = normalizePosition(marker);
      if (position) positions.add(position);
    }
    if (positions.size === 1) return [...positions][0];
    if (positions.size > 1) return undefined;
    scope = scope.parentElement;
  }
  return undefined;
}

function inferLineupSlotPosition(
  container: HTMLElement,
): FootballPosition | null | undefined {
  const positions: ReadonlyArray<FootballPosition | undefined> = [
    'Goalkeeper',
    'Defender',
    'Midfielder',
    'Forward',
    undefined,
  ];
  const lineup = container.closest<HTMLElement>('[class~="slots5"]');
  if (!lineup) return undefined;

  const slots = Array.from(lineup.children).filter((candidate) =>
    candidate.querySelector('button'),
  );
  if (slots.length !== positions.length) return undefined;
  const slotIndex = slots.findIndex((slot) => slot.contains(container));
  if (slotIndex < 0) return undefined;
  return positions[slotIndex] ?? null;
}

export function findCardContainer(anchor: HTMLAnchorElement): HTMLElement | null {
  const explicitCard = anchor.closest<HTMLElement>(
    '[data-player-slug], [data-card-slug], [data-testid*="card" i]',
  );
  if (explicitCard) return explicitCard;

  const hasCardImage = (container: ParentNode): boolean =>
    [...container.querySelectorAll<HTMLImageElement>('img[alt]')]
      .some((image) => extractPlayerName(image) !== null);

  if (hasCardImage(anchor)) return anchor;

  const semanticCard = anchor.closest<HTMLElement>('article, li');
  if (semanticCard && hasCardImage(semanticCard)) return semanticCard;

  const immediateParent = anchor.parentElement;
  return immediateParent && hasCardImage(immediateParent)
    ? immediateParent
    : null;
}

function inferNearbyPlayerPosition(
  container: HTMLElement,
  playerSlug: string,
): FootballPosition | undefined {
  let context = container.parentElement;
  for (let depth = 0; context && depth < 6; depth += 1) {
    const contextSlugs = new Set(
      [...context.querySelectorAll<HTMLAnchorElement>('a[href]')]
        .map(extractPlayerSlug)
        .filter((slug): slug is string => Boolean(slug)),
    );
    if ([...contextSlugs].some((slug) => slug !== playerSlug)) return undefined;

    const position = inferCardPosition(context);
    if (position) return position;
    context = context.parentElement;
  }
  return undefined;
}

export function extractPlayerName(image: HTMLImageElement): string | null {
  return image.alt.match(cardImageAlt)?.[1]?.trim() ?? null;
}

function extractCardPictureId(image: HTMLImageElement): string | null {
  try {
    return new URL(image.currentSrc || image.src, location.href).pathname
      .match(cardPicturePath)?.[1]
      ?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

export function hydrateCardPictureNames(
  entries: Readonly<Record<string, string>>,
): void {
  knownPlayerNamesByPictureId.clear();
  discoveredPlayerNamesByPictureId.clear();
  for (const [pictureId, playerName] of Object.entries(entries)) {
    if (!/^[a-z0-9-]+$/i.test(pictureId) || !playerName.trim()) continue;
    knownPlayerNamesByPictureId.set(pictureId.toLowerCase(), playerName.trim());
  }
}

export function drainDiscoveredCardPictureNames(): Record<string, string> {
  const entries = Object.fromEntries(discoveredPlayerNamesByPictureId);
  discoveredPlayerNamesByPictureId.clear();
  return entries;
}

function rememberCardPictureName(
  image: HTMLImageElement,
  playerName: string,
): void {
  const pictureId = extractCardPictureId(image);
  if (!pictureId || knownPlayerNamesByPictureId.get(pictureId) === playerName) {
    return;
  }
  knownPlayerNamesByPictureId.set(pictureId, playerName);
  discoveredPlayerNamesByPictureId.set(pictureId, playerName);
}

function hasNearbyTeamRow(container: HTMLElement): boolean {
  let scope = container.parentElement;
  for (let depth = 0; scope && depth < 5; depth += 1) {
    const teamsByRow = new Map<HTMLElement, number>();
    for (const teamNode of scope.querySelectorAll<HTMLElement>(
      '[aria-label="Team"]',
    )) {
      const row = teamNode.parentElement;
      if (!row) continue;
      teamsByRow.set(row, (teamsByRow.get(row) ?? 0) + 1);
    }
    if ([...teamsByRow.values()].includes(2)) return true;
    scope = scope.parentElement;
  }
  return false;
}

function resolvePlayerName(image: HTMLImageElement): string | null {
  const explicitName = extractPlayerName(image);
  if (explicitName) return explicitName;
  const pictureId = extractCardPictureId(image);
  return pictureId
    ? knownPlayerNamesByPictureId.get(pictureId) ?? null
    : null;
}

export function findImageCardContainer(image: HTMLImageElement): HTMLElement | null {
  return image.closest<HTMLElement>(
    '[data-player-slug], [data-card-slug], [data-testid*="card" i], button, [role="button"], article, li',
  ) ?? image.parentElement;
}

export function isScoreDetailsDialogTarget(container: HTMLElement): boolean {
  const dialog = container.closest<HTMLElement>('[role="dialog"]');
  if (!dialog) return false;
  return Boolean(
    dialog.querySelector<HTMLImageElement>(
      'a[href*="/football/series/cards/"] img',
    ),
  );
}

export function findCardTargets(root: ParentNode): CardTarget[] {
  const targets: CardTarget[] = [];
  const anchors: HTMLAnchorElement[] = [];
  if (root instanceof HTMLAnchorElement) anchors.push(root);
  anchors.push(...root.querySelectorAll<HTMLAnchorElement>('a[href]'));

  for (const anchor of anchors) {
    const slug = extractPlayerSlug(anchor);
    const container = slug ? findCardContainer(anchor) : null;
    if (!slug || !container) continue;
    if (isScoreDetailsDialogTarget(container)) continue;
    const position =
      inferCardPosition(container) ?? inferNearbyPlayerPosition(container, slug);
    targets.push({ slug, container, ...(position ? { position } : {}) });
  }

  const images: HTMLImageElement[] = [];
  if (root instanceof HTMLImageElement) images.push(root);
  images.push(...root.querySelectorAll<HTMLImageElement>('img[alt]'));
  for (const image of images) {
    const playerName = extractPlayerName(image);
    if (playerName) rememberCardPictureName(image, playerName);
  }
  for (const image of images) {
    const playerName = resolvePlayerName(image);
    const container = playerName ? findImageCardContainer(image) : null;
    if (!playerName || !container) continue;
    if (isScoreDetailsDialogTarget(container)) continue;
    if (!extractPlayerName(image) && !hasNearbyTeamRow(container)) continue;
    if (targets.some((target) => target.container === container)) continue;
    const concretePosition = inferCardPosition(container);
    const lineupSlotPosition = inferLineupSlotPosition(container);
    const position =
      concretePosition ??
      (lineupSlotPosition === null
        ? undefined
        : lineupSlotPosition ?? inferActivePositionSelection(container));
    targets.push({ playerName, container, ...(position ? { position } : {}) });
  }

  return targets;
}
