import {
  getMlsAaPercentileBand,
  getMlsAaTopPlayer,
  getMlsCleanSheetPercentileBand,
  getMlsWinProbabilityPercentileBand,
  hasAnyDisplayData,
  type Metric,
  type PerformanceTone,
  type PlayerStats,
} from '@sorare-overlay/shared';

const styles = `
  :host { all: initial; }
  .panel {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    padding: 1px;
    border: 1px solid rgba(255,255,255,.2);
    border-radius: 6px;
    background: rgba(12, 15, 22, .92);
    box-shadow: 0 2px 8px rgba(0,0,0,.32);
    color: #f7f9fc;
    font: 500 10px/1.2 "Segoe UI", Inter, ui-sans-serif, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    text-rendering: geometricPrecision;
    backdrop-filter: blur(4px);
  }
  .compact {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 2px;
    min-height: 18px;
  }
  .compact-stat {
    position: relative;
    display: flex;
    min-width: 0;
    padding: 0 3px;
    border: 1px solid rgba(255,255,255,.09);
    border-radius: 4px;
    background: rgba(255,255,255,.035);
    flex-direction: column;
    justify-content: center;
  }
  .compact-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: #aeb8c8;
    font-size: 7px;
    font-weight: 600;
    line-height: 1;
    white-space: nowrap;
  }
  .compact-value {
    overflow: hidden;
    color: #fff;
    font-size: 10.5px;
    font-weight: 600;
    line-height: 1.05;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .performance-stat {
    --tone: #94a3b8;
    --tone-bg: rgba(148, 163, 184, .13);
    border-color: #475569;
    background: linear-gradient(135deg, var(--tone-bg), rgba(11,17,24,.96) 72%);
    box-shadow: inset 0 0 0 1px rgba(255,255,255,.025);
    font-variant-numeric: tabular-nums;
  }
  .performance-stat .compact-label { color: #d6deea; }
  .performance-stat .compact-value { color: var(--tone); }
  .performance-stat[data-tone="very-low"] {
    --tone: #ff5d62;
    --tone-bg: rgba(255, 93, 98, .24);
    border-color: #ff5d62;
  }
  .performance-stat[data-tone="low"] {
    --tone: #ff922b;
    --tone-bg: rgba(255, 146, 43, .24);
    border-color: #ff922b;
  }
  .performance-stat[data-tone="balanced"] {
    --tone: #ffd43b;
    --tone-bg: rgba(255, 212, 59, .23);
    border-color: #ffd43b;
  }
  .performance-stat[data-tone="good"] {
    --tone: #51cf66;
    --tone-bg: rgba(81, 207, 102, .23);
    border-color: #51cf66;
  }
  .performance-stat[data-tone="strong"] {
    --tone: #4dabf7;
    --tone-bg: rgba(77, 171, 247, .24);
    border-color: #4dabf7;
  }
  .performance-stat[data-tone="elite"] {
    --tone: #cc8cff;
    --tone-bg: rgba(204, 140, 255, .25);
    border-color: #cc8cff;
  }
  .aa-percentile[data-top-rank="1"] {
    border-color: #ffd166;
    box-shadow:
      inset 0 0 0 1px rgba(255, 236, 164, .2),
      0 0 6px rgba(255, 209, 102, .45);
  }
  .aa-percentile[data-top-rank="2"] {
    border-color: #d7e0eb;
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, .16),
      0 0 5px rgba(190, 204, 222, .38);
  }
  .aa-percentile[data-top-rank="3"] {
    border-color: #d69258;
    box-shadow:
      inset 0 0 0 1px rgba(255, 218, 185, .14),
      0 0 5px rgba(214, 146, 88, .38);
  }
  .aa-percentile[data-top-rank] {
    padding-right: 19px;
  }
  .top-rank-badge {
    position: absolute;
    top: 50%;
    right: 2px;
    display: inline-flex;
    box-sizing: border-box;
    min-width: 15px;
    height: 13px;
    padding: 0 2px;
    align-items: center;
    justify-content: center;
    transform: translateY(-50%);
    border: 1px solid var(--rank-edge);
    border-radius: 999px;
    background: var(--rank-fill);
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,.62),
      0 1px 3px rgba(0,0,0,.5);
    color: var(--rank-ink);
    font-size: 6.5px;
    font-weight: 900;
    letter-spacing: -.35px;
    line-height: 1;
    text-shadow: 0 1px 0 rgba(255,255,255,.25);
  }
  .aa-percentile[data-top-rank="1"] .top-rank-badge {
    --rank-edge: #ffe69c;
    --rank-fill: linear-gradient(135deg, #fff3b0 0%, #ffd166 46%, #b9780f 100%);
    --rank-ink: #2e1c00;
  }
  .aa-percentile[data-top-rank="2"] .top-rank-badge {
    --rank-edge: #f1f5f9;
    --rank-fill: linear-gradient(135deg, #ffffff 0%, #d7e0eb 46%, #8290a2 100%);
    --rank-ink: #18212d;
  }
  .aa-percentile[data-top-rank="3"] .top-rank-badge {
    --rank-edge: #f2bd8d;
    --rank-fill: linear-gradient(135deg, #ffd2aa 0%, #d69258 46%, #82461f 100%);
    --rank-ink: #2b1507;
  }
  .details {
    display: none;
    margin-top: 3px;
    padding-top: 3px;
    border-top: 1px solid rgba(255,255,255,.1);
  }
  :host([data-expanded="true"]) .details { display: block; }
  .detail-list { display: grid; gap: 3px; }
  .detail-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    min-width: 0;
    gap: 0;
    font-size: 9.5px;
    line-height: 1.2;
  }
  :host([data-expanded="true"]) .detail-row:not(.odds) {
    grid-template-columns: auto minmax(0, 1fr);
    align-items: baseline;
    column-gap: 4px;
  }
  :host([data-expanded="true"]) .detail-row:not(.odds) .detail-value {
    text-align: right;
  }
  .detail-label {
    max-width: 100%;
    overflow: visible;
    color: #9da9ba;
    text-overflow: clip;
    white-space: normal;
  }
  .detail-value {
    min-width: 0;
    margin-left: 0;
    color: #f4f7fb;
    font-variant-numeric: tabular-nums;
    white-space: normal;
  }
  .role-row .detail-value { font-size: 11px; font-weight: 650; }
  .aa-rank .detail-value { color: #d8e1ee; }
  .next-game {
    margin-top: 1px;
    padding-top: 2px;
    border-top: 1px solid rgba(255,255,255,.08);
  }
  .odds { font-variant-numeric: tabular-nums; }
  .fixture-line {
    display: flex;
    min-width: 0;
    margin-top: 1px;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 1px 3px;
    color: #e4eaf3;
    font-size: 10px;
    line-height: 1.2;
  }
  .fixture-team {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .fixture-team[data-player-team="true"] {
    font-style: italic;
    font-weight: 800;
  }
  .fixture-separator { color: #8794a7; }
  .odds .detail-value { margin-top: 1px; }
  .odds-outcome[data-player-team-odd="true"] {
    font-style: italic;
    font-weight: 800;
  }
  .odd-win { color: #79e2a6; }
  .odd-draw { color: #d7dce5; }
  .odd-loss { color: #ffaaa7; }
  .low-coverage .detail-value { color: #f3bd72; }
  .state { color: #d9e0eb; font-size: 8px; font-weight: 500; white-space: nowrap; }
  .error { color: #ffb6b6; }
  .pulse { animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .45; } }
`;

