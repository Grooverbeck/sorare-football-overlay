import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OverlayView } from '../overlay.js';

let frames: FrameRequestCallback[];
let views: OverlayView[];
beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
  frames = [];
  views = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => {
  for (const view of views) view.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function tick(ms: number): void {
  vi.advanceTimersByTime(ms);
  while (frames.length) frames.shift()!(0);
}
function mount() {
  const card = document.createElement('button');
  card.dataset.sorareOverlayKey = 'pavlovic';
  card.innerHTML = '<img alt="Aleksandar Pavlović - common">';
  document.body.append(card);
  const image = card.querySelector('img')!;
  vi.spyOn(card,'getBoundingClientRect').mockReturnValue(new DOMRect(200,200,105,170));
  vi.spyOn(image,'getBoundingClientRect').mockReturnValue(new DOMRect(200,200,105,170));
  let exposed = false;
  Object.defineProperty(document,'elementFromPoint',{configurable:true,value:() => exposed ? image : document.documentElement});
  const view = new OverlayView(card,{playerName:'Aleksandar Pavlović'},'Midfielder');
  views.push(view);
  view.render({slug:'aleksandar-pavlovic',displayName:'Aleksandar Pavlović',position:'Midfielder',
    aaL10:{value:17,sampleSize:10},cleanSheetL10:{value:0,sampleSize:10},goalL10:{value:0.2,sampleSize:10},
    nextGame:null,excludedLowCoverage:0});
  return {view,image,show:() => {exposed=true;}};
}

it('restores a cached static card after an outgoing navigation layer disappears without DOM changes', () => {
  window.dispatchEvent(new PopStateEvent('popstate'));
  const {view,show} = mount();
  expect(view.host.style.display).toBe('none');
  const rendered = view.host.shadowRoot!.querySelector('.panel')!.innerHTML;
  tick(200);
  show(); // No resize, scroll, mutation or additional stats response follows.
  tick(400);
  expect(view.host.style.display).toBe('');
  expect(view.host.style.left).toBe('200px');
  expect(view.host.shadowRoot!.querySelector('.panel')!.innerHTML).toBe(rendered);
});

it('keeps genuinely covered cards hidden and stops checking after the finite budget', () => {
  const {view} = mount();
  const refresh = vi.spyOn(view,'refreshPositionNow');
  for (let i=0;i<40;i++) tick(100);
  expect(view.host.style.display).toBe('none');
  const count = refresh.mock.calls.length;
  expect(count).toBeLessThanOrEqual(6);
  tick(60_000);
  expect(refresh).toHaveBeenCalledTimes(count);
});

it('recovers on media load even after the mount retry budget has expired', () => {
  const {view,image,show} = mount();
  for (let i=0;i<40;i++) tick(100);
  show();
  image.dispatchEvent(new Event('load'));
  tick(20);
  expect(view.host.style.display).toBe('');
});

it('does not retry destroyed or offscreen views', () => {
  const {view} = mount();
  const refresh = vi.spyOn(view,'refreshPositionNow');
  view.setViewportPriorityActive(false);
  tick(5_000);
  expect(refresh).not.toHaveBeenCalled();
  view.destroy();
  window.dispatchEvent(new PopStateEvent('popstate'));
  tick(5_000);
  expect(refresh).not.toHaveBeenCalled();
});
