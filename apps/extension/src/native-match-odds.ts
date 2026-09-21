const nativeMatchOddsAttribute = 'data-sorare-overlay-native-match-odds';
const owners = new WeakMap<HTMLElement, Set<NativeMatchOddsReplacement>>();

function nativeMatchOddsForRow(teamRow: HTMLElement): HTMLElement | null {
  const button = teamRow.closest('button, [role="button"]');
  if (!button || button.querySelectorAll('[aria-label="Team"]').length !== 2) return null;
  const candidate = button.nextElementSibling;
  if (!(candidate instanceof HTMLDivElement) || candidate.childElementCount !== 1) return null;
  const bar = candidate.firstElementChild;
  if (!(bar instanceof HTMLElement)) return null;
  // Sorare's native three-way odds strip is a non-interactive sibling of the
  // card's stats button. Use its semantic shape, not generated CSS classes.
  if (!['--c-left-color', '--c-right-color'].some(property =>
    /^var\(--c-score-[\w-]+\)$/.test(bar.style.getPropertyValue(property).trim()),
  )) return null;
  if (candidate.querySelector('a, button, input, select, [role="button"], [data-sorare-overlay-companion]')) return null;
  const cells = [...bar.children];
  if (cells.length !== 3) return null;
  const values = cells.map(cell => {
    const text = cell.textContent?.trim() ?? '';
    if (!/^\d{1,3}(?:[.,]\d+)?\s*%?$/.test(text) || cell.querySelectorAll('svg').length !== 1) return NaN;
    return Number(text.replace('%', '').trim().replace(',', '.'));
  });
  if (values.some(value => !Number.isFinite(value) || value < 0 || value > 100)) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return total >= 98 && total <= 102 ? candidate : null;
}

/** CSS hides the marked strip only while a ready replacement is attached.
 * Keeping that condition independent of viewport/occlusion prevents scroll
 * oscillation when our bar temporarily becomes invisible but reserves space.
 */
export class NativeMatchOddsReplacement {
  private current: HTMLElement | null = null;

  update(teamRow: HTMLElement): void {
    const candidate = nativeMatchOddsForRow(teamRow);
    if (candidate === this.current) return;
    this.clear();
    if (!candidate) return;
    this.current = candidate;
    const views = owners.get(candidate) ?? new Set<NativeMatchOddsReplacement>();
    views.add(this);
    owners.set(candidate, views);
    candidate.setAttribute(nativeMatchOddsAttribute, 'true');
  }

  clear(): void {
    if (!this.current) return;
    const views = owners.get(this.current);
    views?.delete(this);
    if (!views?.size) {
      this.current.removeAttribute(nativeMatchOddsAttribute);
      owners.delete(this.current);
    }
    this.current = null;
  }
}
