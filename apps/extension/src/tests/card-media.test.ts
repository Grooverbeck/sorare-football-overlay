import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractCardPictureId, findCardMediaContainer, findSorareCardMedia, hasSorareCardMedia } from '../card-media.js';

const url='https://assets.sorare.com/image-resize/cardsamplepicture/example-card/picture/card.png?width=160';
afterEach(()=>document.body.replaceChildren());

describe('persistent video card frames',()=>{
  it.each([
    '<img alt="Player - common">',
    `<video poster="${url}"></video>`,
    `<div style="--mask-image-src:url(${url})"></div>`,
    `<div style="--mask-image-src:url(${url})"><video poster="${url}"></video></div>`,
    `<div style="--mask-shape:url(${url})"></div>`,
    '<img alt="Team"><div role="progressbar" aria-busy="true"></div>',
    '<div style="--mask-image-src:url(https://example.com/cardsamplepicture/foreign/picture/a.png)"></div>',
    '<div style="--mask-image-src:none"></div>',
  ])('uses the same physical-card presence rule as full discovery: %s', markup => {
    document.body.innerHTML = markup;
    for (const root of [document, document.body, document.body.firstElementChild!]) {
      expect(hasSorareCardMedia(root)).toBe(findSorareCardMedia(root).length > 0);
    }
  });

  it('stops after the first recognized media instead of parsing every decorative layer', () => {
    document.body.innerHTML = `<article><img alt="Player - common"><video poster="${url}"></video></article>`;
    const poster = vi.spyOn(document.querySelector('video')!, 'poster', 'get');
    expect(hasSorareCardMedia(document.querySelector('article')!)).toBe(true);
    expect(poster).not.toHaveBeenCalled();
  });

  it('recognizes a picture-bearing frame while its video is absent',()=>{
    document.body.innerHTML=`<button><div style="--mask-image-src:url(${url})"><div></div></div></button>`;
    const frame=document.querySelector<HTMLElement>('div')!;
    expect(findSorareCardMedia(document)).toEqual([frame]);
    expect(findSorareCardMedia(frame)).toEqual([frame]);
    expect(extractCardPictureId(frame)).toBe('example-card');
    expect(findCardMediaContainer(frame)).toBe(document.querySelector('button'));
  });

  it.each(['video','image','foil'])('does not double count the frame alongside its %s',kind=>{
    const content=kind==='video'?`<video poster="${url.replace('160','320')}"></video>`:kind==='image'?`<img alt="Player - common" src="${url}">`:`<div style="--mask-shape:url('${url}')"></div>`;
    document.body.innerHTML=`<button><div data-frame style="--mask-image-src:url(${url})">${content}</div></button>`;
    const frame=document.querySelector<HTMLElement>('[data-frame]')!;
    const child=frame.firstElementChild as HTMLElement;
    expect(findSorareCardMedia(document)).toEqual([child]);
    child.remove();expect(findSorareCardMedia(document)).toEqual([frame]);
    frame.append(child);expect(findSorareCardMedia(document)).toEqual([child]);
  });

  it.each(['none','url(https://example.com/cardsamplepicture/foreign/picture/a.png)','url(https://assets.sorare.com/team/a/picture/a.png)'])('ignores non-card frame values: %s',value=>{
    const frame=document.createElement('div');frame.style.setProperty('--mask-image-src',value);document.body.append(frame);
    expect(findSorareCardMedia(document)).toEqual([]);expect(extractCardPictureId(frame)).toBeNull();
  });

  it('keeps different picture identities visible to ambiguity checks',()=>{
    document.body.innerHTML=`<div style="--mask-image-src:url(${url})"><video poster="${url.replace('example-card','different-card')}"></video></div>`;
    expect(findSorareCardMedia(document).map(extractCardPictureId)).toEqual(['example-card','different-card']);
  });

  it('keeps two real copies distinct and drops a genuinely removed card',()=>{
    document.body.innerHTML=`<button><div style="--mask-image-src:url(${url})"></div></button>`.repeat(2);
    expect(findSorareCardMedia(document)).toHaveLength(2);
    document.querySelector('button')!.remove();expect(findSorareCardMedia(document)).toHaveLength(1);
  });
});
