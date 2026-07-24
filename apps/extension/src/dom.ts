import type { FootballPosition } from '@sorare-overlay/shared';

export interface CardTarget {
  slug?: string;
  playerName?: string;
  position?: FootballPosition;
  container: HTMLElement;
}

const playerPath = /\/(?:football\/)?players\/([a-z0-9]+(?:-[a-z0-9]+)*)/i;
const cardImageAlt = /^(.+?)\s+-\s+(?:common|limited|rare|super rare|unique)$/i;
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

export function findCardContainer(anchor: HTMLAnchorElement): HTMLElement | null {
  return anchor.closest<HTMLElement>(
    '[data-player-slug], [data-card-slug], [data-testid*="card" i], article, li',
  ) ?? anchor.parentElement;
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

export function findImageCardContainer(image: HTMLImageElement): HTMLElement | null {
  return image.closest<HTMLElement>(
    '[data-player-slug], [data-card-slug], [data-testid*="card" i], button, [role="button"], article, li',
  ) ?? image.parentElement;
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
    const position =
      inferCardPosition(container) ?? inferNearbyPlayerPosition(container, slug);
    targets.push({ slug, container, ...(position ? { position } : {}) });
  }

  const images: HTMLImageElement[] = [];
  if (root instanceof HTMLImageElement) images.push(root);
  images.push(...root.querySelectorAll<HTMLImageElement>('img[alt]'));
  for (const image of images) {
    const playerName = extractPlayerName(image);
    const container = playerName ? findImageCardContainer(image) : null;
    if (!playerName || !container) continue;
    if (targets.some((target) => target.container === container)) continue;
    const position = inferCardPosition(container);
    targets.push({ playerName, container, ...(position ? { position } : {}) });
  }

  return targets;
}
