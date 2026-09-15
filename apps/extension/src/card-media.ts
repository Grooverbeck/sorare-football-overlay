// Sorare Set cards can switch between an image, video and CSS foil layers.
// Keep discovery and sorting on the same physical-card definition.
export const sorareCardMediaSelector =
  'img[alt], img[src*="/cardsamplepicture/"], video[poster], [style*="--mask-shape"], [style*="--mask-image-src"]';
export const sorareCardNamePattern = /^(.+?)\s+-\s+(?:common|limited|rare|super rare|unique)$/i;

export function cardPictureIdFromUrl(value: string): string | null {
  try {
    const url = new URL(value, location.href);
    return url.hostname === 'assets.sorare.com'
      ? url.pathname.match(/\/cardsamplepicture\/([a-z0-9-]+)\//i)?.[1]?.toLowerCase() ?? null
      : null;
  } catch { return null; }
}

function cssCardPictureId(media: HTMLElement, property: string): string | null {
  const value = media.style.getPropertyValue(property).trim();
  const url = value.match(/^url\(\s*["']?([^"')]+)["']?\s*\)$/)?.[1];
  return url ? cardPictureIdFromUrl(url) : null;
}

export function extractCardPictureId(media: HTMLElement): string | null {
  if (media instanceof HTMLImageElement) {
    return cardPictureIdFromUrl(media.currentSrc || media.src);
  }
  if (media instanceof HTMLVideoElement) return cardPictureIdFromUrl(media.poster);
  // Sorare unloads offscreen videos but retains this picture-bearing frame.
  return cssCardPictureId(media, '--mask-shape') ?? cssCardPictureId(media, '--mask-image-src');
}

export function findSorareCardMedia(root: ParentNode): HTMLElement[] {
  const candidates = [
    ...(root instanceof HTMLElement && root.matches(sorareCardMediaSelector) ? [root] : []),
    ...root.querySelectorAll<HTMLElement>(sorareCardMediaSelector),
  ];
  const recognized = candidates.filter(media =>
    (media instanceof HTMLImageElement && sorareCardNamePattern.test(media.alt)) ||
    extractCardPictureId(media) !== null,
  );
  const ids = new Map(recognized.map(media => [media, extractCardPictureId(media)]));
  return recognized.filter(media => {
    if (media instanceof HTMLImageElement || media instanceof HTMLVideoElement ||
      cssCardPictureId(media, '--mask-shape') !== null) return true;
    const id = ids.get(media);
    // The frame is a fallback, not an extra card. Prefer a live descendant
    // showing the same edition; keep different IDs visible to ambiguity checks.
    return !Array.from(media.querySelectorAll<HTMLElement>(sorareCardMediaSelector))
      .some(child => id != null && ids.get(child) === id);
  });
}

/** Find the visual card, including Sorare's non-interactive locked editions. */
export function findCardMediaContainer(media: Element): HTMLElement | null {
  const interactiveCard = media.closest<HTMLElement>(
    '[data-player-slug], [data-card-slug], [data-testid*="card" i], button, [role="button"], article, li',
  );
  if (interactiveCard) return interactiveCard;
  // A locked card has the same visual frame but no surrounding button. The
  // frame owns the card dimensions; an inner CSS foil layer may be height 0.
  const frame = media.closest<HTMLElement>('[style*="--mask-image-src"]');
  if (frame) return frame;
  const fallback = media.closest<HTMLAnchorElement>('a[href]') ?? media.parentElement;
  return fallback && !fallback.matches('body, html') ? fallback : null;
}
