import { expect, it, vi } from 'vitest';
import { MAX_API_BODY_BYTES, readApiJson } from '../request-body.js';

it('rejects an advertised oversized body without parsing it', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({cancel});
  const init = {method:'POST',body,duplex:'half',headers:{'content-length':String(MAX_API_BODY_BYTES+1)}};
  await expect(readApiJson(new Request('https://test',init))).rejects.toMatchObject({status:413});
  expect(cancel).toHaveBeenCalledOnce();
});
it('decodes multibyte text even when each UTF-8 byte arrives separately', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({name:'João ⚽'}));
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({pull(controller) {
    if (offset === bytes.length) controller.close();
    else controller.enqueue(bytes.slice(offset,++offset));
  }});
  const init = {method:'POST',body,duplex:'half'};
  await expect(readApiJson(new Request('https://test',init))).resolves.toEqual({name:'João ⚽'});
});
