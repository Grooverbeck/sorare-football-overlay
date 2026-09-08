import { AppError } from './errors.js';

export const MAX_API_BODY_BYTES = 256 * 1024;

/** Count actual bytes even when Content-Length is absent or inaccurate. */
export async function readApiJson(request: Request): Promise<unknown> {
  const tooLarge = () => new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds 256 KiB');
  const declared = request.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_API_BODY_BYTES) {
    void request.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    if (reader) {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_API_BODY_BYTES) {
          void reader.cancel().catch(() => undefined);
          throw tooLarge();
        }
        text += decoder.decode(value, {stream: true});
      }
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, 'INVALID_JSON', 'Request body must be valid JSON');
  } finally {
    reader?.releaseLock();
  }
}
