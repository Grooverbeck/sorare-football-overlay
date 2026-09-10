import { CARD_PICTURE_NAMES_KEY, CARD_PICTURE_SLUGS_KEY } from './settings.js';

export interface CardPictureUpdates {
  names?: Record<string, string>;
  slugs?: Record<string, string>;
}
const limit = 2000;
export function validCardPictureUpdates(value: unknown): value is CardPictureUpdates {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([field, entries]) => {
    if (!['names', 'slugs'].includes(field) || !entries || typeof entries !== 'object' || Array.isArray(entries)) return false;
    const rows = Object.entries(entries);
    return rows.length <= limit && rows.every(([id, text]) =>
      id.length <= 160 && /^[a-z0-9-]+$/i.test(id) && typeof text === 'string' &&
      text.trim().length > 0 && text.length <= (field === 'slugs' ? 160 : 120) &&
      (field !== 'slugs' || /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(text)));
  });
}

// Only the extension background worker writes learned identities. Serialize
// read/merge/write across tabs so stale tab snapshots cannot erase each other.
let pendingWrite: Promise<void> = Promise.resolve();
export function mergeCardPictureUpdates(updates: CardPictureUpdates): Promise<void> {
  const write = pendingWrite.then(async () => {
    const keys = [CARD_PICTURE_NAMES_KEY, CARD_PICTURE_SLUGS_KEY];
    const stored = await chrome.storage.local.get(keys);
    const output: Record<string, Record<string, string>> = {};
    for (const [field, key] of [['names',keys[0]!], ['slugs',keys[1]!]] as const) {
      const incoming = updates[field];
      if (!incoming || Object.keys(incoming).length === 0) continue;
      const merged: Record<string,string> = {};
      const previous = stored[key];
      if (previous && typeof previous === 'object' && !Array.isArray(previous)) {
        for (const [id, value] of Object.entries(previous)) {
          if (validCardPictureUpdates({[field]: {[id]:value}})) merged[id] = value as string;
        }
      }
      for (const [id, value] of Object.entries(incoming)) {
        delete merged[id];
        merged[id] = value;
      }
      output[key] = Object.fromEntries(Object.entries(merged).slice(-limit));
    }
    if (Object.keys(output).length) await chrome.storage.local.set(output);
  });
  pendingWrite = write.catch(() => undefined);
  return write;
}
