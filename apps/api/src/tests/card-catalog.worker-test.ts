import {env} from 'cloudflare:test';
import {beforeAll,beforeEach,expect,it} from 'vitest';
import {D1CardCatalogStore,cardCatalogPictureKey} from '../cloudflare/card-catalog-store.js';
import {emptyCardCatalogState} from '../services/card-catalog.js';

beforeAll(async()=>{await env.CACHE_DB.exec('CREATE TABLE IF NOT EXISTS cache_entries(cache_key TEXT PRIMARY KEY,value TEXT NOT NULL,expires_at INTEGER,updated_at INTEGER NOT NULL)');});
beforeEach(async()=>{await env.CACHE_DB.prepare('DELETE FROM cache_entries').run();});
const id='70f9f242-6638-4505-bf9d-9d8c40fe811a';
it('persists identities across Worker instances with one bulk insert',async()=>{
  const store=new D1CardCatalogStore(env.CACHE_DB), now=Date.now();
  expect(await store.acquire('owner',now)).toBe(true);
  expect(await store.acquire('second',now)).toBe(false);
  expect(await store.save('owner',emptyCardCatalogState(),[{pictureId:id,playerSlug:'right-player'}],now)).toBe(true);
  expect(await new D1CardCatalogStore(env.CACHE_DB).read([id])).toEqual([{pictureId:id,playerSlug:'right-player'}]);
});
it('fences expired owners and blocks conflicting picture identities',async()=>{
  const store=new D1CardCatalogStore(env.CACHE_DB), now=Date.now();
  await store.acquire('old',now-180000);
  await store.acquire('new',now);
  expect(await store.save('old',emptyCardCatalogState(),[{pictureId:id,playerSlug:'wrong'}],now)).toBe(false);
  expect(await store.read([id])).toEqual([]);
  await store.save('new',emptyCardCatalogState(),[{pictureId:id,playerSlug:'one'}],now);
  await store.save('new',emptyCardCatalogState(),[{pictureId:id,playerSlug:'two'}],now);
  await store.save('new',emptyCardCatalogState(),[{pictureId:id,playerSlug:'two'}],now);
  expect(await store.read([id])).toEqual([]);
});
it('ignores corrupt or key-mismatched stored mappings',async()=>{
  await env.CACHE_DB.prepare('INSERT INTO cache_entries VALUES(?,?,NULL,?)').bind(cardCatalogPictureKey(id),JSON.stringify({pictureId:'f0c4cd43-4ff1-4205-9ed2-01f97961c95d',playerSlug:'someone'}),1).run();
  expect(await new D1CardCatalogStore(env.CACHE_DB).read([id])).toEqual([]);
});
