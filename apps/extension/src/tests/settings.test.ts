import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getOverlayEnabled,
  OVERLAY_ENABLED_KEY,
  setOverlayEnabled,
} from '../settings.js';

describe('overlay settings', () => {
  const get = vi.fn();
  const set = vi.fn();

  beforeEach(() => {
    get.mockReset();
    set.mockReset();
    vi.stubGlobal('chrome', { storage: { local: { get, set } } });
  });

  it('defaults the overlay to enabled', async () => {
    get.mockResolvedValue({ [OVERLAY_ENABLED_KEY]: true });

    await expect(getOverlayEnabled()).resolves.toBe(true);
    expect(get).toHaveBeenCalledWith({ [OVERLAY_ENABLED_KEY]: true });
  });

  it('persists the disabled state', async () => {
    set.mockResolvedValue(undefined);

    await setOverlayEnabled(false);
    expect(set).toHaveBeenCalledWith({ [OVERLAY_ENABLED_KEY]: false });
  });
});
