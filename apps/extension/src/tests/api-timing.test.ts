import {afterEach, describe, expect, it, vi} from 'vitest';
import {fetchLineupSortValues} from '../api.js';
import type {LineupSortValuesWorkerResponse} from '../messages.js';

afterEach(() => {vi.useRealTimers(); vi.unstubAllGlobals();});

describe('compact request timing diagnostics', () => {
  it.each([60, 101])('separates the page round trip from %i ms spent in the extension worker', async workerDuration => {
    vi.useFakeTimers({toFake: ['performance', 'Date', 'setTimeout', 'clearTimeout']});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const sendMessage = vi.fn((_message, callback: (value: LineupSortValuesWorkerResponse) => void) => {
      setTimeout(() => callback({ok: true, requestId: 'sort-test', durationMs: workerDuration,
        value: {data: [], meta: {requested: 1, returned: 0, cacheHits: 0, source: 'sorare', durationMs: 10}}}), 100);
    });
    vi.stubGlobal('chrome', {runtime: {id: 'local-test', sendMessage}});
    const pending = fetchLineupSortValues({slugs: ['test-player']});
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    const logged = info.mock.calls.map(([message]) => JSON.parse(String(message).split('[StatsDiag] ')[1]!));
    expect(logged.find(event => event.stage === 'lineup-sort-response')).toMatchObject({
      durationMs: 100, backendDurationMs: 10, workerDurationMs: workerDuration,
      messageOverheadMs: Math.max(0, 100 - workerDuration),
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
