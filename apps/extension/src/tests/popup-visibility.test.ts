import popupHtml from '../popup.html?raw';
import { afterEach, expect, it, vi } from 'vitest';
import { SQUAD_OVERLAY_ENABLED_KEY, LINEUPS_OVERLAY_ENABLED_KEY } from '../settings.js';

afterEach(() => {document.body.replaceChildren();vi.unstubAllGlobals();});

it('renders and saves both independent overview switches in the popup', async () => {
  document.documentElement.innerHTML = popupHtml;
  const set = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('__API_BASE_URL__','https://overlay.example');
  vi.stubGlobal('chrome',{storage:{local:{get:vi.fn(async defaults => defaults),set}}});
  await import('../popup.js');
  const squad = document.querySelector<HTMLInputElement>('#squad-overlay-enabled')!;
  const lineups = document.querySelector<HTMLInputElement>('#lineups-overlay-enabled')!;
  await vi.waitFor(() => expect(squad.checked && lineups.checked).toBe(true));
  squad.checked = false;
  squad.dispatchEvent(new Event('change'));
  lineups.checked = false;
  lineups.dispatchEvent(new Event('change'));
  expect(set.mock.calls).toEqual([
    [{[SQUAD_OVERLAY_ENABLED_KEY]:false}],
    [{[LINEUPS_OVERLAY_ENABLED_KEY]:false}],
  ]);
  expect(document.querySelector<HTMLInputElement>('#overlay-enabled')!.checked).toBe(true);
});