const lineupOddsStyles = `
  :host {
    all: initial;
    display: block;
    box-sizing: border-box;
    width: 100%;
    height: 17px;
    margin-top: 1px;
    flex: 0 0 17px;
    pointer-events: none;
  }
  :host([hidden]) { display: none; }
  .lineup-odds-bar {
    display: flex;
    box-sizing: border-box;
    width: 100%;
    height: 17px;
    overflow: hidden;
    border: 1px solid rgba(255,255,255,.13);
    border-radius: 0 0 6px 6px;
    background: rgba(23, 27, 34, .97);
    box-shadow: 0 2px 5px rgba(0,0,0,.4);
    font: 800 9px/1 "Segoe UI", Inter, ui-sans-serif, system-ui, sans-serif;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
    -webkit-font-smoothing: antialiased;
    text-rendering: geometricPrecision;
  }
  .lineup-odd {
    --outcome-color: #d7dce5;
    --outcome-fill: rgba(215, 220, 229, .22);
    position: relative;
    display: flex;
    min-width: 0;
    flex: 0 0 var(--probability-share, 0%);
    align-items: center;
    justify-content: center;
    overflow: hidden;
    background:
      linear-gradient(180deg, rgba(255,255,255,.08), transparent 48%),
      var(--outcome-fill);
    color: var(--outcome-color);
    isolation: isolate;
  }
  .lineup-odd + .lineup-odd {
    border-left: 1px solid rgba(255,255,255,.1);
  }
  .lineup-odd[data-role="player"] {
    --outcome-color: #eaffdc;
    --outcome-fill: linear-gradient(90deg, #4aa922, #76d63b);
    box-shadow: inset 0 0 9px rgba(156, 247, 99, .28);
    font-style: italic;
    font-weight: 900;
  }
  .lineup-odd[data-role="draw"] {
    --outcome-color: #f2f4f7;
    --outcome-fill: linear-gradient(90deg, #59616e, #757e8c);
  }
  .lineup-odd[data-role="opponent"] {
    --outcome-color: #fff0f0;
    --outcome-fill: linear-gradient(90deg, #cf3f45, #ff5d62);
    box-shadow: inset 0 0 9px rgba(255, 93, 98, .24);
  }
`;

