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
  CARD_PICTURE_SLUGS_KEY,
  CARD_PICTURE_NAMES_KEY,
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
  type HistoricalAssistWindow,
} from './settings.js';

let rememberedCardPictureNames: Record<string, string> = {};
let rememberedCardPictureSlugs: Record<string, string> = {};
let pictureNameSaveTimer: number | undefined;
let pendingPictureNames: Record<string,string> = {};
let pendingPictureSlugs: Record<string,string> = {};
let pictureSyncGeneration = 0;

function saveDiscoveredPictures(): void {
  if (pictureNameSaveTimer !== undefined) window.clearTimeout(pictureNameSaveTimer);
  pictureNameSaveTimer = window.setTimeout(() => {
    pictureNameSaveTimer = undefined;
    const payload = {names:{...pendingPictureNames}, slugs:{...pendingPictureSlugs}};
    void chrome.runtime.sendMessage({type:'REMEMBER_CARD_PICTURES', requestId:crypto.randomUUID(), payload})
      .then(reply => {
        if (!reply?.ok) throw new Error('Card identity storage failed');
        for (const [id, value] of Object.entries(payload.names)) {
          if (pendingPictureNames[id] === value) delete pendingPictureNames[id];
        }
        for (const [id, value] of Object.entries(payload.slugs)) {
          if (pendingPictureSlugs[id] === value) delete pendingPictureSlugs[id];
        }
      }).catch(() => {
        // Keep unsaved deltas for the next discovery, without a retry loop.
        console.warn('[Sorare Overlay] Karten-Zuordnungen konnten nicht gespeichert werden.');
      });
  }, 500);
}
const scanner = new SorareCardScanner(
  undefined,
  (entries): void => {
    Object.assign(pendingPictureNames, entries);
    saveDiscoveredPictures();
  },
  undefined,
  (entries): void => {
    Object.assign(pendingPictureSlugs, entries);
    saveDiscoveredPictures();
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
    // A newer cross-tab change can arrive while the initial settings load is
    // still pending. Do not replace it with the older startup snapshot.
    if (pictureSyncGeneration === 0) {
      rememberedCardPictureNames = cardPictureNames;
      hydrateCardPictureNames(cardPictureNames);
      rememberedCardPictureSlugs = cardPictureSlugs;
      hydrateCardPictureSlugs(cardPictureSlugs);
    }
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
  if (changes[CARD_PICTURE_NAMES_KEY] || changes[CARD_PICTURE_SLUGS_KEY]) {
    const generation = ++pictureSyncGeneration;
    void Promise.all([getCardPictureNames(), getCardPictureSlugs()]).then(([names, slugs]) => {
      if (generation !== pictureSyncGeneration) return;
      const added = new Set([
        ...Object.keys(names).filter(id => rememberedCardPictureNames[id] !== names[id]),
        ...Object.keys(slugs).filter(id => rememberedCardPictureSlugs[id] !== slugs[id]),
      ]);
      rememberedCardPictureNames = {...names, ...pendingPictureNames};
      rememberedCardPictureSlugs = {...slugs, ...pendingPictureSlugs};
      hydrateCardPictureNames(rememberedCardPictureNames);
      hydrateCardPictureSlugs(rememberedCardPictureSlugs);
      scanner.refreshRememberedCardPictures([...added]);
    }).catch(() => console.warn('[Sorare Overlay] Karten-Zuordnungen konnten nicht synchronisiert werden.'));
  }
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
