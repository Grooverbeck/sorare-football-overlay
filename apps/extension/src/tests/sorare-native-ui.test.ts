import { afterEach, describe, expect, it } from 'vitest';
import {
  clearNativeSorareLineupProbabilityDecorations,
  decorateNativeSorareLineupProbabilities,
} from '../sorare-native-ui.js';

function nativeLineupBadge(percentage: number): string {
  return `
    <div data-card-shell>
      <img
        alt="Test Player - common"
        src="https://assets.sorare.com/image-resize/cardsamplepicture/test-card/picture/card.png"
      >
      <div>
        <span type="button" aria-haspopup="dialog" aria-expanded="false">
          <div style="--bg: var(--c-onBase-success)">
            <div>
              <svg viewBox="0 0 16 15"></svg>
              <p>${percentage}&nbsp;%</p>
            </div>
            <div></div>
          </div>
        </span>
      </div>
    </div>
  `;
}

describe('native Sorare lineup probability decoration', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('marks the semantic Sorare badge without relying on generated classes', () => {
    document.body.innerHTML = nativeLineupBadge(80);

    decorateNativeSorareLineupProbabilities(document);

    const trigger = document.querySelector(
      '[data-sorare-overlay-native-lineup="true"]',
    );
    const surface = document.querySelector(
      '[data-sorare-overlay-native-lineup-surface="true"]',
    );
    expect(trigger).not.toBeNull();
    expect(surface?.getAttribute('data-sorare-overlay-native-lineup-tone')).toBe(
      'strong',
    );
    expect(
      document.querySelector('[data-sorare-overlay-native-lineup-icon="true"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-sorare-overlay-native-lineup-value="true"]')
        ?.textContent,
    ).toContain('80');
  });

  it('updates the tone when Sorare changes the percentage in place', () => {
    document.body.innerHTML = nativeLineupBadge(60);
    decorateNativeSorareLineupProbabilities(document);
    const value = document.querySelector('p');
    expect(value).not.toBeNull();

    value!.textContent = '90 %';
    decorateNativeSorareLineupProbabilities(value!);

    expect(
      document
        .querySelector('[data-sorare-overlay-native-lineup-surface="true"]')
        ?.getAttribute('data-sorare-overlay-native-lineup-tone'),
    ).toBe('elite');
  });

  it('ignores percentages that are not attached to a Sorare card', () => {
    document.body.innerHTML = `
      <span type="button" aria-haspopup="dialog">
        <div style="--bg: green">
          <div><svg></svg><p>90 %</p></div>
          <div></div>
        </div>
      </span>
    `;

    decorateNativeSorareLineupProbabilities(document);

    expect(
      document.querySelector('[data-sorare-overlay-native-lineup]'),
    ).toBeNull();
  });

  it('removes every marker when the overlay is disabled', () => {
    document.body.innerHTML = nativeLineupBadge(70);
    decorateNativeSorareLineupProbabilities(document);

    clearNativeSorareLineupProbabilityDecorations();

    expect(
      document.querySelector('[data-sorare-overlay-native-lineup]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-sorare-overlay-native-lineup-surface]'),
    ).toBeNull();
  });
});
