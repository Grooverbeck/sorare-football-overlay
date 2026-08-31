import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { SorareGraphqlClient } from '../graphql/client.js';

describe('SorareGraphqlClient', () => {
  it('respects Retry-After on HTTP 429', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('', { status: 429, headers: { 'retry-after': '2' } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { value: 42 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const sleep = vi.fn(async () => undefined);
    const client = new SorareGraphqlClient({
      url: 'https://api.sorare.test/graphql',
      requestTimeoutMs: 1_000,
      maxRetries: 2,
      logger: pino({ level: 'silent' }),
      fetchImpl,
      sleep,
    });

    const result = await client.request<{ value: number }, Record<string, never>>(
      /* GraphQL */ `query Test { value }`,
      {},
    );

    expect(result).toEqual({ value: 42 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });
});
