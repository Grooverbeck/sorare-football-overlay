// Sorare Set cards can switch between an image, video and CSS foil layers.
// Keep discovery and sorting on the same physical-card definition.
export const sorareCardMediaSelector =
  'img[alt], img[src*="/cardsamplepicture/"], video[poster], [style*="--mask-shape"]';
export const sorareCardNamePattern = /^(.+?)\s+-\s+(?:common|limited|rare|super rare|unique)$/i;

export function cardPictureIdFromUrl(value: string): string | null {
  try {
    const url = new URL(value, location.href);
    return url.hostname === 'assets.sorare.com'
      ? url.pathname.match(/\/cardsamplepicture\/([a-z0-9-]+)\//i)?.[1]?.toLowerCase() ?? null
      : null;
  } catch { return null; }
}

export function extractCardPictureId(media: HTMLElement): string | null {
  if (media instanceof HTMLImageElement) {
    return cardPictureIdFromUrl(media.currentSrc || media.src);
  }
  if (media instanceof HTMLVideoElement) return cardPictureIdFromUrl(media.poster);
  const mask = media.style.getPropertyValue('--mask-shape').trim();
  const url = mask.match(/^url\(\s*["']?([^"')]+)["']?\s*\)$/)?.[1];
  return url ? cardPictureIdFromUrl(url) : null;
}

export function findSorareCardMedia(root: ParentNode): HTMLElement[] {
  const candidates = [
    ...(root instanceof HTMLElement && root.matches(sorareCardMediaSelector) ? [root] : []),
    ...root.querySelectorAll<HTMLElement>(sorareCardMediaSelector),
  ];
  return candidates.filter(media =>
    (media instanceof HTMLImageElement && sorareCardNamePattern.test(media.alt)) ||
    extractCardPictureId(media) !== null,
  );
}
