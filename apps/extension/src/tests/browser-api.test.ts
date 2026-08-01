import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getExtensionApi,
  registerRuntimeMessageHandler,
  registerRuntimeMessageHandlerForTarget,
  selectExtensionApi,
  sendRuntimeMessage,
  sendRuntimeMessageForTarget,
} from '../browser-api.js';

describe('cross-browser extension API', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('selects the Chromium namespace for the Chromium target', () => {
    const chromeApi = { marker: 'chrome' } as unknown as typeof chrome;
    const firefoxApi = { marker: 'browser' } as unknown as typeof chrome;

    expect(
      selectExtensionApi('chromium', {
        chrome: chromeApi,
        browser: firefoxApi,
      }),
    ).toBe(chromeApi);
  });

  it('selects Firefox browser promises when the Firefox target is built', () => {
    const chromeApi = { marker: 'chrome' } as unknown as typeof chrome;
    const firefoxApi = { marker: 'browser' } as unknown as typeof chrome;

    expect(
      selectExtensionApi('firefox', {
        chrome: chromeApi,
        browser: firefoxApi,
      }),
    ).toBe(firefoxApi);
    expect(
      selectExtensionApi('firefox', { chrome: chromeApi }),
    ).toBe(chromeApi);
  });

  it('uses the callback-compatible Chromium message path', async () => {
    const sendMessage = vi.fn((
      _message: unknown,
      callback: (response: unknown) => void,
    ) => callback({ ok: true }));
    vi.stubGlobal('chrome', {
      runtime: { sendMessage, lastError: undefined },
    });

    await expect(sendRuntimeMessage({ type: 'TEST' })).resolves.toEqual({
      ok: true,
    });
    expect(sendMessage).toHaveBeenCalledWith(
      { type: 'TEST' },
      expect.any(Function),
    );
  });

  it('rejects when Chromium returns no response', async () => {
    const sendMessage = vi.fn(
      (_message: unknown, callback: (response: unknown) => void) =>
        callback(undefined),
    );
    vi.stubGlobal('chrome', {
      runtime: { sendMessage, lastError: undefined },
    });

    await expect(sendRuntimeMessage({ type: 'TEST' })).rejects.toThrow(
      'Chromium runtime message returned no response',
    );
  });

  it('keeps the asynchronous handler response open for Chromium', async () => {
    const addListener = vi.fn();
    vi.stubGlobal('chrome', {
      runtime: {
        onMessage: { addListener },
      },
    });
    const handler = vi.fn(async () => ({ ok: true }));

    registerRuntimeMessageHandler(handler);

    const listener = addListener.mock.calls[0]?.[0] as (
      message: unknown,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response: unknown) => void,
    ) => boolean;
    const sendResponse = vi.fn();
    expect(listener({ type: 'TEST' }, {}, sendResponse)).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
  });

  it('uses Firefox promise messaging and listener responses', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true }));
    const addListener = vi.fn();
    const firefoxApi = {
      runtime: {
        sendMessage,
        onMessage: { addListener },
      },
    } as unknown as typeof chrome;
    const globals = { browser: firefoxApi };

    await expect(
      sendRuntimeMessageForTarget('firefox', { type: 'TEST' }, globals),
    ).resolves.toEqual({ ok: true });
    expect(sendMessage).toHaveBeenCalledWith({ type: 'TEST' });

    const handler = vi.fn(async () => ({ ok: true }));
    registerRuntimeMessageHandlerForTarget('firefox', handler, globals);
    const listener = addListener.mock.calls[0]?.[0] as (
      message: unknown,
      sender: chrome.runtime.MessageSender,
    ) => Promise<unknown>;
    await expect(listener({ type: 'TEST' }, {})).resolves.toEqual({ ok: true });
  });

  it('reports a missing API namespace clearly', () => {
    expect(() => getExtensionApi()).toThrow(
      'Extension API is unavailable for chromium',
    );
  });
});