function percent(metric: Metric): string {
  return metric.value === null ? '—' : `${Math.round(metric.value * 100)}%`;
}

function score(metric: Metric): string {
  return metric.value === null ? '—' : metric.value.toFixed(1);
}

function probability(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

interface HomeAwayProbabilities {
  home: number | null;
  draw: number | null;
  away: number | null;
  playerIsHome: boolean;
  playerIsAway: boolean;
}

function homeAwayProbabilities(
  nextGame: PlayerStats['nextGame'],
): HomeAwayProbabilities | null {
  const probabilities = nextGame?.matchProbabilities;
  if (!probabilities) return null;
  const playerIsHome = Boolean(
    nextGame.playerTeamName &&
      nextGame.homeTeamName &&
      nextGame.playerTeamName === nextGame.homeTeamName,
  );
  const playerIsAway = Boolean(
    nextGame.playerTeamName &&
      nextGame.awayTeamName &&
      nextGame.playerTeamName === nextGame.awayTeamName,
  );
  if (!playerIsHome && !playerIsAway) return null;

  return {
    home: playerIsHome ? probabilities.win : probabilities.loss,
    draw: probabilities.draw,
    away: playerIsAway ? probabilities.win : probabilities.loss,
    playerIsHome,
    playerIsAway,
  };
}

function lineupBuilderTeamRow(container: HTMLElement): HTMLElement | null {
  if (!/\/compose-team(?:\/|$)/i.test(location.pathname)) return null;

  let scope = container.parentElement;
  for (let depth = 0; scope && depth < 6; depth += 1) {
    const teamNodes = Array.from(
      scope.querySelectorAll<HTMLElement>('[aria-label="Team"]'),
    );
    const teamsByRow = new Map<HTMLElement, HTMLElement[]>();
    for (const teamNode of teamNodes) {
      const row = teamNode.parentElement;
      if (!row) continue;
      const siblings = teamsByRow.get(row) ?? [];
      siblings.push(teamNode);
      teamsByRow.set(row, siblings);
    }
    const teamRow = [...teamsByRow].find(([, teams]) => teams.length === 2)?.[0];
    if (teamRow) return teamRow;
    scope = scope.parentElement;
  }
  return null;
}

function compactStatNode(label: string, value: string, modifier = ''): HTMLElement {
  const stat = document.createElement('span');
  stat.className = `compact-stat ${modifier}`.trim();
  const labelNode = document.createElement('span');
  labelNode.className = 'compact-label';
  labelNode.textContent = label;
  const valueNode = document.createElement('span');
  valueNode.className = 'compact-value';
  valueNode.textContent = value;
  stat.append(labelNode, valueNode);
  return stat;
}

function setPerformanceTone(stat: HTMLElement, tone: PerformanceTone | null): void {
  stat.dataset.tone = tone ?? 'unavailable';
}

function aaStatNode(stats: PlayerStats): HTMLElement {
  const stat = compactStatNode('AA L10', score(stats.aaL10), 'performance-stat aa-percentile');
  const topPlayer = getMlsAaTopPlayer(
    stats.position,
    stats.slug,
  );
  if (topPlayer) {
    stat.dataset.topRank = String(topPlayer.rank);
    const badge = document.createElement('span');
    badge.className = 'top-rank-badge';
    badge.textContent = `#${topPlayer.rank}`;
    badge.setAttribute('aria-hidden', 'true');
    stat.append(badge);
  }
  const band = getMlsAaPercentileBand(
    stats.position,
    stats.aaL10.value,
    stats.aaL10.sampleSize,
  );
  if (!band) {
    setPerformanceTone(stat, null);
    stat.setAttribute('aria-label', 'AA L10: keine belastbare MLS-Perzentileinstufung');
    return stat;
  }
  setPerformanceTone(stat, band.tone);
  stat.dataset.percentileBand = band.label;
  stat.setAttribute(
    'aria-label',
    `AA L10 im MLS-Vergleich für ${stats.position}: ${band.label}${
      topPlayer ? `, Rang ${topPlayer.rank}` : ''
    }`,
  );
  return stat;
}

function winProbabilityNode(value: number | null | undefined): HTMLElement {
  const rounded = value === null || value === undefined ? null : Math.round(value * 100);
  const badge = compactStatNode(
    'NEXT W%',
    rounded === null ? '—' : String(rounded),
    'performance-stat win-probability',
  );
  if (value === null || value === undefined) {
    setPerformanceTone(badge, null);
    return badge;
  }

  const bounded = Math.max(0, Math.min(1, value));
  const band = getMlsWinProbabilityPercentileBand(bounded);
  setPerformanceTone(badge, band?.tone ?? null);
  if (band) badge.dataset.percentileBand = band.label;
  badge.setAttribute(
    'aria-label',
    `Siegwahrscheinlichkeit nächstes Spiel: ${Math.round(bounded * 100)} Prozent${
      band ? `, MLS-Vergleich ${band.label}` : ''
    }`,
  );
  return badge;
}

function cleanSheetProbabilityNode(value: number | null | undefined): HTMLElement {
  const rounded = value === null || value === undefined ? null : Math.round(value * 100);
  const badge = compactStatNode(
    'NEXT CS%',
    rounded === null ? '—' : String(rounded),
    'performance-stat clean-sheet-probability',
  );
  if (value === null || value === undefined) {
    setPerformanceTone(badge, null);
    return badge;
  }

  const bounded = Math.max(0, Math.min(1, value));
  const band = getMlsCleanSheetPercentileBand(bounded);
  setPerformanceTone(badge, band?.tone ?? null);
  if (band) badge.dataset.percentileBand = band.label;
  badge.setAttribute(
    'aria-label',
    `Clean-Sheet-Wahrscheinlichkeit nächstes Spiel: ${Math.round(bounded * 100)} Prozent${
      band ? `, MLS-Vergleich ${band.label}` : ''
    }`,
  );
  return badge;
}

function oddsNode(
  nextGame: PlayerStats['nextGame'],
): HTMLElement {
  const row = detailRow('Quoten', '', 'odds');
  const labelNode = row.querySelector<HTMLElement>('.detail-label');
  const valueNode = row.querySelector<HTMLElement>('.detail-value');
  if (!valueNode) return row;
  const orderedProbabilities = homeAwayProbabilities(nextGame);
  const playerIsHome = orderedProbabilities?.playerIsHome ?? false;
  const playerIsAway = orderedProbabilities?.playerIsAway ?? false;
  if (labelNode && nextGame?.homeTeamName && nextGame.awayTeamName) {
    const fixture = document.createElement('div');
    fixture.className = 'fixture-line';
    const homeTeam = document.createElement('span');
    homeTeam.className = 'fixture-team';
    homeTeam.dataset.playerTeam = String(playerIsHome);
    homeTeam.textContent = nextGame.homeTeamName;
    const separator = document.createElement('span');
    separator.className = 'fixture-separator';
    separator.textContent = '–';
    const awayTeam = document.createElement('span');
    awayTeam.className = 'fixture-team';
    awayTeam.dataset.playerTeam = String(playerIsAway);
    awayTeam.textContent = nextGame.awayTeamName;
    fixture.append(homeTeam, separator, awayTeam);
    labelNode.after(fixture);
  }
  valueNode.replaceChildren();
  const probabilities = nextGame?.matchProbabilities;
  if (
    !probabilities ||
    (probabilities.win === null &&
      probabilities.draw === null &&
      probabilities.loss === null)
  ) {
    valueNode.textContent = 'H/D/A nicht verfügbar';
    return row;
  }

  const homeProbability = orderedProbabilities?.home ?? null;
  const awayProbability = orderedProbabilities?.away ?? null;
  const values: Array<[string, number | null, string, boolean]> = [
    [
      'H',
      homeProbability,
      playerIsHome ? 'odd-win' : playerIsAway ? 'odd-loss' : 'odd-draw',
      playerIsHome,
    ],
    ['D', probabilities.draw, 'odd-draw', false],
    [
      'A',
      awayProbability,
      playerIsAway ? 'odd-win' : playerIsHome ? 'odd-loss' : 'odd-draw',
      playerIsAway,
    ],
  ];
  values.forEach(([label, value, className, isPlayerTeamOdd], index) => {
    if (index > 0) valueNode.append(' · ');
    const item = document.createElement('span');
    item.className = `odds-outcome ${className}`;
    item.dataset.playerTeamOdd = String(isPlayerTeamOdd);
    item.textContent = `${label} ${probability(value)}`;
    valueNode.append(item);
  });
  return row;
}

function detailRow(label: string, value: string, modifier = ''): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = `detail-row ${modifier}`.trim();
  const labelNode = document.createElement('div');
  labelNode.className = 'detail-label';
  labelNode.textContent = label;
  const valueNode = document.createElement('div');
  valueNode.className = 'detail-value';
  valueNode.textContent = value;
  wrapper.append(labelNode, valueNode);
  return wrapper;
}

