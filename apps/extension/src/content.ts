import { SorareCardScanner } from './scanner.js';
import { hydrateCardPictureNames, hydrateCardPictureSlugs } from './dom.js';
import { supportsCompactViewPath } from './compact-view-route.js';
import {
  applyHistoricalAssistFallbackSettings,
  applyMarketBracketCompactView,
  applyMarketBracketSide,
  applyMarketValueFormat,
} from './overlay.js';
import {
  getCardPictureNames,
  getCardPictureSlugs,
  setCardPictureSlugs,
  getHistoricalAssistFallbackSettings,
  getMarketBracketCompactView,
  getMarketBracketSide,
  getMarketValueFormat,
  getOverlayEnabled,
  HISTORICAL_ASSIST_FALLBACK_ENABLED_KEY,
  HISTORICAL_ASSIST_WINDOW_KEY,
  MARKET_BRACKET_COMPACT_VIEW_KEY,
  MARKET_BRACKET_SIDE_KEY,
  MARKET_VALUE_FORMAT_KEY,
  normalizeMarketValueFormat,
  normalizeHistoricalAssistWindow,
  normalizeMarketBracketSide,
  OVERLAY_ENABLED_KEY,
  setCardPictureNames,
  type HistoricalAssistWindow,
} from './settings.js';

let rememberedCardPictureNames: Record<string, string> = {};
let rememberedCardPictureSlugs: Record<string, string> = {};
let pictureSlugSaveTimer: number | undefined;
let pictureNameSaveTimer: number | undefined;
const scanner = new SorareCardScanner(
  undefined,
  (entries): void => {
    for (const [pictureId, playerName] of Object.entries(entries)) {
      delete rememberedCardPictureNames[pictureId];
      rememberedCardPictureNames[pictureId] = playerName;
    }
    if (pictureNameSaveTimer !== undefined) {
      window.clearTimeout(pictureNameSaveTimer);
    }
    pictureNameSaveTimer = window.setTimeout(() => {
      pictureNameSaveTimer = undefined;
      void setCardPictureNames(rememberedCardPictureNames);
    }, 500);
  },
  undefined,
  (entries): void => {
    for (const [id, slug] of Object.entries(entries)) {
      delete rememberedCardPictureSlugs[id];
      rememberedCardPictureSlugs[id] = slug;
    }
    if (pictureSlugSaveTimer !== undefined) window.clearTimeout(pictureSlugSaveTimer);
    pictureSlugSaveTimer = window.setTimeout(() => {
      pictureSlugSaveTimer = undefined;
      void setCardPictureSlugs(rememberedCardPictureSlugs);
    }, 500);
  },
);
let enabled = false;
let compactViewEnabled = false;
let lastCompactViewPathname: string | undefined;
let lastCompactViewActive: boolean | undefined;
let historicalAssistEnabled = false;
let historicalAssistWindow: HistoricalAssistWindow = 15;

function syncCompactViewForCurrentRoute(): void {
  const pathname = window.location.pathname;
  const active = compactViewEnabled && supportsCompactViewPath(pathname);
  if (
    pathname === lastCompactViewPathname &&
    active === lastCompactViewActive
  ) {
    return;
  }
  lastCompactViewPathname = pathname;
  lastCompactViewActive = active;
  applyMarketBracketCompactView(active);
}

const compactViewRouteObserver = new MutationObserver(() => {
  syncCompactViewForCurrentRoute();
});
compactViewRouteObserver.observe(document.documentElement, {
  childList: true,
  subtree: true,
});
window.addEventListener('popstate', syncCompactViewForCurrentRoute);
window.addEventListener('hashchange', syncCompactViewForCurrentRoute);

function applyEnabled(nextEnabled: boolean): void {
  if (enabled === nextEnabled) return;
  enabled = nextEnabled;
  if (enabled) scanner.start();
  else scanner.stop();
}

void Promise.all([
  getOverlayEnabled(),
  getMarketBracketSide(),
  getMarketBracketCompactView(),
  getHistoricalAssistFallbackSettings(),
  getMarketValueFormat(),
  getCardPictureNames(),
  getCardPictureSlugs(),
]).then(
  ([
    nextEnabled,
    bracketSide,
    compactView,
    historicalAssistSettings,
    marketValueFormat,
    cardPictureNames,
    cardPictureSlugs,
  ]) => {
    rememberedCardPictureNames = cardPictureNames;
    hydrateCardPictureNames(cardPictureNames);
    rememberedCardPictureSlugs = cardPictureSlugs;
    hydrateCardPictureSlugs(cardPictureSlugs);
    applyMarketBracketSide(bracketSide);
    compactViewEnabled = compactView;
    syncCompactViewForCurrentRoute();
    historicalAssistEnabled = historicalAssistSettings.enabled;
    historicalAssistWindow = historicalAssistSettings.window;
    applyHistoricalAssistFallbackSettings(
      historicalAssistEnabled,
      historicalAssistWindow,
    );
    applyMarketValueFormat(marketValueFormat);
    scanner.configureHistoricalAssistFallback(
      historicalAssistEnabled,
      historicalAssistWindow,
    );
    applyEnabled(nextEnabled);
  },
);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  const enabledChange = changes[OVERLAY_ENABLED_KEY];
  if (enabledChange) applyEnabled(enabledChange.newValue !== false);
  const sideChange = changes[MARKET_BRACKET_SIDE_KEY];
  if (sideChange) {
    applyMarketBracketSide(normalizeMarketBracketSide(sideChange.newValue));
  }
  const compactViewChange = changes[MARKET_BRACKET_COMPACT_VIEW_KEY];
  if (compactViewChange) {
    compactViewEnabled = compactViewChange.newValue === true;
    syncCompactViewForCurrentRoute();
  }
  const historicalAssistEnabledChange =
    changes[HISTORICAL_ASSIST_FALLBACK_ENABLED_KEY];
  if (historicalAssistEnabledChange) {
    historicalAssistEnabled = historicalAssistEnabledChange.newValue === true;
    applyHistoricalAssistFallbackSettings(
      historicalAssistEnabled,
      historicalAssistWindow,
    );
    scanner.configureHistoricalAssistFallback(
      historicalAssistEnabled,
      historicalAssistWindow,
    );
  }
  const historicalAssistWindowChange = changes[HISTORICAL_ASSIST_WINDOW_KEY];
  if (historicalAssistWindowChange) {
    historicalAssistWindow = normalizeHistoricalAssistWindow(
      historicalAssistWindowChange.newValue,
    );
    applyHistoricalAssistFallbackSettings(
      historicalAssistEnabled,
      historicalAssistWindow,
    );
    scanner.configureHistoricalAssistFallback(
      historicalAssistEnabled,
      historicalAssistWindow,
    );
    scanner.refreshAllOverlays();
  }
  const marketValueFormatChange = changes[MARKET_VALUE_FORMAT_KEY];
  if (marketValueFormatChange) {
    applyMarketValueFormat(
      normalizeMarketValueFormat(marketValueFormatChange.newValue),
    );
    scanner.refreshAllOverlays();
  }
});
