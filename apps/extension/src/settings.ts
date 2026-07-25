export const OVERLAY_ENABLED_KEY = 'overlayEnabled';
export const MARKET_BRACKET_SIDE_KEY = 'marketBracketSide';
export const HISTORICAL_ASSIST_FALLBACK_ENABLED_KEY =
  'historicalAssistFallbackEnabled';
export const HISTORICAL_ASSIST_WINDOW_KEY = 'historicalAssistWindow';
export const MARKET_VALUE_FORMAT_KEY = 'marketValueFormat';
export const CARD_PICTURE_NAMES_KEY = 'cardPictureNamesV1';
export type MarketBracketSide = 'left' | 'right';
export type HistoricalAssistWindow = 10 | 15 | 40;
export type MarketValueFormat = 'percentage' | 'decimal';
const maxRememberedCardPictures = 2_000;

export async function getOverlayEnabled(): Promise<boolean> {
  const stored = await chrome.storage.local.get({ [OVERLAY_ENABLED_KEY]: true });
  return stored[OVERLAY_ENABLED_KEY] !== false;
}

export async function setOverlayEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [OVERLAY_ENABLED_KEY]: enabled });
}

export function normalizeMarketBracketSide(value: unknown): MarketBracketSide {
  return value === 'left' ? 'left' : 'right';
}

export async function getMarketBracketSide(): Promise<MarketBracketSide> {
  const stored = await chrome.storage.local.get({
    [MARKET_BRACKET_SIDE_KEY]: 'right',
  });
  return normalizeMarketBracketSide(stored[MARKET_BRACKET_SIDE_KEY]);
}

export async function setMarketBracketSide(
  side: MarketBracketSide,
): Promise<void> {
  await chrome.storage.local.set({ [MARKET_BRACKET_SIDE_KEY]: side });
}

export function normalizeHistoricalAssistWindow(
  value: unknown,
): HistoricalAssistWindow {
  return value === 10 || value === 40 ? value : 15;
}

export async function getHistoricalAssistFallbackSettings(): Promise<{
  enabled: boolean;
  window: HistoricalAssistWindow;
}> {
  const stored = await chrome.storage.local.get({
    [HISTORICAL_ASSIST_FALLBACK_ENABLED_KEY]: false,
    [HISTORICAL_ASSIST_WINDOW_KEY]: 15,
  });
  return {
    enabled: stored[HISTORICAL_ASSIST_FALLBACK_ENABLED_KEY] === true,
    window: normalizeHistoricalAssistWindow(
      stored[HISTORICAL_ASSIST_WINDOW_KEY],
    ),
  };
}

export async function setHistoricalAssistFallbackEnabled(
  enabled: boolean,
): Promise<void> {
  await chrome.storage.local.set({
    [HISTORICAL_ASSIST_FALLBACK_ENABLED_KEY]: enabled,
  });
}

export async function setHistoricalAssistWindow(
  window: HistoricalAssistWindow,
): Promise<void> {
  await chrome.storage.local.set({ [HISTORICAL_ASSIST_WINDOW_KEY]: window });
}

export function normalizeMarketValueFormat(
  value: unknown,
): MarketValueFormat {
  return value === 'decimal' ? 'decimal' : 'percentage';
}

export async function getMarketValueFormat(): Promise<MarketValueFormat> {
  const stored = await chrome.storage.local.get({
    [MARKET_VALUE_FORMAT_KEY]: 'percentage',
  });
  return normalizeMarketValueFormat(stored[MARKET_VALUE_FORMAT_KEY]);
}

export async function setMarketValueFormat(
  format: MarketValueFormat,
): Promise<void> {
  await chrome.storage.local.set({ [MARKET_VALUE_FORMAT_KEY]: format });
}

export async function getCardPictureNames(): Promise<Record<string, string>> {
  const stored = await chrome.storage.local.get({
    [CARD_PICTURE_NAMES_KEY]: {},
  });
  const value = stored[CARD_PICTURE_NAMES_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] =>
        /^[a-z0-9-]+$/i.test(entry[0]) &&
        typeof entry[1] === 'string' &&
        entry[1].trim().length > 0,
    ),
  );
}

export async function setCardPictureNames(
  entries: Readonly<Record<string, string>>,
): Promise<void> {
  const trimmed = Object.fromEntries(
    Object.entries(entries).slice(-maxRememberedCardPictures),
  );
  await chrome.storage.local.set({ [CARD_PICTURE_NAMES_KEY]: trimmed });
}
