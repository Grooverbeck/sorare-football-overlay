import {
  getHistoricalAssistFallbackSettings,
  getMarketBracketCompactView,
  getMarketBracketSide,
  getMarketValueFormat,
  getOverlayEnabled,
  setHistoricalAssistFallbackEnabled,
  setHistoricalAssistWindow,
  setMarketBracketCompactView,
  setMarketBracketSide,
  setMarketValueFormat,
  setOverlayEnabled,
  type HistoricalAssistWindow,
  type MarketBracketSide,
  type MarketValueFormat,
} from './settings.js';

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Overlay popup control is missing: ${selector}`);
  return element;
}

const toggle = requireElement<HTMLInputElement>('#overlay-enabled');
const status = requireElement<HTMLElement>('#overlay-status');
const localBackendStatus = requireElement<HTMLElement>('#local-backend-status');
const bracketSideInputs = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="market-bracket-side"]'),
);
const marketValueFormatInputs = Array.from(
  document.querySelectorAll<HTMLInputElement>(
    'input[name="market-value-format"]',
  ),
);
const compactViewToggle = requireElement<HTMLInputElement>(
  '#market-bracket-compact-view',
);
const historicalAssistToggle = requireElement<HTMLInputElement>(
  '#historical-assist-enabled',
);
const historicalAssistStatus = requireElement<HTMLElement>(
  '#historical-assist-status',
);
const historicalAssistWindows = requireElement<HTMLElement>(
  '#historical-assist-windows',
);
const historicalAssistWindowInputs = Array.from(
  document.querySelectorAll<HTMLInputElement>(
    'input[name="historical-assist-window"]',
  ),
);

function render(enabled: boolean): void {
  toggle.checked = enabled;
  status.textContent = enabled ? 'Overlay aktiviert' : 'Overlay deaktiviert';
  status.dataset.enabled = String(enabled);
}

void getOverlayEnabled().then(render);
void getMarketBracketSide().then((side) => {
  for (const input of bracketSideInputs) input.checked = input.value === side;
});
void getMarketValueFormat().then((format) => {
  for (const input of marketValueFormatInputs) {
    input.checked = input.value === format;
  }
});
void getMarketBracketCompactView().then((enabled) => {
  compactViewToggle.checked = enabled;
});
void getHistoricalAssistFallbackSettings().then(({ enabled, window }) => {
  renderHistoricalAssistSettings(enabled, window);
});

toggle.addEventListener('change', () => {
  const enabled = toggle.checked;
  render(enabled);
  void setOverlayEnabled(enabled);
});

for (const input of bracketSideInputs) {
  input.addEventListener('change', () => {
    if (!input.checked) return;
    void setMarketBracketSide(input.value as MarketBracketSide);
  });
}

for (const input of marketValueFormatInputs) {
  input.addEventListener('change', () => {
    if (!input.checked) return;
    void setMarketValueFormat(input.value as MarketValueFormat);
  });
}

compactViewToggle.addEventListener('change', () => {
  void setMarketBracketCompactView(compactViewToggle.checked);
});

function renderHistoricalAssistSettings(
  enabled: boolean,
  window: HistoricalAssistWindow,
): void {
  historicalAssistToggle.checked = enabled;
  historicalAssistStatus.textContent = 'Historische Werte verwenden';
  historicalAssistWindows.dataset.enabled = String(enabled);
  for (const input of historicalAssistWindowInputs) {
    input.checked = Number(input.value) === window;
    input.disabled = !enabled;
  }
}

historicalAssistToggle.addEventListener('change', () => {
  const enabled = historicalAssistToggle.checked;
  const selected =
    historicalAssistWindowInputs.find((input) => input.checked)?.value ?? '15';
  const window = Number(selected) as HistoricalAssistWindow;
  renderHistoricalAssistSettings(enabled, window);
  void setHistoricalAssistFallbackEnabled(enabled);
});

for (const input of historicalAssistWindowInputs) {
  input.addEventListener('change', () => {
    if (!input.checked) return;
    void setHistoricalAssistWindow(
      Number(input.value) as HistoricalAssistWindow,
    );
  });
}

function isLoopbackBackend(): boolean {
  const hostname = new URL(__API_BASE_URL__).hostname;
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname);
}

async function requestLocalBackendAccess(): Promise<void> {
  if (!isLoopbackBackend()) return;
  localBackendStatus.hidden = false;
  localBackendStatus.textContent = 'Lokales Backend wird verbunden …';
  try {
    const response = await fetch(`${__API_BASE_URL__}/health`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    localBackendStatus.dataset.connected = 'true';
    localBackendStatus.textContent = 'Lokales Backend verbunden';
  } catch (error) {
    console.warn('[Sorare Overlay] Local backend permission request failed:', error);
    localBackendStatus.dataset.connected = 'false';
    localBackendStatus.textContent = 'Lokaler Zugriff blockiert – bitte Freigabe erlauben';
  }
}

void requestLocalBackendAccess();