function metricWithSample(metric: Metric, formatter: (metric: Metric) => string): string {
  if (metric.value === null || metric.sampleSize === 0) return 'keine Daten';
  return `${formatter(metric)} · n=${metric.sampleSize}`;
}

function positionAbbreviation(position: PlayerStats['position']): string {
  return {
    Goalkeeper: 'GK',
    Defender: 'DEF',
    Midfielder: 'MID',
    Forward: 'FWD',
  }[position];
}

function aaRank(stats: PlayerStats): string {
  const topPlayer = getMlsAaTopPlayer(
    stats.position,
    stats.slug,
  );
  const band = getMlsAaPercentileBand(
    stats.position,
    stats.aaL10.value,
    stats.aaL10.sampleSize,
  );
  if (!band) {
    return stats.aaL10.sampleSize > 0
      ? `nicht eingestuft · n=${stats.aaL10.sampleSize}`
      : 'keine Daten';
  }
  return `${topPlayer ? `#${topPlayer.rank} · ` : ''}${band.label} · n=${stats.aaL10.sampleSize}`;
}

function isContainerExposed(container: HTMLElement, rect: DOMRect): boolean {
  if (typeof document.elementFromPoint !== 'function') return true;

  const left = Math.max(0, rect.left);
  const right = Math.min(window.innerWidth, rect.right);
  const top = Math.max(0, rect.top);
  const bottom = Math.min(window.innerHeight, rect.bottom);
  if (right <= left || bottom <= top) return false;

  const points: ReadonlyArray<readonly [number, number]> = [
    [(left + right) / 2, (top + bottom) / 2],
    [left + (right - left) * 0.2, top + (bottom - top) * 0.2],
    [right - (right - left) * 0.2, top + (bottom - top) * 0.2],
    [left + (right - left) * 0.2, bottom - (bottom - top) * 0.2],
    [right - (right - left) * 0.2, bottom - (bottom - top) * 0.2],
  ];

  return points.some(([x, y]) => {
    const exposedElement = document.elementFromPoint(x, y);
    return Boolean(
      exposedElement &&
        (exposedElement === container ||
          container.contains(exposedElement) ||
          exposedElement.contains(container)),
    );
  });
}

