export type ExtensionTarget = 'chromium' | 'firefox';

type ExtensionApi = typeof chrome;
export type ExtensionGlobals = typeof globalThis & {
  browser?: ExtensionApi;
  chrome?: ExtensionApi;
};

export function selectExtensionApi(
  target: ExtensionTarget,
  globals: Pick<ExtensionGlobals, 'browser' | 'chrome'>,
): ExtensionApi {
  const api = target === 'firefox' ? globals.browser ?? globals.chrome : globals.chrome;
  if (!api) {
    throw new Error(`Extension API is unavailable for ${target}`);
  }
  return api;
}

export function getExtensionApi(): ExtensionApi {
  return selectExtensionApi(
    __EXTENSION_BROWSER__,
    globalThis as ExtensionGlobals,
  );
}

export async function sendRuntimeMessageForTarget<TResponse>(
  target: ExtensionTarget,
  message: unknown,
  globals: Pick<ExtensionGlobals, 'browser' | 'chrome'> = globalThis as ExtensionGlobals,
): Promise<TResponse> {
  const api = selectExtensionApi(target, globals);
  if (target === 'firefox') {
    return (await api.runtime.sendMessage(message)) as TResponse;
  }

  return new Promise<TResponse>((resolve, reject) => {
    const runtime = api.runtime;
    runtime.sendMessage(message, (response: TResponse) => {
      const runtimeError = runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      if (response === undefined) {
        reject(new Error('Chromium runtime message returned no response'));
        return;
      }
      resolve(response);
    });
  });
}

export function sendRuntimeMessage<TResponse>(message: unknown): Promise<TResponse> {
  return sendRuntimeMessageForTarget(__EXTENSION_BROWSER__, message);
}

export function registerRuntimeMessageHandlerForTarget<TResponse>(
  target: ExtensionTarget,
  handler: (
    message: unknown,
    sender: chrome.runtime.MessageSender,
  ) => Promise<TResponse>,
  globals: Pick<ExtensionGlobals, 'browser' | 'chrome'> = globalThis as ExtensionGlobals,
): void {
  const api = selectExtensionApi(target, globals);
  if (target === 'firefox') {
    const runtime = api.runtime as unknown as {
      onMessage: {
        addListener(
          listener: (
            message: unknown,
            sender: chrome.runtime.MessageSender,
          ) => Promise<TResponse>,
        ): void;
      };
    };
    runtime.onMessage.addListener((message, sender) =>
      handler(message, sender),
    );
    return;
  }

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void Promise.resolve()
      .then(() => handler(message, sender))
      .then(
        (response) => sendResponse(response),
        (error: unknown) => {
          const message =
            error instanceof Error ? error.message : 'Unknown runtime handler error';
          console.warn('[Sorare Overlay] Chromium runtime handler failed:', message);
          // Do not send a response after a handler rejection. Chrome will
          // close the response channel and expose runtime.lastError to the
          // sender, which rejects sendRuntimeMessageForTarget accordingly.
        },
      );
    return true;
  });
}

export function registerRuntimeMessageHandler<TResponse>(
  handler: (
    message: unknown,
    sender: chrome.runtime.MessageSender,
  ) => Promise<TResponse>,
): void {
  registerRuntimeMessageHandlerForTarget(__EXTENSION_BROWSER__, handler);
}
