export const OVERLAY_ENABLED_KEY = 'overlayEnabled';

export async function getOverlayEnabled(): Promise<boolean> {
  const stored = await chrome.storage.local.get({ [OVERLAY_ENABLED_KEY]: true });
  return stored[OVERLAY_ENABLED_KEY] !== false;
}

export async function setOverlayEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [OVERLAY_ENABLED_KEY]: enabled });
}