function activeModalScope(): HTMLElement | null {
  const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
  const candidates = [
    ...document.querySelectorAll<HTMLElement>(
      'dialog[open], [aria-modal="true"], [role="dialog"]',
    ),
  ].filter((element) => {
    if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    const rect = element.getBoundingClientRect();
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.bottom <= 0 ||
      rect.top >= window.innerHeight ||
      rect.right <= 0 ||
      rect.left >= window.innerWidth
    ) {
      return false;
    }
    if (typeof element.checkVisibility === 'function') {
      if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
        return false;
      }
    } else {
      const style = getComputedStyle(element);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        Number.parseFloat(style.opacity || '1') === 0
      ) {
        return false;
      }
    }

    const isExplicitModal =
      element instanceof HTMLDialogElement || element.getAttribute('aria-modal') === 'true';
    const isLargeDialog =
      element.getAttribute('role') === 'dialog' &&
      (rect.width * rect.height) / viewportArea >= 0.1;
    return isExplicitModal || isLargeDialog;
  });

  return candidates[candidates.length - 1] ?? null;
}

const packRevealText =
  /\b(?:deine\s+karten|your\s+cards|neuverpflichtungen|new\s+signings|neue\s+(?:karte|edition|spielerin)|neuer\s+spieler|new\s+(?:card|edition|player|signing))\b/i;
const packCardStatusText =
  /^(?:neue\s+karte|neue\s+edition|neue\s+spielerin|neuer\s+spieler|new\s+(?:card|edition|player|signing))$/i;
const packDialogText = /\b(?:deine\s+karten|your\s+cards|neuverpflichtungen|new\s+signings)\b/i;
const packStatusClearancePx = 10;
const packReservedStatusHeightPx = 24;

