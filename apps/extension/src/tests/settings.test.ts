import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CARD_PICTURE_NAMES_KEY,
  getCardPictureNames,
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
  setHistoricalAssistFallbackEnabled,
  setHistoricalAssistWindow,
  setMarketBracketCompactView,
  setMarketBracketSide,
  setMarketValueFormat,
  setCardPictureNames,
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

  it('defaults the market bracket to the right side', async () => {
    get.mockResolvedValue({ [MARKET_BRACKET_SIDE_KEY]: 'right' });

    await expect(getMarketBracketSide()).resolves.toBe('right');
    expect(get).toHaveBeenCalledWith({ [MARKET_BRACKET_SIDE_KEY]: 'right' });
  });

  it('persists a left-side market bracket', async () => {
    set.mockResolvedValue(undefined);

    await setMarketBracketSide('left');
    expect(set).toHaveBeenCalledWith({ [MARKET_BRACKET_SIDE_KEY]: 'left' });
  });

  it('defaults the compact bracket view to disabled', async () => {
    get.mockResolvedValue({ [MARKET_BRACKET_COMPACT_VIEW_KEY]: false });

    await expect(getMarketBracketCompactView()).resolves.toBe(false);
    expect(get).toHaveBeenCalledWith({
      [MARKET_BRACKET_COMPACT_VIEW_KEY]: false,
    });
  });

  it('persists the compact bracket view', async () => {
    set.mockResolvedValue(undefined);

    await setMarketBracketCompactView(true);
    expect(set).toHaveBeenCalledWith({
      [MARKET_BRACKET_COMPACT_VIEW_KEY]: true,
    });
  });

  it('normalizes unknown market bracket settings to the right side', () => {
    expect(normalizeMarketBracketSide('left')).toBe('left');
    expect(normalizeMarketBracketSide('right')).toBe('right');
    expect(normalizeMarketBracketSide('invalid')).toBe('right');
    expect(normalizeMarketBracketSide(undefined)).toBe('right');
  });

  it('defaults the historical assist fallback to off and L15', async () => {
    get.mockResolvedValue({
      [HISTORICAL_ASSIST_FALLBACK_ENABLED_KEY]: false,
      [HISTORICAL_ASSIST_WINDOW_KEY]: 15,
    });

    await expect(getHistoricalAssistFallbackSettings()).resolves.toEqual({
      enabled: false,
      window: 15,
    });
    expect(get).toHaveBeenCalledWith({
      [HISTORICAL_ASSIST_FALLBACK_ENABLED_KEY]: false,
      [HISTORICAL_ASSIST_WINDOW_KEY]: 15,
    });
  });

  it('persists the historical assist fallback and window', async () => {
    set.mockResolvedValue(undefined);

    await setHistoricalAssistFallbackEnabled(true);
    await setHistoricalAssistWindow(40);

    expect(set).toHaveBeenNthCalledWith(1, {
      [HISTORICAL_ASSIST_FALLBACK_ENABLED_KEY]: true,
    });
    expect(set).toHaveBeenNthCalledWith(2, {
      [HISTORICAL_ASSIST_WINDOW_KEY]: 40,
    });
  });

  it('normalizes historical assist windows to L15', () => {
    expect(normalizeHistoricalAssistWindow(10)).toBe(10);
    expect(normalizeHistoricalAssistWindow(15)).toBe(15);
    expect(normalizeHistoricalAssistWindow(40)).toBe(40);
    expect(normalizeHistoricalAssistWindow(20)).toBe(15);
    expect(normalizeHistoricalAssistWindow('40')).toBe(15);
  });

  it('defaults market values to percentages and persists decimal odds', async () => {
    get.mockResolvedValue({ [MARKET_VALUE_FORMAT_KEY]: 'percentage' });
    set.mockResolvedValue(undefined);

    await expect(getMarketValueFormat()).resolves.toBe('percentage');
    await setMarketValueFormat('decimal');

    expect(get).toHaveBeenCalledWith({
      [MARKET_VALUE_FORMAT_KEY]: 'percentage',
    });
    expect(set).toHaveBeenCalledWith({
      [MARKET_VALUE_FORMAT_KEY]: 'decimal',
    });
  });

  it('normalizes unknown market value formats to percentages', () => {
    expect(normalizeMarketValueFormat('decimal')).toBe('decimal');
    expect(normalizeMarketValueFormat('percentage')).toBe('percentage');
    expect(normalizeMarketValueFormat('odds')).toBe('percentage');
  });

  it('loads and validates remembered card picture names', async () => {
    get.mockResolvedValue({
      [CARD_PICTURE_NAMES_KEY]: {
        'picture-1': 'Mamadou Fofana',
        invalid: 42,
      },
    });

    await expect(getCardPictureNames()).resolves.toEqual({
      'picture-1': 'Mamadou Fofana',
    });
  });

  it('persists remembered card picture names locally', async () => {
    set.mockResolvedValue(undefined);

    await setCardPictureNames({ 'picture-1': 'Mamadou Fofana' });
    expect(set).toHaveBeenCalledWith({
      [CARD_PICTURE_NAMES_KEY]: {
        'picture-1': 'Mamadou Fofana',
      },
    });
  });
});
