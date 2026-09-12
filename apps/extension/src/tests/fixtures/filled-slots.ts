// Sorare's filled slot selectors have no text: their accessible label names
// the player. Footer, remove and captain controls are separate buttons.
export function filledSlotsMarkup(active = 3): string {
  return `<div class="FOOTBALL spread slots5 smartWidth">${[
    'Mio Backhaus', 'Marc Cucurella', 'Nadiem Amiri', 'Igor Matanović', 'Joane Gadou',
  ].map((name, index) => `<div><div>
    <button type="button" aria-label="Wähle ${name} aus" data-slot="${index}"
      class="${index === active ? 'highlighted' : ''}"><div></div></button>
    <button data-footer="${index}">Letzte 5 Statistiken</button>
    <button aria-label="${name} entfernen" data-remove="${index}"></button>
    <button data-captain="${index}">C</button>
  </div></div>`).join('')}</div>`;
}