function normalizedElementText(element: Element): string {
  // `textContent` concatenates adjacent elements without a separator. Sorare's
  // pack reveal currently renders e.g. `Neuer Spieler` and the bonus graphic
  // as siblings, which otherwise becomes `Neuer SpielerBonus ...` and misses
  // the semantic pack/status expressions below.
  return Array.from(element.childNodes)
    .map((node) => node.textContent ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function packBonusGraphic(scope: Element): SVGElement | null {
  return (
    Array.from(scope.querySelectorAll<SVGElement>('svg[role="img"]')).find((graphic) =>
      /\bbonus\b/i.test(normalizedElementText(graphic.querySelector('title') ?? graphic)),
    ) ?? null
  );
}

function packRevealScope(container: HTMLElement): HTMLElement | null {
  const dialog = container.closest<HTMLElement>('dialog, [role="dialog"], [aria-modal="true"]');
  const insidePackDialog = dialog ? packDialogText.test(normalizedElementText(dialog)) : false;
  let scope: HTMLElement | null = container;
  for (let depth = 0; scope && depth < 12; depth += 1) {
    if (
      packRevealText.test(normalizedElementText(scope)) ||
      (insidePackDialog && packBonusGraphic(scope))
    ) {
      return scope;
    }
    if (scope === document.body) break;
    scope = scope.parentElement;
  }
  return null;
}

function isVisiblePackAnchor(candidate: Element, scope: HTMLElement): boolean {
  const rect = candidate.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  let current: Element | null = candidate;
  while (current) {
    if (current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('hidden')) {
      return false;
    }
    const style = window.getComputedStyle(current);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      (style.opacity !== '' && Number(style.opacity) <= 0.05)
    ) {
      return false;
    }
    if (current === scope) break;
    current = current.parentElement;
  }
  return true;
}

function packCardDecisionAnchor(scope: HTMLElement): Element | null {
  const statusCandidates = Array.from(scope.querySelectorAll<HTMLElement>('*'))
    .reverse()
    .filter((candidate) => packCardStatusText.test(normalizedElementText(candidate)));
  const bonus = packBonusGraphic(scope);
  const visible = [...statusCandidates, ...(bonus ? [bonus] : [])].filter((candidate) =>
    isVisiblePackAnchor(candidate, scope),
  );
  visible.sort(
    (left, right) =>
      left.getBoundingClientRect().top - right.getBoundingClientRect().top,
  );
  return visible[0] ?? null;
}

function isVisiblyRendered(container: HTMLElement, rect: DOMRect): boolean {
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.bottom <= 0 ||
    rect.top >= window.innerHeight ||
    rect.right <= 0 ||
    rect.left >= window.innerWidth
  ) {
    return false;
  }
  const modalScope = activeModalScope();
  if (modalScope && !modalScope.contains(container)) return false;
  if (container.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  if (typeof container.checkVisibility === 'function') {
    if (!container.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
      return false;
    }
    return isContainerExposed(container, rect);
  }
  for (let node: HTMLElement | null = container; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      Number.parseFloat(style.opacity || '1') === 0
    ) {
      return false;
    }
  }
  return isContainerExposed(container, rect);
}

export class OverlayView {
  readonly host: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly lineupOddsHost: HTMLSpanElement;
  private readonly lineupOddsBar: HTMLDivElement;
  private readonly cleanupCallbacks: Array<() => void> = [];
  private readonly reposition: () => void;
  private destroyed = false;

