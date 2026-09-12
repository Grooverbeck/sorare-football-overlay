import type { FootballPosition } from '@sorare-overlay/shared';

type LineupPosition = FootballPosition | null | undefined;
const slotPositions = ['Goalkeeper', 'Defender', 'Midfielder', 'Forward', null] as const;
const positionAliases: Readonly<Record<string, FootballPosition | null>> = {
  gk: 'Goalkeeper', tw: 'Goalkeeper',
  def: 'Defender', df: 'Defender', ver: 'Defender',
  mid: 'Midfielder', mf: 'Midfielder',
  fwd: 'Forward', fw: 'Forward', st: 'Forward',
  ex: null, extra: null,
};

function lineupSlots(container: Element): Element[] | undefined {
  const lineup = container.closest('[class~="slots5"]');
  if (!lineup) return undefined;
  const slots = Array.from(lineup.children).filter(slot => slot.querySelector('button'));
  return slots.length === slotPositions.length ? slots : undefined;
}

export function inferLineupSlotPosition(container: HTMLElement): LineupPosition {
  const slots = lineupSlots(container);
  const index = slots?.findIndex(slot => slot.contains(container)) ?? -1;
  return index < 0 ? undefined : slotPositions[index];
}

export function lineupPositionFromButton(button: HTMLButtonElement | null): LineupPosition {
  if (!button || button.closest('[role="dialog"]')) return undefined;
  if (button.closest('[class~="slots5"]')) {
    const slots = lineupSlots(button);
    // The first button in each logical slot selects it, even when its only
    // label is a player name. Stats/remove/captain buttons are not navigation.
    // Do not infer EX from its occupant: that pool allows multiple positions.
    const index = slots?.findIndex(slot => slot.querySelector('button') === button) ?? -1;
    return index < 0 ? undefined : slotPositions[index];
  }
  const marker = button.textContent?.trim().toLowerCase() ?? '';
  return Object.hasOwn(positionAliases, marker) ? positionAliases[marker] : undefined;
}

export function readLineupPositionSelection(
  root: ParentNode,
  minimumAvailablePositions = 1,
): { hasNavigation: boolean; position: LineupPosition } {
  const available = new Set<FootballPosition | null>();
  const active = new Set<FootballPosition | null>();
  for (const button of root.querySelectorAll<HTMLButtonElement>('button')) {
    const position = lineupPositionFromButton(button);
    if (position === undefined) continue;
    available.add(position);
    if (
      button.getAttribute('aria-pressed') === 'true' ||
      button.dataset.state === 'active' ||
      button.classList.contains('active') ||
      button.classList.contains('highlighted')
    ) active.add(position);
  }
  const hasNavigation = available.size >= minimumAvailablePositions;
  return {
    hasNavigation,
    position: hasNavigation && active.size === 1 ? [...active][0] : undefined,
  };
}
