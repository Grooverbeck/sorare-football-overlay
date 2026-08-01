import { SorareCardScanner } from './scanner.js';
import { getExtensionApi } from './browser-api.js';
import { hydrateCardPictureNames } from './dom.js';
import {
  applyHistoricalAssistFallbackSettings,
  applyMarketBracketSide,
  applyMarketValueFormat,
} from './overlay.js';
import {
  getCardPictureNames,
  getHistoricalAssistFallbackSettings,
  getMarketBracketSide,
  getMarketValueFormat,
  getOverlayEnabled,
  HISTORICAL_ASSIST_FALLBACK_ENABLED_KEY,
  HISTORICAL_ASSIST_WINDOW_KEY,
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
);
let enabled = false;
let historicalAssistEnabled = false;
let historicalAssistWindow: HistoricalAssistWindow = 15;

function applyEnabled(nextEnabled: boolean): void {
  if (enabled === nextEnabled) return;
  enabled = nextEnabled;
  if (enabled) scanner.start();
  else scanner.stop();
}

void Promise.all([
  getOverlayEnabled(),
  getMarketBracketSide(),
  getHistoricalAssistFallbackSettings(),
  getMarketValueFormat(),
  getCardPictureNames(),
]).then(
  ([
    nextEnabled,
    bracketSide,
    historicalAssistSettings,
    marketValueFormat,
    cardPictureNames,
  ]) => {
    rememberedCardPictureNames = cardPictureNames;
    hydrateCardPictureNames(cardPictureNames);
    applyMarketBracketSide(bracketSide);
    historicalAssistEnabled = historicalAssistSettings.enabled;
    historicalAssistWindow = historicalAssistSettings.window;
    applyHistoricalAssistFallbackSettings(
      historicalAssistEnabled,
      historicalAssistWindow,
    );
    applyMarketValueFormat(marketValueFormat);
    scanner.configureHistoricalAssistFallback(historicalAssistEnabled);
    applyEnabled(nextEnabled);
  },
);

getExtensionApi().storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  const enabledChange = changes[OVERLAY_ENABLED_KEY];
  if (enabledChange) applyEnabled(enabledChange.newValue !== false);
  const sideChange = changes[MARKET_BRACKET_SIDE_KEY];
  if (sideChange) {
    applyMarketBracketSide(normalizeMarketBracketSide(sideChange.newValue));
  }
  const historicalAssistEnabledChange =
    changes[HISTORICAL_ASSIST_FALLBACK_ENABLED_KEY];
  if (historicalAssistEnabledChange) {
    historicalAssistEnabled = historicalAssistEnabledChange.newValue === true;
    applyHistoricalAssistFallbackSettings(
      historicalAssistEnabled,
      historicalAssistWindow,
    );
    scanner.configureHistoricalAssistFallback(historicalAssistEnabled);
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