  constructor(
    private readonly container: HTMLElement,
    identity: { slug?: string; playerName?: string },
    position?: PlayerStats['position'],
  ) {
    this.host = document.createElement('div');
    this.host.dataset.sorareOverlayRoot = 'true';
    if (identity.slug) this.host.dataset.playerSlug = identity.slug;
    if (identity.playerName) this.host.dataset.playerName = identity.playerName;
    if (position) this.host.dataset.position = position;
    Object.assign(this.host.style, {
      position: 'fixed',
      zIndex: '2147483000',
      pointerEvents: 'none',
    });
    this.reposition = (): void => {
      if (!this.container.isConnected) {
        this.host.style.display = 'none';
        this.lineupOddsHost.hidden = true;
        return;
      }
      const rect = this.container.getBoundingClientRect();
      this.host.style.display = isVisiblyRendered(this.container, rect) ? '' : 'none';
      const teamRow = lineupBuilderTeamRow(this.container);
      if (
        this.host.style.display === 'none' ||
        this.lineupOddsBar.dataset.ready !== 'true' ||
        !teamRow
      ) {
        this.lineupOddsHost.hidden = true;
        if (!teamRow) this.lineupOddsHost.remove();
      } else {
        const teamRowRect = teamRow.getBoundingClientRect();
        const isVisible =
          teamRowRect.width > 0 &&
          teamRowRect.height > 0 &&
          teamRowRect.bottom > 0 &&
          teamRowRect.top < window.innerHeight &&
          teamRowRect.right > 0 &&
          teamRowRect.left < window.innerWidth;
        this.lineupOddsHost.hidden = !isVisible;
        if (isVisible) {
          if (teamRow.nextElementSibling !== this.lineupOddsHost) {
            teamRow.insertAdjacentElement('afterend', this.lineupOddsHost);
          }
        }
      }
      const packScope = packRevealScope(this.container);
      const compactLeft = rect.left + 4;
      const compactWidth = Math.max(40, rect.width - 8);
      const useExpandedCardWidth =
        !packScope &&
        this.host.dataset.expanded === 'true' &&
        rect.width < 180;
      const viewportMargin = 8;
      const availableWidth = Math.max(
        compactWidth,
        window.innerWidth - viewportMargin * 2,
      );
      const overlayWidth = useExpandedCardWidth
        ? Math.min(Math.max(compactWidth, 168), availableWidth)
        : compactWidth;
      const centeredLeft = rect.left + (rect.width - overlayWidth) / 2;
      const maximumLeft = Math.max(
        viewportMargin,
        window.innerWidth - viewportMargin - overlayWidth,
      );
      const overlayLeft = useExpandedCardWidth
        ? Math.min(Math.max(centeredLeft, viewportMargin), maximumLeft)
        : compactLeft;
      this.host.style.left = `${Math.round(overlayLeft)}px`;
      this.host.style.width = `${Math.round(overlayWidth)}px`;
      if (packScope) {
        const decisionAnchor = packCardDecisionAnchor(packScope);
        if (decisionAnchor) {
          // Anchor to Sorare's semantic pack status instead of a generated CSS
          // class, leaving status/edition bonus and card unobscured.
          const anchorRect = decisionAnchor.getBoundingClientRect();
          this.host.dataset.placement = 'pack-status-above';
          this.host.style.top = '';
          this.host.style.bottom = `${
            Math.round(window.innerHeight - anchorRect.top + packStatusClearancePx)
          }px`;
        } else {
          // Sorare can delay or visually suppress the "New card/edition"
          // label. Reserve a complete status row anyway so the overlay never
          // makes an absent label indistinguishable from a covered one.
          this.host.dataset.placement = 'pack-safe-above';
          this.host.style.top = '';
          this.host.style.bottom = `${
            Math.round(window.innerHeight - rect.top + packReservedStatusHeightPx)
          }px`;
        }
      } else {
        this.host.dataset.placement = 'above';
        this.host.style.top = '';
        this.host.style.bottom = `${Math.round(window.innerHeight - rect.top + 1)}px`;
      }

      if (this.host.dataset.expanded === 'true' && this.host.style.display !== 'none') {
        const margin = 8;
        const gap = 8;
        const viewportTop = 0;
        const overlayRect = this.host.getBoundingClientRect();
        const overlayWidth =
          overlayRect.width || Number.parseFloat(this.host.style.width) || 0;
        const overlayHeight = overlayRect.height;
        if (overlayRect.top < viewportTop) {
          const leftSpace = rect.left - margin - gap;
          const rightSpace = window.innerWidth - rect.right - margin - gap;
          const maximumTop = Math.max(
            margin,
            window.innerHeight - overlayHeight - margin,
          );
          const alignedTop = Math.min(Math.max(rect.top, margin), maximumTop);

          if (leftSpace >= overlayWidth) {
            this.host.dataset.placement = 'expanded-left';
            this.host.style.left = `${Math.round(rect.left - overlayWidth - gap)}px`;
            this.host.style.top = `${Math.round(alignedTop)}px`;
            this.host.style.bottom = '';
          } else if (rightSpace >= overlayWidth) {
            this.host.dataset.placement = 'expanded-right';
            this.host.style.left = `${Math.round(rect.right + gap)}px`;
            this.host.style.top = `${Math.round(alignedTop)}px`;
            this.host.style.bottom = '';
          } else if (rect.bottom + gap + overlayHeight <= window.innerHeight - margin) {
            this.host.dataset.placement = 'expanded-below';
            this.host.style.top = `${Math.round(rect.bottom + gap)}px`;
            this.host.style.bottom = '';
          } else {
            this.host.dataset.placement = 'expanded-clamped';
            this.host.style.top = `${Math.round(margin)}px`;
            this.host.style.bottom = '';
          }
        }
      }
    };
    const expand = (): void => {
      this.host.dataset.expanded = 'true';
      this.reposition();
    };
    const collapse = (): void => {
      this.host.dataset.expanded = 'false';
      this.reposition();
    };
    container.addEventListener('mouseenter', expand);
    container.addEventListener('mouseleave', collapse);
    container.addEventListener('focusin', expand);
    container.addEventListener('focusout', collapse);
    this.cleanupCallbacks.push(() => {
      container.removeEventListener('mouseenter', expand);
      container.removeEventListener('mouseleave', collapse);
      container.removeEventListener('focusin', expand);
      container.removeEventListener('focusout', collapse);
    });
    const shadow = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = styles;
    this.panel = document.createElement('div');
    this.panel.className = 'panel';
    this.lineupOddsHost = document.createElement('span');
    this.lineupOddsHost.dataset.sorareOverlayCompanion = 'lineup-odds';
    this.lineupOddsHost.hidden = true;
    const lineupShadow = this.lineupOddsHost.attachShadow({ mode: 'open' });
    const lineupStyle = document.createElement('style');
    lineupStyle.textContent = lineupOddsStyles;
    this.lineupOddsBar = document.createElement('div');
    this.lineupOddsBar.className = 'lineup-odds-bar';
    lineupShadow.append(lineupStyle, this.lineupOddsBar);
    shadow.append(style, this.panel);
    (document.body ?? document.documentElement).append(this.host);
    collapse();
    window.addEventListener('resize', this.reposition);
    window.addEventListener('scroll', this.reposition, true);
    this.cleanupCallbacks.push(() => {
      window.removeEventListener('resize', this.reposition);
      window.removeEventListener('scroll', this.reposition, true);
    });
    if (typeof ResizeObserver !== 'undefined') {
      const resizeObserver = new ResizeObserver(this.reposition);
      resizeObserver.observe(container);
      this.cleanupCallbacks.push(() => resizeObserver.disconnect());
    }
    this.loading();
  }

