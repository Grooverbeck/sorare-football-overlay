import type { FootballPosition } from '@sorare-overlay/shared';
import {
  cardPictureIdFromUrl as pictureIdFromUrl,
  extractCardPictureId,
  findSorareCardMedia,
  findCardMediaContainer,
} from './card-media.js';
export { extractCardPictureId } from './card-media.js';

export interface CardTarget {
  slug?: string;
  playerName?: string;
  position?: FootballPosition;
  teamSlug?: string;
  container: HTMLElement;
}

export interface FindCardTargetsOptions {
  activeLineupPosition?: FootballPosition | null;
  skipMiniatureCardCheck?: boolean;
}

const playerPath = /\/(?:football\/)?players\/([a-z0-9]+(?:-[a-z0-9]+)*)/i;
const cardImageAlt = /^(.+?)\s+-\s+(?:common|limited|rare|super rare|unique)$/i;
const cardPicturePath = /\/cardsamplepicture\/([a-z0-9-]+)\//i;
const linkedCardSlug = /^([a-z0-9]+(?:-[a-z0-9]+)*)-(?:19|20)\d{2}-(?:common|limited|rare|super-rare|unique)-(?:\d+|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;

export function isSorareCardVideo(video: HTMLVideoElement): boolean {
  try {
    const poster = new URL(video.poster, location.href);
    return poster.hostname === 'assets.sorare.com' && cardPicturePath.test(poster.pathname);
  } catch { return false; }
}

function linkedPlayerSlug(url: URL): string | null {
  if (!url.pathname.includes('/football/')) return null;
  const detailCard = url.pathname.match(/\/football\/series\/cards\/([^/]+)\/?$/)?.[1];
  if (detailCard) return detailCard.match(linkedCardSlug)?.[1]?.toLowerCase() ?? null;
  const cards = url.searchParams.getAll('card');
  return cards.length === 1 ? cards[0]!.match(linkedCardSlug)?.[1]?.toLowerCase() ?? null : null;
}
const minimumOverlayCardWidth = 72;
const minimumOverlayCardHeight = 110;
const knownPlayerNamesByPictureId = new Map<string, string>();
const discoveredPlayerNamesByPictureId = new Map<string, string>();
// Verified from Sorare's visible gallery card links. New cards are learned
// from their own link/placeholder; unknown pictures are never guessed by team.
const verifiedSetPictures: Readonly<Record<string, string>> = {
  '92b655c1-7b93-4dc6-8093-2a544042b0fc': 'dayotchanculle-upamecano',
  'b5693b3b-876e-4e8e-8bfc-f19893af6693': 'gonzalo-garcia-torres',
  'bb0a6f5d-b319-4bed-ade3-4baf71e8456e': 'harold-voyer',
  'f244abfc-a2d0-4555-b3bd-e8c071f869af': 'nathan-de-cat',
  'bd20bfa2-0203-4fac-aa2d-495a72206f2c': 'ethan-mbappe-lottin',
  // Confirmed together in Sorare's visible card-details dialog.
  '59bcd30d-a708-401a-a5e2-0cd6aa11abb5': 'bryan-mbeumo',
  // Confirmed via the visible picker stats details (11 September 2026).
  '30cf34c8-c146-4bda-9a66-839f9203e3b4': 'finn-jeltsch',
  'dd39cfe2-d734-44e7-b11a-0410e273f5a4': 'ibrahim-maza',
};
const knownPlayerSlugsByPictureId = new Map(Object.entries(verifiedSetPictures));
const discoveredPlayerSlugsByPictureId = new Map<string, string>();

export function hydrateCardPictureSlugs(entries: Readonly<Record<string, string>>): void {
  knownPlayerSlugsByPictureId.clear();
  discoveredPlayerSlugsByPictureId.clear();
  for (const [id, slug] of Object.entries({...entries, ...verifiedSetPictures})) {
    if (/^[a-z0-9-]+$/i.test(id) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(slug)) knownPlayerSlugsByPictureId.set(id.toLowerCase(), slug.toLowerCase());
  }
}

export function drainDiscoveredCardPictureSlugs(): Record<string, string> {
  const values = Object.fromEntries(discoveredPlayerSlugsByPictureId);
  discoveredPlayerSlugsByPictureId.clear();
  return values;
}

export function readCardPlaceholder(svg: SVGSVGElement): {playerName: string; position?: FootballPosition} | null {
  const rarity = svg.querySelector('text[y="95%"]')?.textContent?.trim() ?? '';
  const playerName = svg.querySelector('text[x="50%"][y="80%"]')?.textContent?.trim();
  if (!/^(common|limited|rare|super rare|unique)$/i.test(rarity) || !playerName || playerName.length > 120 || !/\p{L}/u.test(playerName)) return null;
  const position = normalizePosition(svg.querySelector('text[y="85%"]')?.textContent);
  return {playerName, ...(position ? {position} : {})};
}

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
const fullPositionToken =
  /\b(?:goalkeeper|keeper|torwart|defender|verteidiger|midfielder|mittelfeld|forward|striker|stuermer|sturmer)\b/i;
const packPositionIsolationText =
  /\b(?:deine\s+karten|your\s+cards|neuverpflichtungen|new\s+signings)\b/i;

export function extractPlayerSlug(anchor: HTMLAnchorElement): string | null {
  try {
    const url = new URL(anchor.href, location.href);
    if (!['sorare.com', 'www.sorare.com'].includes(url.hostname)) return null;
    return url.pathname.match(playerPath)?.[1]?.toLowerCase() ?? linkedPlayerSlug(url);
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

function findFullPositionToken(
  value: string | null | undefined,
): FootballPosition | undefined {
  const match = normalizePositionText(value).match(fullPositionToken);
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

  // Compact markers such as "ST" are only reliable in structured position
  // fields. In arbitrary card text they can also be team-name fragments, for
  // example the "St." in "St. Louis City SC".
  const visiblePosition = findFullPositionToken(container.textContent);
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
  // Sorare's current lineup builder nests a card grid nine levels below the
  // shared position navigation. Stop at the lineup root rather than falling
  // back to a player's general API position while a card skeleton is loading.
  const maxPositionScopeDepth = 10;
  if (container.closest('[role="dialog"]')) return undefined;
  let packScope: HTMLElement | null = container;
  for (let depth = 0; packScope && packScope !== body && depth < 8; depth += 1) {
    if (packPositionIsolationText.test(packScope.textContent ?? '')) {
      return undefined;
    }
    packScope = packScope.parentElement;
  }

  let scope = container.parentElement;
  for (
    let depth = 0;
    scope && scope !== body && depth < maxPositionScopeDepth;
    depth += 1
  ) {
    const availablePositions = new Set<FootballPosition>();
    const activePositions = new Set<FootballPosition>();
    for (const button of scope.querySelectorAll<HTMLButtonElement>('button')) {
      const marker = normalizePositionText(button.textContent);
      if (!compactPositionAliases.has(marker)) continue;
      const position = normalizePosition(marker);
      if (!position) continue;
      availablePositions.add(position);
      const isActive =
        button.getAttribute('aria-pressed') === 'true' ||
        button.dataset.state === 'active' ||
        button.classList.contains('highlighted');
      if (!isActive) continue;
      activePositions.add(position);
    }
    // A lone highlighted "MF" elsewhere in the app is not enough. Sorare's
    // lineup picker exposes the complete GK/DEF/MID/FWD navigation together.
    if (availablePositions.size < 3) {
      scope = scope.parentElement;
      continue;
    }
    if (activePositions.size === 1) return [...activePositions][0];
    if (activePositions.size > 1) return undefined;
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
  // Set editions use a card query parameter and may render only a video.
  // Use the same semantic container as image discovery to avoid duplicates.
  if (linkedPlayerSlug(new URL(anchor.href, location.href))) {
    const media = findSorareCardMedia(anchor);
    const ids = new Set(media.map(extractCardPictureId).filter(Boolean));
    if (media.length === 1 || (media.length > 0 && ids.size === 1 && media.every(node => extractCardPictureId(node)))) {
      return findCardMediaContainer(media[0]!) ?? anchor;
    }
    return null;
  }
  const explicitCard = anchor.closest<HTMLElement>(
    '[data-player-slug], [data-card-slug], [data-testid*="card" i]',
  );
  if (explicitCard) return explicitCard;

  const hasCardImage = (container: ParentNode): boolean => findSorareCardMedia(container).length > 0;

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
  // Image and CSS/video scans of one locked card must share the same mount.
  return findCardMediaContainer(image);
}

function inferHighlightedPlayerTeamSlug(
  container: HTMLElement,
  boundary?: HTMLElement,
): string | undefined {
  let scope = boundary === container ? container : container.parentElement;
  for (let depth = 0; scope && depth < 6; depth += 1) {
    const teamsByRow = new Map<HTMLElement, HTMLElement[]>();
    for (const teamNode of scope.querySelectorAll<HTMLElement>(
      '[aria-label="Team"]',
    )) {
      if (teamNode.closest('[data-sorare-overlay-root], [data-sorare-overlay-companion]')) {
        continue;
      }
      const row = teamNode.parentElement;
      if (!row) continue;
      const teams = teamsByRow.get(row) ?? [];
      teams.push(teamNode);
      teamsByRow.set(row, teams);
    }

    const rows = [...teamsByRow.values()].filter((teams) => teams.length === 2);
    if (rows.length > 0) {
      const selectedTeamSlugs = new Set<string>();
      for (const teams of rows) {
        const selectedTeams = teams.filter(
          (team) =>
            team.classList.contains('highlighted') ||
            team.getAttribute('aria-current') === 'true' ||
            team.getAttribute('aria-selected') === 'true' ||
            team.dataset.state === 'active',
        );
        if (selectedTeams.length !== 1) continue;
        const slug = selectedTeams[0]
          ?.querySelector<HTMLImageElement>('img[alt]')
          ?.alt.trim()
          .toLowerCase();
        if (slug && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
          selectedTeamSlugs.add(slug);
        }
      }
      return selectedTeamSlugs.size === 1
        ? [...selectedTeamSlugs][0]
        : undefined;
    }
    if (scope === boundary) return undefined;
    scope = scope.parentElement;
  }
  return undefined;
}

export function isMiniatureCardTarget(container: HTMLElement): boolean {
  const media = findSorareCardMedia(container);
  const renderedCardRects = media
    .map((image) => image.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
  if (media.length > 0 && renderedCardRects.length === 0) {
    const rect = container.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) renderedCardRects.push(rect);
  }

  return (
    renderedCardRects.length > 0 &&
    renderedCardRects.every(
      (rect) =>
        rect.width < minimumOverlayCardWidth ||
        rect.height < minimumOverlayCardHeight,
    )
  );
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

export function findCardTargets(
  root: ParentNode,
  options: FindCardTargetsOptions = {},
): CardTarget[] {
  const targets: CardTarget[] = [];
  const targetContainers = new Set<HTMLElement>();
  const hasActiveLineupPosition = Object.prototype.hasOwnProperty.call(
    options,
    'activeLineupPosition',
  );
  const lineupContextBoundary = (
    container: HTMLElement,
  ): HTMLElement | undefined => {
    if (
      !hasActiveLineupPosition ||
      !(root instanceof HTMLElement) ||
      (root !== container && !root.contains(container))
    ) {
      return undefined;
    }
    if (
      !root.hasAttribute('data-sorare-overlay-lineup-sort-hydration') ||
      root === container
    ) {
      return root;
    }
    let directChild = container;
    while (directChild.parentElement && directChild.parentElement !== root) {
      directChild = directChild.parentElement;
    }
    return directChild.parentElement === root ? directChild : root;
  };
  const anchors: HTMLAnchorElement[] = [];
  if (root instanceof HTMLAnchorElement) anchors.push(root);
  anchors.push(...root.querySelectorAll<HTMLAnchorElement>('a[href]'));

  for (const anchor of anchors) {
    const slug = extractPlayerSlug(anchor);
    // Details dialogs intentionally have no overlay. Their card thumbnail
    // still proves the picture-to-player identity, even with an empty alt.
    if (slug) {
      const ids = new Set(findSorareCardMedia(anchor)
        .map(extractCardPictureId).filter((id): id is string => Boolean(id)));
      if (ids.size === 1) {
        const id = [...ids][0]!;
        if (knownPlayerSlugsByPictureId.get(id) !== slug) {
          knownPlayerSlugsByPictureId.set(id, slug);
          discoveredPlayerSlugsByPictureId.set(id, slug);
        }
      }
    }
    const container = slug ? findCardContainer(anchor) : null;
    if (!slug || !container) continue;
    const pictures = findSorareCardMedia(container)
      .map(extractCardPictureId).filter((id): id is string => Boolean(id));
    if (new Set(pictures).size === 1) {
      const id = pictures[0]!;
      if (knownPlayerSlugsByPictureId.get(id) !== slug) {
        knownPlayerSlugsByPictureId.set(id, slug);
        discoveredPlayerSlugsByPictureId.set(id, slug);
      }
    }
    if (targetContainers.has(container)) continue;
    if (isScoreDetailsDialogTarget(container)) continue;
    if (
      !options.skipMiniatureCardCheck &&
      isMiniatureCardTarget(container)
    ) {
      continue;
    }
    const isLinkedCard = linkedPlayerSlug(new URL(anchor.href, location.href)) !== null;
    const slotPosition = isLinkedCard ? inferLineupSlotPosition(container) : undefined;
    const position = inferCardPosition(container) ??
      (slotPosition === null ? undefined : slotPosition ??
        (hasActiveLineupPosition ? options.activeLineupPosition ?? undefined :
          isLinkedCard ? inferActivePositionSelection(container) : inferNearbyPlayerPosition(container, slug)));
    const teamSlug = isLinkedCard ? inferHighlightedPlayerTeamSlug(container, lineupContextBoundary(container)) : undefined;
    targets.push({ slug, container, ...(position ? { position } : {}), ...(teamSlug ? {teamSlug} : {}) });
    targetContainers.add(container);
  }

  const images: HTMLImageElement[] = [];
  if (root instanceof HTMLImageElement) images.push(root);
  images.push(...root.querySelectorAll<HTMLImageElement>('img[alt]'));
  for (const image of images) {
    const playerName = extractPlayerName(image);
    if (playerName) rememberCardPictureName(image, playerName);
  }
  const placeholders = Array.from(root.querySelectorAll<SVGTextElement>('svg text[x="50%"][y="80%"]'))
    .map(text => text.closest('svg')!).filter(Boolean);
  if (root instanceof SVGSVGElement) placeholders.unshift(root);
  for (const svg of placeholders) {
    const identity = readCardPlaceholder(svg);
    const container = findCardMediaContainer(svg);
    if (!identity || !container || isScoreDetailsDialogTarget(container)) continue;
    const ids = new Set(Array.from(container.querySelectorAll<HTMLElement>('[style*="--mask-shape"]'))
      .map(node => node.style.getPropertyValue('--mask-shape').match(/url\(["']?([^"')]+)["']?\)/)?.[1])
      .flatMap(url => {const id = url ? pictureIdFromUrl(url) : null; return id ? [id] : [];}));
    if (ids.size !== 1) continue;
    const id = [...ids][0]!;
    if (knownPlayerNamesByPictureId.get(id) !== identity.playerName) {
      knownPlayerNamesByPictureId.set(id, identity.playerName);
      discoveredPlayerNamesByPictureId.set(id, identity.playerName);
    }
    if (targetContainers.has(container)) continue;
    const rect = svg.getBoundingClientRect();
    if (!options.skipMiniatureCardCheck && rect.width > 0 && (rect.width < minimumOverlayCardWidth || rect.height < minimumOverlayCardHeight)) continue;
    const slug = knownPlayerSlugsByPictureId.get(id);
    targets.push({...identity, ...(slug ? {slug} : {}), container});
    targetContainers.add(container);
  }
  const specialMedia = findSorareCardMedia(root).filter(media => !(media instanceof HTMLImageElement));
  for (const media of specialMedia) {
    const id = extractCardPictureId(media);
    const slug = id ? knownPlayerSlugsByPictureId.get(id) : undefined;
    const playerName = id ? knownPlayerNamesByPictureId.get(id) : undefined;
    const container = findCardMediaContainer(media);
    if ((!slug && !playerName) || !container || targetContainers.has(container) || isScoreDetailsDialogTarget(container)) continue;
    // A shared wrapper with several players must never inherit one picture's identity.
    const ids = new Set(findSorareCardMedia(container).map(extractCardPictureId).filter(Boolean));
    if (ids.size !== 1) continue;
    if (!options.skipMiniatureCardCheck && isMiniatureCardTarget(container)) continue;
    const slot = inferLineupSlotPosition(container);
    const position = inferCardPosition(container) ?? (slot === null ? undefined : slot ?? (hasActiveLineupPosition ? options.activeLineupPosition ?? undefined : inferActivePositionSelection(container)));
    const teamSlug = inferHighlightedPlayerTeamSlug(container, lineupContextBoundary(container));
    targets.push({container, ...(slug ? {slug} : {playerName:playerName!}), ...(position ? {position} : {}), ...(teamSlug ? {teamSlug} : {})});
    targetContainers.add(container);
  }
  for (const image of images) {
    const playerName = resolvePlayerName(image);
    const container = playerName ? findImageCardContainer(image) : null;
    if (!playerName || !container) continue;
    if (targetContainers.has(container)) continue;
    if (isScoreDetailsDialogTarget(container)) continue;
    if (
      !options.skipMiniatureCardCheck &&
      isMiniatureCardTarget(container)
    ) {
      continue;
    }
    if (!extractPlayerName(image) && !hasNearbyTeamRow(container)) continue;
    const concretePosition = inferCardPosition(container);
    const lineupSlotPosition = inferLineupSlotPosition(container);
    const position =
      concretePosition ??
      (lineupSlotPosition === null
        ? undefined
        : lineupSlotPosition ??
          (hasActiveLineupPosition
            ? options.activeLineupPosition ?? undefined
            : inferActivePositionSelection(container)));
    const teamSlug = inferHighlightedPlayerTeamSlug(
      container,
      lineupContextBoundary(container),
    );
    targets.push({
      playerName,
      container,
      ...(position ? { position } : {}),
      ...(teamSlug ? { teamSlug } : {}),
    });
    targetContainers.add(container);
  }

  return targets;
}
