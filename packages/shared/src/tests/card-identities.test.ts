import {expect,it} from 'vitest';
import {CardIdentitiesRequestSchema,sorarePictureId} from '../card-identities.js';
const id='70f9f242-6638-4505-bf9d-9d8c40fe811a';
it('accepts only bounded picture IDs, not client-supplied player mappings',()=>{
  expect(CardIdentitiesRequestSchema.parse({pictureIds:[id,id.toUpperCase()]}).pictureIds).toEqual([id]);
  for(const input of [{pictureIds:[]},{pictureIds:Array(101).fill(id)},{pictureIds:['invalid']},{pictureIds:[id],playerSlug:'wrong'}]) expect(CardIdentitiesRequestSchema.safeParse(input).success).toBe(false);
});
it('extracts identities only from official HTTPS Sorare picture paths',()=>{
  expect(sorarePictureId(`https://assets.sorare.com/image-resize/cardsamplepicture/${id}/picture/a.png?width=80`)).toBe(id);
  for(const url of [`https://example.com/cardsamplepicture/${id}/picture/a.png`,`http://assets.sorare.com/cardsamplepicture/${id}/picture/a.png`,'invalid']) expect(sorarePictureId(url)).toBeNull();
});