  refreshPosition(): void {
    if (!this.destroyed) this.reposition();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const cleanup of this.cleanupCallbacks) cleanup();
    this.cleanupCallbacks.length = 0;
    this.lineupOddsHost.remove();
    this.host.remove();
  }

  loading(): void {
    this.clearLineupOdds();
    this.state('Lade L10 …', 'pulse');
  }

  error(message = 'Stats nicht verfügbar'): void {
    this.clearLineupOdds();
    this.state(message, 'error');
  }

  noData(): void {
    this.clearLineupOdds();
    this.state('Keine L10-Daten', '');
  }

  render(stats: PlayerStats): void {
    if (this.destroyed) return;
    this.host.dataset.position = stats.position;
    if (!hasAnyDisplayData(stats)) {
      this.noData();
      return;
    }
    this.renderLineupOdds(stats.nextGame);
    this.panel.replaceChildren();
    const isDefensive = stats.position === 'Goalkeeper' || stats.position === 'Defender';
    const roleMetric = isDefensive ? stats.cleanSheetL10 : stats.goalL10;
    const compact = document.createElement('div');
    compact.className = 'compact';
    compact.append(
      aaStatNode(stats),
      isDefensive
        ? cleanSheetProbabilityNode(stats.nextGame?.cleanSheetProbability)
        : winProbabilityNode(stats.nextGame?.matchProbabilities?.win),
    );

    const details = document.createElement('div');
    details.className = 'details';
    const detailList = document.createElement('div');
    detailList.className = 'detail-list';
    detailList.append(oddsNode(stats.nextGame));
    detailList.append(
      detailRow(
        isDefensive ? 'CS L10' : 'Goal L10 (hist.)',
        metricWithSample(roleMetric, percent),
        'role-row',
      ),
      detailRow(
        `AA-Rang vs MLS ${positionAbbreviation(stats.position)}`,
        aaRank(stats),
        'aa-rank',
      ),
    );
    if (stats.excludedLowCoverage > 0) {
      detailList.append(
        detailRow(
          'Low Coverage',
          `${stats.excludedLowCoverage} ausgeschlossen`,
          'low-coverage',
        ),
      );
    }
    details.append(detailList);
    this.panel.append(compact, details);
    this.reposition();
  }

  private renderLineupOdds(nextGame: PlayerStats['nextGame']): void {
    const probabilities = homeAwayProbabilities(nextGame);
    if (
      !probabilities ||
      probabilities.home === null ||
      probabilities.draw === null ||
      probabilities.away === null
    ) {
      this.clearLineupOdds();
      return;
    }

    const values: Array<{
      outcome: 'home' | 'draw' | 'away';
      value: number;
      role: 'player' | 'draw' | 'opponent';
      label: string;
    }> = [
      {
        outcome: 'home',
        value: probabilities.home,
        role: probabilities.playerIsHome ? 'player' : 'opponent',
        label: 'Heim',
      },
      {
        outcome: 'draw',
        value: probabilities.draw,
        role: 'draw',
        label: 'Remis',
      },
      {
        outcome: 'away',
        value: probabilities.away,
        role: probabilities.playerIsAway ? 'player' : 'opponent',
        label: 'Auswärts',
      },
    ];
    const total = values.reduce((sum, { value }) => sum + Math.max(0, value), 0);
    if (total <= 0) {
      this.clearLineupOdds();
      return;
    }
    this.lineupOddsBar.replaceChildren(
      ...values.map(({ outcome, value, role, label }) => {
        const segment = document.createElement('span');
        segment.className = 'lineup-odd';
        segment.dataset.outcome = outcome;
        segment.dataset.role = role;
        const bounded = Math.max(0, Math.min(1, value));
        segment.style.setProperty(
          '--probability-share',
          `${(Math.max(0, value) / total) * 100}%`,
        );
        segment.textContent = `${Math.round(bounded * 100)}%`;
        segment.setAttribute('aria-label', `${label}: ${Math.round(bounded * 100)} Prozent`);
        return segment;
      }),
    );
    this.lineupOddsBar.dataset.ready = 'true';
  }

  private clearLineupOdds(): void {
    this.lineupOddsBar.replaceChildren();
    delete this.lineupOddsBar.dataset.ready;
    this.lineupOddsHost.hidden = true;
  }

  private state(message: string, modifier: string): void {
    if (this.destroyed) return;
    this.panel.replaceChildren();
    const state = document.createElement('div');
    state.className = `state ${modifier}`.trim();
    state.textContent = message;
    this.panel.append(state);
  }
}
