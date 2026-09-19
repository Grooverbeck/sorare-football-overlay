import {readFileSync} from 'node:fs';
import {afterEach, describe, expect, it} from 'vitest';
import {decorateNativeSorareLineupProbabilities, clearNativeSorareLineupProbabilityDecorations} from '../sorare-native-ui.js';

const marker = 'data-sorare-overlay-native-grade-hidden';
const url = 'https://assets.sorare.com/cardsamplepicture/test-card/picture/card.png';
function markup(letter = 'A', media = `<img alt="Test Player - common" src="${url}">`) {
  return `<section data-card-shell>${media}<div data-badges>
    <span type="button" aria-haspopup="dialog"><div style="--bg:var(--c-onBase-success)"><div><svg></svg><p>80&nbsp;%</p></div><div></div></div></span>
    <div data-grade style="--bg:var(--c-score-high)"><div><div data-label>${letter}</div></div><div></div></div>
    </div><button data-captain><div title="Kapitän" style="--size:16px">C</div></button></section>`;
}
afterEach(() => {document.body.replaceChildren(); document.querySelector('[data-test-grade-style]')?.remove();});

describe('native Sorare letter grades', () => {
  it.each(['A', 'B', 'C', 'D', 'E', 'F'])('hides only grade %s, retaining the probability and captain control', letter => {
    document.body.innerHTML = markup(letter);
    const grade = document.querySelector('[data-grade]')!;
    decorateNativeSorareLineupProbabilities(document);
    expect(grade.getAttribute(marker)).toBe('true');
    expect(document.querySelectorAll(`[${marker}]`)).toHaveLength(1);
    expect(document.querySelector('p')?.textContent).toContain('80');
    expect(document.querySelector('[data-captain]')?.textContent).toBe('C');
    expect(document.querySelector('[data-captain]')?.hasAttribute(marker)).toBe(false);
    expect(grade.isConnected).toBe(true);
  });

  it.each([
    `<video poster="${url}"></video>`,
    `<div style="--mask-image-src:url(${url})"></div>`,
  ])('also recognizes grade badges beside video and unloaded card frames', media => {
    document.body.innerHTML = markup('B', media);
    decorateNativeSorareLineupProbabilities(document);
    expect(document.querySelector('[data-grade]')?.getAttribute(marker)).toBe('true');
  });

  it('works on a newly added badge subtree and removes its marker when the node is repurposed', () => {
    document.body.innerHTML = markup('C');
    const label = document.querySelector<HTMLElement>('[data-label]')!;
    decorateNativeSorareLineupProbabilities(label);
    expect(document.querySelector('[data-grade]')?.getAttribute(marker)).toBe('true');
    label.textContent = 'CS';
    decorateNativeSorareLineupProbabilities(label);
    expect(document.querySelector('[data-grade]')?.hasAttribute(marker)).toBe(false);
  });

  it('does not hide numeric scores, unrelated letter labels or grades outside card context', () => {
    document.body.innerHTML = markup('62') + markup('A', '') +
      '<section><img alt="Other Player - common"><div style="--bg:var(--c-score-high)">A</div></section>';
    decorateNativeSorareLineupProbabilities(document);
    expect(document.querySelector(`[${marker}]`)).toBeNull();
  });

  it('uses reversible CSS and restores the identical Sorare node when the overlay is disabled', () => {
    const style = document.createElement('style');
    style.dataset.testGradeStyle = 'true';
    style.textContent = readFileSync('src/sorare-native.css', 'utf8');
    document.head.append(style);
    document.body.innerHTML = markup('A');
    const grade = document.querySelector<HTMLElement>('[data-grade]')!;
    const original = grade.outerHTML;
    decorateNativeSorareLineupProbabilities(document);
    expect(getComputedStyle(grade).display).toBe('none');
    clearNativeSorareLineupProbabilityDecorations();
    expect(grade.outerHTML).toBe(original);
    expect(getComputedStyle(grade).display).not.toBe('none');
  });
});
