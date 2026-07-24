import { SorareCardScanner } from './scanner.js';
import { getOverlayEnabled, OVERLAY_ENABLED_KEY } from './settings.js';

const scanner = new SorareCardScanner();
let enabled = false;

function applyEnabled(nextEnabled: boolean): void {
  if (enabled === nextEnabled) return;
  enabled = nextEnabled;
  if (enabled) scanner.start();
  else scanner.stop();
}

void getOverlayEnabled().then(applyEnabled);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  const change = changes[OVERLAY_ENABLED_KEY];
  if (!change) return;
  applyEnabled(change.newValue !== false);
});
