import { getOverlayEnabled, setOverlayEnabled } from './settings.js';

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Overlay popup control is missing: ${selector}`);
  return element;
}

const toggle = requireElement<HTMLInputElement>('#overlay-enabled');
const status = requireElement<HTMLElement>('#overlay-status');

function render(enabled: boolean): void {
  toggle.checked = enabled;
  status.textContent = enabled ? 'Overlay aktiviert' : 'Overlay deaktiviert';
  status.dataset.enabled = String(enabled);
}

void getOverlayEnabled().then(render);

toggle.addEventListener('change', () => {
  const enabled = toggle.checked;
  render(enabled);
  void setOverlayEnabled(enabled);
});
