import {
  getMlsAaPercentileBand,
  getMlsAaTopPlayer,
  getMlsCleanSheetPercentileBand,
  getMlsHistoricalMarketProbabilityBand,
  getMlsMarketProbabilityBand,
  hasAnyDisplayData,
  type MarketProbability,
  type Metric,
  type PlayerStats,
} from '@sorare-overlay/shared';
import { supportsCompactViewPath } from './compact-view-route.js';
import { isScoreDetailsDialogTarget } from './dom.js';
import { setLineupGoalSortValue } from './lineup-goal-sort.js';
import type {
  HistoricalAssistWindow,
  MarketBracketSide,
  MarketValueFormat,
} from './settings.js';

const styles = `
  :host { all: initial; }
  .panel {
    position: relative;
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
  .panel.bracket-only {
    height: 22px;
    padding: 0;
    border-color: transparent;
    background: transparent;
    box-shadow: none;
    backdrop-filter: none;
    pointer-events: none;
  }
  :host([data-pack-reveal="true"][data-pack-settling="true"]) .panel {
    opacity: 0;
    visibility: hidden;
  }
  .panel.bracket-only .market-bracket {
    pointer-events: none;
  }
  .compact {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 2px;
    min-height: 18px;
  }
  .compact.compact-single {
    grid-template-columns: minmax(0, 1fr);
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
  .market-bracket {
    --market-fold: #2f3742;
    position: absolute;
    z-index: 2;
    top: calc(100% + 30px);
    right: -7px;
    display: grid;
    width: 46px;
    gap: 0;
    border-radius: 6px 0 0 6px;
    box-shadow: -2px 2px 5px rgba(0,0,0,.34);
    filter: drop-shadow(0 1px 1px rgba(0,0,0,.2));
    font-variant-numeric: lining-nums tabular-nums;
    font-optical-sizing: auto;
    -webkit-font-smoothing: auto;
    text-rendering: auto;
    pointer-events: none;
  }
  :host([data-market-value-format="decimal"]) .market-bracket {
    width: 54px;
  }
  :host([data-card-size="mini"]) .market-bracket {
    transform: scale(.9);
    transform-origin: top right;
  }
  :host(
    [data-card-size="mini"][data-market-bracket-side="left"]
  ) .market-bracket {
    transform-origin: top left;
  }
  .market-bracket[data-fold-tone="very-low"] { --market-fold: #ff5d62; }
  .market-bracket[data-fold-tone="low"] { --market-fold: #ff922b; }
  .market-bracket[data-fold-tone="balanced"] { --market-fold: #ffd43b; }
  .market-bracket[data-fold-tone="good"] { --market-fold: #51cf66; }
  .market-bracket[data-fold-tone="strong"] { --market-fold: #4dabf7; }
  .market-bracket[data-fold-tone="elite"] { --market-fold: #cc8cff; }
  .market-bracket.no-data-bracket { --market-fold: #667180; }
  .market-bracket::after {
    position: absolute;
    right: 0;
    bottom: -3px;
    width: 4px;
    height: 4px;
    background: var(--market-fold);
    clip-path: polygon(0 0, 100% 0, 100% 100%);
    content: "";
  }
  :host([data-market-bracket-side="left"]) .market-bracket {
    right: auto;
    left: -7px;
    border-radius: 0 6px 6px 0;
    box-shadow: 2px 2px 5px rgba(0,0,0,.34);
  }
  :host([data-market-bracket-side="left"]) .market-bracket::after {
    right: auto;
    left: 0;
    clip-path: polygon(0 0, 100% 0, 0 100%);
  }
  .market-cell {
    --market-ink: #0d1117;
    position: relative;
    display: flex;
    min-width: 0;
    min-height: 17px;
    box-sizing: border-box;
    padding: 1px 4px 1px 3px;
    align-items: center;
    justify-content: space-between;
    gap: 2px;
    background: var(--market-tone, #64748b);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.3);
    color: var(--market-ink);
    white-space: nowrap;
    pointer-events: auto;
  }
  .market-cell:first-child,
  .market-cell.market-first { border-radius: 6px 0 0 0; }
  .market-cell.market-last { border-radius: 0 0 0 6px; }
  .market-cell:first-child.market-last,
  .market-cell.market-first.market-last { border-radius: 6px 0 0 6px; }
  :host([data-market-bracket-side="left"]) .market-cell {
    padding-right: 3px;
    padding-left: 4px;
    flex-direction: row-reverse;
  }
  :host([data-market-bracket-side="left"]) .market-cell:first-child,
  :host([data-market-bracket-side="left"]) .market-cell.market-first {
    border-radius: 0 6px 0 0;
  }
  :host([data-market-bracket-side="left"]) .market-cell.market-last {
    border-radius: 0 0 6px 0;
  }
  :host([data-market-bracket-side="left"]) .market-cell:first-child.market-last,
  :host([data-market-bracket-side="left"]) .market-cell.market-first.market-last {
    border-radius: 0 6px 6px 0;
  }
  :host([data-market-bracket-side="left"]) .market-value {
    text-align: left;
  }
  .market-cell + .market-cell {
    border-top: 1px solid rgba(16,19,24,.25);
  }
  .market-cell.market-group-gap {
    margin-bottom: 4px;
  }
  .market-slot-spacer {
    display: block;
    min-height: 17px;
    box-sizing: border-box;
    visibility: hidden;
    pointer-events: none;
  }
  .market-slot-spacer.market-group-gap {
    margin-bottom: 4px;
  }
  .market-cell[data-available="false"] {
    --market-tone: #667180;
    --market-ink: #eef2f7;
  }
  .market-cell[data-source="historical"] {
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,.3),
      inset 0 0 0 1px rgba(13,17,23,.22);
  }
  .market-icon {
    display: block;
    width: 11px;
    height: 11px;
    flex: 0 0 11px;
    color: var(--market-tone, #64748b);
    overflow: hidden;
  }
  .market-value {
    min-width: 22px;
    box-sizing: border-box;
    flex: 0 0 auto;
    overflow: visible;
    color: currentColor;
    font-family: "Segoe UI Variable Small", "Segoe UI", Arial, ui-sans-serif, system-ui, sans-serif;
    font-size: 9.5px;
    font-weight: 750;
    font-feature-settings: "lnum" 1, "tnum" 1;
    font-kerning: none;
    letter-spacing: .005em;
    line-height: 1.05;
    padding: 0;
    background: transparent;
    text-align: right;
    text-rendering: auto;
    white-space: nowrap;
    -webkit-font-smoothing: auto;
  }
  :host([data-compact-market-brackets="true"]) .market-bracket {
    width: 38px;
  }
  :host(
    [data-compact-market-brackets="true"][data-market-value-format="decimal"]
  ) .market-bracket {
    width: 46px;
  }
  :host([data-compact-market-brackets="true"]) .market-cell {
    min-height: 15px;
    padding: 0 3px;
    justify-content: space-between;
    gap: 2px;
  }
  :host(
    [data-compact-market-brackets="true"][data-market-bracket-side="left"]
  ) .market-cell {
    padding-right: 3px;
    padding-left: 3px;
  }
  :host([data-compact-market-brackets="true"]) .market-slot-spacer {
    min-height: 15px;
  }
  :host([data-compact-market-brackets="true"]) .market-icon {
    width: 9px;
    height: 9px;
    flex-basis: 9px;
  }
  :host([data-compact-market-brackets="true"]) .market-value {
    min-width: 0;
    font-size: 8px;
    letter-spacing: 0;
    line-height: 1;
  }
  :host([data-market-bracket-compact-view="true"]) .market-bracket {
    width: 22px;
    transition: width 140ms ease, opacity 120ms ease;
  }
  :host([data-market-bracket-compact-view="true"]) .market-icon {
    width: 11px;
    height: 11px;
    flex-basis: 11px;
  }
  :host([data-market-bracket-compact-view="true"])
    .market-bracket:hover,
  :host([data-market-bracket-compact-view="true"])
    .market-bracket:focus-within {
    width: 46px;
  }
  :host(
    [data-market-bracket-compact-view="true"][data-market-value-format="decimal"]
  ) .market-bracket:hover,
  :host(
    [data-market-bracket-compact-view="true"][data-market-value-format="decimal"]
  ) .market-bracket:focus-within {
    width: 54px;
  }
  :host(
    [data-market-bracket-compact-view="true"][data-compact-market-brackets="true"]
  ) .market-bracket:hover,
  :host(
    [data-market-bracket-compact-view="true"][data-compact-market-brackets="true"]
  ) .market-bracket:focus-within {
    width: 38px;
  }
  :host(
    [data-market-bracket-compact-view="true"][data-compact-market-brackets="true"][data-market-value-format="decimal"]
  ) .market-bracket:hover,
  :host(
    [data-market-bracket-compact-view="true"][data-compact-market-brackets="true"][data-market-value-format="decimal"]
  ) .market-bracket:focus-within {
    width: 46px;
  }
  :host([data-market-bracket-compact-view="true"]) .market-cell {
    justify-content: center;
    gap: 0;
  }
  :host([data-market-bracket-compact-view="true"])
    .market-bracket:hover .market-cell,
  :host([data-market-bracket-compact-view="true"])
    .market-bracket:focus-within .market-cell {
    justify-content: space-between;
    gap: 2px;
  }
  :host(
    [data-market-bracket-compact-view="true"][data-compact-market-brackets="true"]
  ) .market-bracket:hover .market-cell,
  :host(
    [data-market-bracket-compact-view="true"][data-compact-market-brackets="true"]
  ) .market-bracket:focus-within .market-cell {
    justify-content: space-between;
    gap: 2px;
  }
  :host([data-market-bracket-compact-view="true"]) .market-value {
    min-width: 0;
    max-width: 0;
    opacity: 0;
    overflow: hidden;
    transition: max-width 140ms ease, opacity 90ms ease;
    visibility: hidden;
  }
  :host([data-market-bracket-compact-view="true"])
    .market-bracket:hover .market-value,
  :host([data-market-bracket-compact-view="true"])
    .market-bracket:focus-within .market-value {
    max-width: 36px;
    opacity: 1;
    visibility: visible;
  }
  :host([data-market-bracket-compact-view="true"]) .aa-sample-warning {
    opacity: 0;
    pointer-events: none;
    visibility: hidden;
  }
  :host([data-market-bracket-compact-view="true"])
    .market-bracket:hover .aa-sample-warning,
  :host([data-market-bracket-compact-view="true"])
    .market-bracket:focus-within .aa-sample-warning {
    opacity: 1;
    pointer-events: auto;
    visibility: visible;
  }
  :host(
    [data-market-bracket-compact-view="true"][data-market-bracket-card-hover="true"]
  ) .market-bracket {
    width: 46px;
  }
  :host(
    [data-market-bracket-compact-view="true"][data-market-bracket-card-hover="true"][data-market-value-format="decimal"]
  ) .market-bracket {
    width: 54px;
  }
  :host(
    [data-market-bracket-compact-view="true"][data-market-bracket-card-hover="true"][data-compact-market-brackets="true"]
  ) .market-bracket {
    width: 38px;
  }
  :host(
    [data-market-bracket-compact-view="true"][data-market-bracket-card-hover="true"][data-compact-market-brackets="true"][data-market-value-format="decimal"]
  ) .market-bracket {
    width: 46px;
  }
  :host(
    [data-market-bracket-compact-view="true"][data-market-bracket-card-hover="true"]
  ) .market-cell {
    justify-content: space-between;
    gap: 2px;
  }
  :host(
    [data-market-bracket-compact-view="true"][data-market-bracket-card-hover="true"]
  ) .market-value {
    max-width: 36px;
    opacity: 1;
    visibility: visible;
  }
  :host(
    [data-market-bracket-compact-view="true"][data-market-bracket-card-hover="true"]
  ) .aa-sample-warning {
    opacity: 1;
    pointer-events: auto;
    visibility: visible;
  }
  .market-cell[data-tone="very-low"] { --market-tone: #ff5d62; }
  .market-cell[data-tone="low"] { --market-tone: #ff922b; }
  .market-cell[data-tone="balanced"] { --market-tone: #ffd43b; }
  .market-cell[data-tone="good"] { --market-tone: #51cf66; }
  .market-cell[data-tone="strong"] { --market-tone: #4dabf7; }
  .market-cell[data-tone="elite"] { --market-tone: #cc8cff; }
  .market-bracket[data-slot-layout="fixed"]::after {
    display: none;
  }
  .market-bracket[data-slot-layout="fixed"] {
    box-shadow: none;
  }
  .market-cell.market-fold-end::after {
    position: absolute;
    right: 0;
    bottom: -3px;
    width: 4px;
    height: 4px;
    background: var(--market-tone, #64748b);
    clip-path: polygon(0 0, 100% 0, 100% 100%);
    content: "";
    pointer-events: none;
  }
  :host([data-market-bracket-side="left"])
    .market-cell.market-fold-end::after {
    right: auto;
    left: 0;
    clip-path: polygon(0 0, 100% 0, 0 100%);
  }
  .aa-bracket-cell {
    border-radius: 6px 0 0 6px;
  }
  .aa-bracket-cell.aa-bracket-top {
    margin-bottom: 4px;
  }
  .aa-bracket-cell.aa-bracket-bottom {
    margin-top: 4px;
  }
  .aa-sample-warning {
    position: absolute;
    z-index: 5;
    top: -5px;
    right: -3px;
    display: inline-flex;
    width: 12px;
    height: 12px;
    box-sizing: border-box;
    border: 1px solid rgba(255,255,255,.92);
    border-radius: 50%;
    align-items: center;
    justify-content: center;
    background: #151922;
    box-shadow:
      0 1px 3px rgba(0,0,0,.8),
      0 0 0 1px rgba(13,17,23,.7);
    color: #ffe066;
    cursor: help;
    font-family: "Segoe UI Variable Text", "Segoe UI", Inter, ui-sans-serif, system-ui, sans-serif;
    font-size: 0;
    font-weight: 900;
    line-height: 1;
    pointer-events: auto;
    transform: translate(2px, -2px);
  }
  .aa-sample-warning-glyph {
    display: block;
    width: 9px;
    height: 10px;
    flex: 0 0 auto;
    overflow: visible;
    fill: currentColor;
    pointer-events: none;
    shape-rendering: geometricPrecision;
  }
  :host([data-market-bracket-side="left"]) .aa-sample-warning {
    right: auto;
    left: -3px;
    transform: translate(-2px, -2px);
  }
  .aa-sample-warning:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 1px;
  }
  .aa-sample-warning-tooltip {
    position: absolute;
    z-index: 8;
    right: -1px;
    bottom: calc(100% + 5px);
    display: grid;
    width: max-content;
    max-width: min(230px, calc(100vw - 12px));
    box-sizing: border-box;
    gap: 2px;
    padding: 6px 7px;
    border: 1px solid rgba(255, 224, 102, .62);
    border-radius: 6px;
    background: rgba(12, 15, 22, .98);
    box-shadow: 0 5px 15px rgba(0,0,0,.52);
    color: #f5f7fb;
    font: 600 9px/1.25 "Segoe UI Variable Text", "Segoe UI", Inter, ui-sans-serif, system-ui, sans-serif;
    font-variant-numeric: tabular-nums;
    opacity: 0;
    pointer-events: none;
    transform: translateY(2px);
    transition: opacity 90ms ease, transform 90ms ease, visibility 90ms ease;
    visibility: hidden;
    white-space: normal;
    -webkit-font-smoothing: antialiased;
    text-rendering: geometricPrecision;
  }
  :host([data-market-bracket-side="left"]) .aa-sample-warning-tooltip {
    right: auto;
    left: -1px;
  }
  .aa-sample-warning:hover .aa-sample-warning-tooltip,
  .aa-sample-warning:focus-visible .aa-sample-warning-tooltip {
    opacity: 1;
    transform: translateY(0);
    visibility: visible;
  }
  .aa-sample-warning-title {
    color: #ffe066;
    font-size: 8px;
    font-weight: 800;
    letter-spacing: .02em;
    text-transform: uppercase;
  }
  .aa-bracket-cell[data-podium-frame] {
    z-index: 3;
    border: 1px solid var(--podium-border);
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,.42),
      inset 0 0 0 1px rgba(13,17,23,.28),
      0 0 7px var(--podium-glow),
      0 2px 5px rgba(0,0,0,.42);
  }
  .aa-bracket-cell[data-podium-frame]::before {
    position: absolute;
    z-index: -1;
    inset: -2px;
    border: 1px solid var(--podium-border);
    border-radius: 7px 1px 1px 7px;
    box-shadow:
      0 0 3px var(--podium-glow),
      0 0 9px var(--podium-glow);
    content: "";
    pointer-events: none;
  }
  :host([data-market-bracket-side="left"])
    .aa-bracket-cell[data-podium-frame]::before {
    border-radius: 1px 7px 7px 1px;
  }
  .aa-bracket-cell[data-podium-frame="gold"] {
    --podium-border: #ffe066;
    --podium-glow: rgba(255, 193, 7, .72);
  }
  .aa-bracket-cell[data-podium-frame="silver"] {
    --podium-border: #f1f5f9;
    --podium-glow: rgba(203, 213, 225, .66);
  }
  .aa-bracket-cell[data-podium-frame="bronze"] {
    --podium-border: #f0a36b;
    --podium-glow: rgba(217, 119, 58, .68);
  }
  .aa-bracket-cell:first-child,
  .aa-bracket-cell.market-last {
    border-radius: 6px 0 0 6px;
  }
  .aa-market-icon,
  .cs-market-icon,
  .no-data-market-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    color: currentColor;
    font-family: "Segoe UI Variable Small", "Segoe UI", Arial, ui-sans-serif, system-ui, sans-serif;
    font-size: 6.5px;
    font-weight: 800;
    font-optical-sizing: auto;
    font-kerning: none;
    letter-spacing: -.15px;
    line-height: 1;
    -webkit-font-smoothing: auto;
    text-rendering: auto;
  }
  .cs-market-icon,
  :host([data-compact-market-brackets="true"]) .cs-market-icon,
  :host([data-market-bracket-compact-view="true"]) .cs-market-icon {
    display: block;
    width: 11px;
    height: auto;
    flex: 0 0 11px;
    padding: 0;
    text-align: center;
  }
  .clean-sheet-content {
    display: flex;
    width: 100%;
    min-width: 0;
    align-items: baseline;
    justify-content: space-between;
    gap: 2px;
  }
  :host([data-market-bracket-side="left"]) .clean-sheet-content {
    flex-direction: row-reverse;
  }
  :host([data-market-bracket-compact-view="true"]) .clean-sheet-content {
    justify-content: center;
    gap: 0;
  }
  :host([data-market-bracket-compact-view="true"])
    .market-bracket:hover .clean-sheet-content,
  :host([data-market-bracket-compact-view="true"])
    .market-bracket:focus-within .clean-sheet-content,
  :host(
    [data-market-bracket-compact-view="true"][data-market-bracket-card-hover="true"]
  ) .clean-sheet-content {
    justify-content: space-between;
    gap: 2px;
  }
  .no-data-market-icon,
  :host([data-compact-market-brackets="true"]) .no-data-market-icon,
  :host([data-market-bracket-compact-view="true"]) .no-data-market-icon {
    width: 14px;
    flex-basis: 14px;
  }
  :host([data-market-bracket-side="left"]) .aa-bracket-cell,
  :host([data-market-bracket-side="left"]) .aa-bracket-cell:first-child,
  :host([data-market-bracket-side="left"]) .aa-bracket-cell.market-last {
    border-radius: 0 6px 6px 0;
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
  .player-market-tooltip {
    position: absolute;
    z-index: 2147483647;
    left: 50%;
    bottom: calc(100% + 5px);
    box-sizing: border-box;
    width: max-content;
    min-width: 170px;
    max-width: min(280px, calc(100vw - 12px));
    padding: 7px 8px;
    border: 1px solid rgba(160, 174, 195, .42);
    border-radius: 7px;
    background: rgba(12, 15, 22, .97);
    box-shadow: 0 5px 15px rgba(0,0,0,.5);
    color: #f5f7fb;
    font: 600 10px/1.25 "Segoe UI", Inter, ui-sans-serif, system-ui, sans-serif;
    font-variant-numeric: tabular-nums;
    opacity: 0;
    pointer-events: none;
    transform: translate(calc(-50% + var(--player-tooltip-shift-x, 0px)), 3px);
    transition: opacity 100ms ease, transform 100ms ease, visibility 100ms ease;
    visibility: hidden;
    white-space: nowrap;
    -webkit-font-smoothing: antialiased;
    text-rendering: geometricPrecision;
  }
  .player-market-tooltip[hidden] { display: none; }
  .player-market-tooltip::after {
    position: absolute;
    bottom: -5px;
    left: calc(50% - var(--player-tooltip-shift-x, 0px));
    width: 8px;
    height: 8px;
    border-right: 1px solid rgba(160, 174, 195, .42);
    border-bottom: 1px solid rgba(160, 174, 195, .42);
    background: rgba(12, 15, 22, .97);
    content: "";
    transform: translateX(-50%) rotate(45deg);
  }
  :host([data-player-market-tooltip-placement="below"]) .player-market-tooltip {
    top: calc(100% + 5px);
    bottom: auto;
  }
  :host([data-player-market-tooltip-placement="below"]) .player-market-tooltip::after {
    top: -5px;
    bottom: auto;
    border: 0;
    border-top: 1px solid rgba(160, 174, 195, .42);
    border-left: 1px solid rgba(160, 174, 195, .42);
  }
  :host([data-player-market-tooltip-open="true"]) .player-market-tooltip:not([hidden]) {
    opacity: 1;
    transform: translate(calc(-50% + var(--player-tooltip-shift-x, 0px)), 0);
    visibility: visible;
  }
  :host([data-pack-reveal="true"]) .player-market-tooltip {
    display: none;
  }
  .player-market-tooltip .tooltip-label {
    margin-bottom: 5px;
    color: #9ba7b8;
    font-size: 8px;
    font-weight: 700;
    text-transform: uppercase;
  }
  .bookmaker-markets {
    display: grid;
    gap: 6px;
  }
  .bookmaker-market {
    display: grid;
    gap: 2px;
  }
  .bookmaker-market + .bookmaker-market {
    margin-top: 1px;
    padding-top: 5px;
    border-top: 1px solid rgba(255,255,255,.1);
  }
  .historical-assist-note {
    color: #ffcf70;
    font-size: 8px;
    font-weight: 750;
  }
  .bookmaker-market-header,
  .bookmaker-row {
    display: grid;
    grid-template-columns: minmax(80px, 1fr) auto;
    align-items: baseline;
    gap: 10px;
  }
  .bookmaker-market-header {
    color: #b8c2d1;
    font-size: 8px;
    font-weight: 800;
    text-transform: uppercase;
  }
  .bookmaker-column-hint {
    color: #768296;
    font-size: 7px;
    font-weight: 650;
    text-transform: none;
  }
  .bookmaker-name {
    min-width: 0;
    overflow: hidden;
    color: #eef2f7;
    font-weight: 650;
    text-overflow: ellipsis;
  }
  .bookmaker-value {
    color: #d5dce7;
    font-weight: 750;
    text-align: right;
  }
  .state { color: #d9e0eb; font-size: 8px; font-weight: 500; white-space: nowrap; }
  .error { color: #ffb6b6; }
  .pulse { animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .45; } }
`;

const lineupOddsStyles = `
  :host {
    all: initial;
    position: relative;
    display: block;
    box-sizing: border-box;
    width: 100%;
    height: 17px;
    margin-top: 1px;
    flex: 0 0 17px;
    pointer-events: none;
    overflow: visible;
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
    cursor: help;
    pointer-events: auto;
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
  .lineup-odds-tooltip {
    position: absolute;
    z-index: 2147483647;
    left: 50%;
    bottom: calc(100% + var(--lineup-tooltip-clearance, 25px));
    box-sizing: border-box;
    width: max-content;
    min-width: 160px;
    max-width: 280px;
    padding: 7px 8px;
    border: 1px solid rgba(160, 174, 195, .42);
    border-radius: 7px;
    background: rgba(12, 15, 22, .97);
    box-shadow: 0 5px 15px rgba(0,0,0,.5);
    color: #f5f7fb;
    font: 600 10px/1.25 "Segoe UI", Inter, ui-sans-serif, system-ui, sans-serif;
    font-variant-numeric: tabular-nums;
    opacity: 0;
    transform: translate(-50%, 3px);
    transition: opacity 100ms ease, transform 100ms ease, visibility 100ms ease;
    visibility: hidden;
    white-space: nowrap;
    -webkit-font-smoothing: antialiased;
    text-rendering: geometricPrecision;
  }
  .lineup-odds-tooltip::after {
    position: absolute;
    bottom: -5px;
    left: 50%;
    width: 8px;
    height: 8px;
    border-right: 1px solid rgba(160, 174, 195, .42);
    border-bottom: 1px solid rgba(160, 174, 195, .42);
    background: rgba(12, 15, 22, .97);
    content: "";
    transform: translateX(-50%) rotate(45deg);
  }
  :host([data-tooltip-open="true"]) .lineup-odds-tooltip:not([hidden]) {
    opacity: 1;
    transform: translate(-50%, 0);
    visibility: visible;
  }
  .tooltip-label {
    margin-bottom: 3px;
    color: #9ba7b8;
    font-size: 8px;
    font-weight: 700;
    text-transform: uppercase;
  }
  .tooltip-fixture {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tooltip-team[data-role="player"] {
    color: #b8f995;
    font-style: italic;
    font-weight: 900;
  }
  .tooltip-separator {
    padding: 0 4px;
    color: #7f8a9a;
  }
  .tooltip-odds {
    display: flex;
    margin-top: 5px;
    padding-top: 5px;
    border-top: 1px solid rgba(255,255,255,.1);
    justify-content: space-between;
    gap: 9px;
  }
  .tooltip-odd[data-role="player"] {
    color: #8ce769;
    font-style: italic;
    font-weight: 900;
  }
  .tooltip-odd[data-role="draw"] { color: #d8dde5; }
  .tooltip-odd[data-role="opponent"] { color: #ff8589; }
`;

function score(metric: Metric): string {
  return metric.value === null ? '—' : metric.value.toFixed(1);
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

function usesCompactMarketBrackets(container: HTMLElement): boolean {
  // Sorare's five-slot team grid is shared by lineup and squad views. Cards
  // offered in pickers live outside that grid and keep the larger scouting
  // brackets. Selection screens such as compose-team and Hot Streaks also use
  // the grid, so route-gate the smaller presentation to passive team views.
  return (
    supportsCompactViewPath(window.location.pathname) &&
    Boolean(container.closest('[class~="slots5"]'))
  );
}

function lineupBuilderTeamRow(container: HTMLElement): HTMLElement | null {
  // Sorare reuses the same semantic card footer in the lineup builder,
  // captain selection and squad player picker, but those screens have
  // different routes. Detect the concrete two-team row near this card
  // instead of coupling the odds bar to `/compose-team`.
  const fiveSlotLineup = container.closest<HTMLElement>('[class~="slots5"]');
  if (fiveSlotLineup) {
    const concreteSlot = Array.from(fiveSlotLineup.children).find((slot) =>
      slot.contains(container),
    );
    if (!concreteSlot) return null;
    const rows = new Map<HTMLElement, number>();
    for (const teamNode of concreteSlot.querySelectorAll<HTMLElement>(
      '[aria-label="Team"]',
    )) {
      const row = teamNode.parentElement;
      if (row) rows.set(row, (rows.get(row) ?? 0) + 1);
    }
    const localRows = [...rows]
      .filter(([, teamCount]) => teamCount === 2)
      .map(([row]) => row);
    return localRows.length === 1 ? localRows[0] ?? null : null;
  }

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
    const teamRows = [...teamsByRow]
      .filter(([, teams]) => teams.length === 2)
      .map(([row]) => row);
    if (teamRows.length === 1) return teamRows[0] ?? null;
    // Once a scope contains multiple fixtures, it is no longer the local
    // card shell. Continuing with the first row would attach empty/recycled
    // lineup slots to an unrelated player's fixture.
    if (teamRows.length > 1) return null;
    scope = scope.parentElement;
  }
  return null;
}

const sorareCardImageAlt =
  /\s+-\s+(?:common|limited|rare|super rare|unique)$/i;

interface VisibleCardImage {
  image: HTMLImageElement;
  rect: DOMRect;
}

function visibleCardImage(container: HTMLElement): VisibleCardImage | null {
  const candidates = Array.from(
    container.querySelectorAll<HTMLImageElement>('img[alt]'),
  )
    .filter((image) => sorareCardImageAlt.test(image.alt))
    .map((image) => ({ image, rect: image.getBoundingClientRect() }))
    .filter(({ rect }) => rect.width >= 40 && rect.height >= 60)
    .sort(
      (left, right) =>
        right.rect.width * right.rect.height -
        left.rect.width * left.rect.height,
    );
  return candidates[0] ?? null;
}

function visibleCardImageRect(container: HTMLElement): DOMRect | null {
  return visibleCardImage(container)?.rect ?? null;
}

function cssPixels(value: number): string {
  return `${Math.round(value * 100) / 100}px`;
}

const decimalOddsFormatter = new Intl.NumberFormat('de-DE', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 3,
});
const compactDecimalOddsFormatter = new Intl.NumberFormat('de-DE', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function bookmakerMarketNode(
  label: string,
  market: MarketProbability | null | undefined,
): HTMLElement | null {
  if (!market?.bookmakerQuotes?.length) return null;
  const section = document.createElement('section');
  section.className = 'bookmaker-market';
  const header = document.createElement('div');
  header.className = 'bookmaker-market-header';
  const marketLabel = document.createElement('span');
  marketLabel.textContent = label;
  const columnHint = document.createElement('span');
  columnHint.className = 'bookmaker-column-hint';
  columnHint.textContent = 'Quote · fair';
  header.append(marketLabel, columnHint);
  section.append(header);
  for (const quote of market.bookmakerQuotes) {
    const row = document.createElement('div');
    row.className = 'bookmaker-row';
    row.dataset.bookmaker = quote.key;
    const name = document.createElement('span');
    name.className = 'bookmaker-name';
    name.textContent = quote.title;
    const value = document.createElement('span');
    value.className = 'bookmaker-value';
    const fairProbability = Math.round(quote.probability * 100);
    value.textContent = `${decimalOddsFormatter.format(
      quote.decimalOdds,
    )} · ${fairProbability}%`;
    value.setAttribute(
      'aria-label',
      `Dezimalquote ${quote.decimalOdds}, bereinigte Wahrscheinlichkeit ${fairProbability} Prozent`,
    );
    row.append(name, value);
    section.append(row);
  }
  return section;
}

type HistoricalMarketKind = 'goal' | 'assist';

function historicalMarketNode(
  market: HistoricalMarketKind,
  selection: HistoricalMarketSelection | null,
): HTMLElement | null {
  const value = selection?.metric.value;
  if (
    selection === null ||
    value === null ||
    value === undefined
  ) {
    return null;
  }
  const section = document.createElement('section');
  section.className = 'bookmaker-market historical-assist-market';
  const header = document.createElement('div');
  header.className = 'bookmaker-market-header';
  const marketLabel = document.createElement('span');
  const label = market === 'goal' ? 'Tor' : 'Assist';
  marketLabel.textContent = `${label} · historisch L${selection.window}`;
  const columnHint = document.createElement('span');
  columnHint.className = 'bookmaker-column-hint';
  columnHint.textContent = 'Anteil · Stichprobe';
  header.append(marketLabel, columnHint);

  const row = document.createElement('div');
  row.className = 'bookmaker-row';
  const note = document.createElement('span');
  note.className = 'historical-assist-note';
  note.textContent = 'Keine Marktquote';
  const metric = document.createElement('span');
  metric.className = 'bookmaker-value';
  metric.textContent = `${Math.round(value * 100)}% · n=${selection.metric.sampleSize}`;
  row.append(note, metric);
  section.append(header, row);
  return section;
}

const svgNamespace = 'http://www.w3.org/2000/svg';
let marketIconInstance = 0;

function svgElement(
  tagName: string,
  attributes: Record<string, string>,
): SVGElement {
  const element = document.createElementNS(svgNamespace, tagName);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  return element;
}

function appendSvgPath(
  parent: SVGElement,
  d: string,
  attributes: Record<string, string> = {},
): void {
  parent.append(svgElement('path', { d, ...attributes }));
}

function sorareMarketIconNode(market: 'goal' | 'assist'): SVGSVGElement {
  const svg = svgElement('svg', {
    width: '16',
    height: '16',
    viewBox: '0 0 16 16',
    fill: 'none',
    focusable: 'false',
    'aria-hidden': 'true',
  }) as SVGSVGElement;
  svg.classList.add('market-icon');
  svg.dataset.marketIcon = market;

  if (market === 'goal') {
    appendSvgPath(
      svg,
      'M16 8C16 3.58172 12.4183 0 8 0C3.58172 0 0 3.58172 0 8C0 12.4183 3.58172 16 8 16C12.4183 16 16 12.4183 16 8Z',
      { fill: 'currentColor', 'data-tone-layer': 'true' },
    );
    appendSvgPath(svg, 'M7.98993 2.59663C10.9733 2.59663 13.3966 5.0233 13.3966 8.0033C13.3966 10.9833 10.9699 13.41 7.98993 13.41C5.00993 13.41 2.58327 10.9866 2.58327 8.0033C2.58327 5.01997 5.00993 2.59663 7.98993 2.59663ZM7.98993 1.52997C4.4166 1.52997 1.5166 4.42997 1.5166 8.0033C1.5166 11.5766 4.4166 14.4766 7.98993 14.4766C11.5633 14.4766 14.4633 11.5766 14.4633 8.0033C14.4633 4.42997 11.5666 1.52997 7.98993 1.52997Z', { fill: 'black' });
    appendSvgPath(svg, 'M9.83673 9.07002V6.94002L7.99006 5.87335L6.14673 6.94002V9.07002L7.99006 10.1334L9.83673 9.07002Z', { fill: 'black' });
    appendSvgPath(svg, 'M5.11978 6.40332L6.32978 5.18999L5.88644 3.53666L4.22978 3.09332L3.01978 4.30332L3.46311 5.95999L5.11978 6.40332Z', { fill: 'black' });
    appendSvgPath(svg, 'M11.5866 12.87L12.7966 11.66L12.3532 10.0033L10.6999 9.56L9.48657 10.7733L9.92991 12.4267L11.5866 12.87Z', { fill: 'black' });
    appendSvgPath(svg, 'M11.8468 6.18335L13.0568 4.97335L12.1835 3.64335L10.9602 2.87335L9.74683 4.08669L10.1902 5.74002L11.8468 6.18335Z', { fill: 'black' });
    appendSvgPath(svg, 'M5.00649 13.0233L6.21649 11.81L5.77316 10.1567L4.11983 9.71332L2.90649 10.9233L3.35316 12.58L5.00649 13.0233Z', { fill: 'black' });
    return svg;
  }

  appendSvgPath(
    svg,
    'M15.5293 8.09942C15.5293 3.94104 12.1583 0.570007 7.99987 0.570007C3.84149 0.570007 0.470459 3.94104 0.470459 8.09942C0.470459 12.2578 3.84149 15.6288 7.99987 15.6288C12.1583 15.6288 15.5293 12.2578 15.5293 8.09942Z',
    { fill: 'currentColor', 'data-tone-layer': 'true' },
  );

  const maskId = `sorare-overlay-assist-mask-${marketIconInstance += 1}`;
  const definitions = svgElement('defs', {});
  const mask = svgElement('mask', {
    id: maskId,
    'mask-type': 'luminance',
    maskUnits: 'userSpaceOnUse',
    x: '0',
    y: '0',
    width: '16',
    height: '16',
  });
  appendSvgPath(
    mask,
    'M8.0816 0.956055H8.07847C4.11588 0.956055 0.903564 4.16837 0.903564 8.13096V8.13409C0.903564 12.0967 4.11588 15.309 8.07847 15.309H8.0816C12.0442 15.309 15.2565 12.0967 15.2565 8.13409V8.13096C15.2565 4.16837 12.0442 0.956055 8.0816 0.956055Z',
    { fill: 'white' },
  );
  definitions.append(mask);
  svg.append(definitions);

  const maskedBall = svgElement('g', { mask: `url(#${maskId})` });
  appendSvgPath(maskedBall, 'M13.4307 5.72661V6.84661L14.4032 7.40818L15.3758 6.84661V5.72661L14.4032 5.16504L13.4307 5.72661Z', { fill: 'black' });
  appendSvgPath(maskedBall, 'M14.4034 2.875C12.521 2.875 10.9932 4.40284 10.9932 6.2852C10.9932 7.20127 11.3571 8.03265 11.9469 8.64755L12.0065 8.71029C12.6214 9.32206 13.4716 9.69853 14.4065 9.69853C16.2888 9.69853 17.8167 8.17069 17.8167 6.28833C17.8167 4.40598 16.2888 2.87814 14.4065 2.87814L14.4034 2.875ZM16.7092 7.37069L16.6998 7.33931L15.8277 7.10716L15.1908 7.74402L15.423 8.61618H15.4387C15.1218 8.76049 14.7704 8.8452 14.4034 8.8452C13.9736 8.8452 13.5751 8.72912 13.2206 8.54088L13.4685 8.29304L13.2363 7.42088L12.3641 7.18873L12.1257 7.42716C11.9532 7.08206 11.8465 6.69931 11.8465 6.28833C11.8465 5.90873 11.9343 5.55108 12.0818 5.22794L12.8881 5.44441L13.5249 4.80755L13.3053 3.98873C13.6379 3.82873 14.0081 3.73147 14.4002 3.73147C14.7924 3.73147 15.1939 3.83814 15.539 4.01069L15.3257 4.22402L15.5579 5.09618L16.43 5.32833L16.6528 5.10559C16.841 5.4601 16.9571 5.85853 16.9571 6.28833C16.9571 6.67735 16.863 7.04441 16.7061 7.37382L16.7092 7.37069Z', { fill: 'black' });
  svg.append(maskedBall);

  appendSvgPath(
    svg,
    'M15.5293 8.09942C15.5293 3.94104 12.1583 0.570007 7.99987 0.570007C3.84149 0.570007 0.470459 3.94104 0.470459 8.09942C0.470459 12.2578 3.84149 15.6288 7.99987 15.6288C12.1583 15.6288 15.5293 12.2578 15.5293 8.09942Z',
    {
      stroke: 'currentColor',
      'stroke-width': '0.941177',
      'stroke-miterlimit': '10',
    },
  );
  appendSvgPath(svg, 'M12.5927 10.8131L10.701 8.32521L8.79038 7.83266H10.3276L9.85077 7.20521L7.8994 6.70325H9.46803L8.41391 5.31659L8.7245 4.43816L7.99038 4.75816L6.53469 5.37933L4.23509 3.07031L3.66411 3.18325L1.61548 8.16208L1.82254 8.62639L3.51666 9.23188L3.85548 10.0225L4.95352 9.54874L5.62803 9.79659L6.07352 10.8287L7.16528 10.3582L9.62803 11.2617L10.0296 12.1997L11.021 11.7731L12.2759 12.2311L12.6523 11.2021C12.6994 11.0703 12.6774 10.9229 12.5927 10.8099V10.8131Z', { fill: 'black' });
  return svg;
}

function compactMarketCell(
  market: 'goal' | 'assist',
  position: PlayerStats['position'],
  probability: MarketProbability | null,
  preview = false,
  historical?: {
    window: HistoricalAssistWindow;
    sampleSize: number;
  },
): HTMLElement {
  const cell = document.createElement('span');
  cell.className = 'market-cell';
  cell.dataset.market = market;
  cell.dataset.available = String(Boolean(probability));
  if (preview) cell.dataset.preview = 'true';
  if (historical) {
    cell.dataset.source = 'historical';
    cell.dataset.window = `L${historical.window}`;
    cell.dataset.sampleSize = String(historical.sampleSize);
  }
  const longLabel = market === 'goal' ? 'Tor' : 'Assist';
  const band = historical
    ? getMlsHistoricalMarketProbabilityBand(
        market,
        position,
        probability?.probability,
      )
    : getMlsMarketProbabilityBand(
        market,
        position,
        probability?.probability,
      );
  if (band) {
    cell.dataset.tone = band.tone;
    cell.dataset.bandLabel = band.label;
    cell.dataset.benchmarkSource = historical ? 'historical' : 'market';
  }
  const iconNode = sorareMarketIconNode(market);
  const valueNode = document.createElement('span');
  valueNode.className = 'market-value';
  const fairDecimalOdds =
    probability && probability.probability > 0
      ? compactDecimalOddsFormatter.format(1 / probability.probability)
      : null;
  const displayedValue = probability
    ? marketValueFormat === 'decimal'
      ? fairDecimalOdds ?? '—'
      : `${Math.round(probability.probability * 100)}%`
    : '—';
  valueNode.textContent =
    historical && displayedValue !== '—'
      ? `(${displayedValue})`
      : displayedValue;
  cell.setAttribute(
    'aria-label',
    historical && probability
      ? `${
          market === 'goal' ? 'Historisches Tor' : 'Historischer Assist'
        } L${historical.window}: ${Math.round(
          probability.probability * 100,
        )} Prozent${
          marketValueFormat === 'decimal' && fairDecimalOdds
            ? `, faire Dezimalquote ${fairDecimalOdds}`
            : ''
        }, n=${historical.sampleSize}; keine Marktquote`
      : preview && probability
      ? `${longLabel}: Vorschau ${Math.round(probability.probability * 100)} Prozent`
      : probability
      ? `${longLabel}: ${Math.round(probability.probability * 100)} Prozent${
          marketValueFormat === 'decimal' && fairDecimalOdds
            ? `, faire Dezimalquote ${fairDecimalOdds}`
            : ''
        }, ${probability.bookmakerCount} Buchmacher`
      : `${longLabel}: keine Marktquote`,
  );
  cell.append(iconNode);
  cell.append(valueNode);
  return cell;
}

function noL10BracketNode(message: string): HTMLElement {
  const bracket = document.createElement('div');
  bracket.className = 'market-bracket no-data-bracket';
  bracket.setAttribute('aria-label', message);
  bracket.title = message;

  const cell = document.createElement('span');
  cell.className = 'market-cell market-first market-last';
  cell.dataset.available = 'false';

  const label = document.createElement('span');
  label.className = 'market-icon no-data-market-icon';
  label.textContent = 'L10';

  const value = document.createElement('span');
  value.className = 'market-value';
  value.textContent = '—';

  cell.append(label, value);
  bracket.append(cell);
  return bracket;
}

interface HistoricalMarketSelection {
  window: HistoricalAssistWindow;
  metric: Metric;
}

type MarketBracketSlot = 'aa' | 'clean-sheet' | 'goal' | 'assist';

function marketBracketSlotSpacer(
  slot: MarketBracketSlot,
  withGroupGap = false,
): HTMLElement {
  const spacer = document.createElement('span');
  spacer.className = `market-slot-spacer${
    withGroupGap ? ' market-group-gap' : ''
  }`;
  spacer.dataset.bracketSlot = slot;
  spacer.setAttribute('aria-hidden', 'true');
  return spacer;
}

function selectedHistoricalMarket(
  stats: PlayerStats,
  market: HistoricalMarketKind,
): HistoricalMarketSelection | null {
  if (
    !historicalAssistFallbackEnabled ||
    stats.position === 'Goalkeeper' ||
    stats.nextGame?.marketOdds?.[market]
  ) {
    return null;
  }
  const metrics =
    market === 'goal' ? stats.historicalGoals : stats.historicalAssists;
  if (!metrics) return null;
  const metric =
    historicalAssistWindow === 10
      ? metrics.l10
      : historicalAssistWindow === 40
        ? metrics.l40
        : metrics.l15;
  return metric.value === null || metric.sampleSize === 0
    ? null
    : { window: historicalAssistWindow, metric };
}

function goalSortValue(
  stats: PlayerStats,
): { probability: number; source: 'market' | 'historical' } | null {
  if (stats.position === 'Goalkeeper') return null;
  const marketProbability = stats.nextGame?.marketOdds?.goal?.probability;
  if (marketProbability !== null && marketProbability !== undefined) {
    return { probability: marketProbability, source: 'market' };
  }

  const selectedHistory = selectedHistoricalMarket(stats, 'goal')?.metric;
  const historicalMetric =
    selectedHistory?.value !== null && selectedHistory?.value !== undefined
      ? selectedHistory
      : stats.goalL10;
  return historicalMetric.value !== null && historicalMetric.sampleSize > 0
    ? { probability: historicalMetric.value, source: 'historical' }
    : null;
}

function marketBracketNode(stats: PlayerStats): HTMLElement | null {
  const marketOdds = stats.nextGame?.marketOdds;
  const canShowMarkets = stats.position !== 'Goalkeeper';
  const showsCleanSheet =
    stats.position === 'Goalkeeper' || stats.position === 'Defender';
  const preview =
    canShowMarkets &&
    !marketOdds?.goal &&
    !marketOdds?.assist &&
    typeof __MARKET_ODDS_PREVIEW__ !== 'undefined' &&
    __MARKET_ODDS_PREVIEW__;
  const goal = canShowMarkets
    ? marketOdds?.goal ??
      (preview ? { probability: 0.34, bookmakerCount: 0 } : null)
    : null;
  const assist = canShowMarkets
    ? marketOdds?.assist ??
      (preview ? { probability: 0.18, bookmakerCount: 0 } : null)
    : null;
  const historicalGoal = preview
    ? null
    : selectedHistoricalMarket(stats, 'goal');
  const historicalAssist = preview
    ? null
    : selectedHistoricalMarket(stats, 'assist');
  const displayedGoal =
    goal ??
    (historicalGoal?.metric.value !== null &&
    historicalGoal?.metric.value !== undefined
      ? {
          probability: historicalGoal.metric.value,
          bookmakerCount: 0,
        }
      : null);
  const displayedAssist =
    assist ??
    (historicalAssist?.metric.value !== null &&
    historicalAssist?.metric.value !== undefined
      ? {
          probability: historicalAssist.metric.value,
          bookmakerCount: 0,
        }
      : null);
  const bracket = document.createElement('div');
  bracket.className = 'market-bracket';
  bracket.dataset.slotLayout = 'fixed';
  bracket.setAttribute(
    'aria-label',
    stats.position === 'Goalkeeper'
      ? 'Clean-Sheet-Quote'
      : stats.position === 'Defender'
        ? 'AA L10, Clean-Sheet-Quote sowie Marktquoten für Tor und Assist'
      : preview
      ? 'Designvorschau für Tor- und Assistquoten'
      : displayedGoal || displayedAssist
        ? 'Marktquoten für Tor und Assist sowie AA L10'
        : 'AA L10',
  );
  if (preview) bracket.dataset.preview = 'true';
  if (stats.position !== 'Goalkeeper') {
    if (stats.aaL10.value !== null) {
      const aaCell = aaStatNode(stats, 'top');
      aaCell.dataset.bracketSlot = 'aa';
      bracket.append(aaCell);
    } else {
      bracket.append(marketBracketSlotSpacer('aa', true));
    }
  } else {
    bracket.append(marketBracketSlotSpacer('aa', true));
  }
  if (showsCleanSheet) {
    const cleanSheetCell = cleanSheetBracketCellNode(
      stats.nextGame?.cleanSheetProbability,
    );
    cleanSheetCell.dataset.bracketSlot = 'clean-sheet';
    cleanSheetCell.classList.add('market-group-gap');
    bracket.append(cleanSheetCell);
  } else {
    bracket.append(marketBracketSlotSpacer('clean-sheet', true));
  }
  if (displayedGoal) {
    const goalCell = compactMarketCell(
      'goal',
      stats.position,
      displayedGoal,
      preview,
      historicalGoal
        ? {
            window: historicalGoal.window,
            sampleSize: historicalGoal.metric.sampleSize,
          }
        : undefined,
    );
    goalCell.dataset.bracketSlot = 'goal';
    bracket.append(goalCell);
  } else {
    bracket.append(marketBracketSlotSpacer('goal'));
  }
  if (displayedAssist) {
    const assistCell = compactMarketCell(
      'assist',
      stats.position,
      displayedAssist,
      preview,
      historicalAssist
        ? {
            window: historicalAssist.window,
            sampleSize: historicalAssist.metric.sampleSize,
          }
        : undefined,
    );
    assistCell.dataset.bracketSlot = 'assist';
    bracket.append(assistCell);
  } else {
    bracket.append(marketBracketSlotSpacer('assist'));
  }
  const stackedCells = Array.from(
    bracket.querySelectorAll<HTMLElement>(
      '.market-cell:not(.aa-bracket-cell):not(.clean-sheet-bracket-cell)',
    ),
  );
  stackedCells.at(0)?.classList.add('market-first');
  stackedCells.at(-1)?.classList.add('market-last');
  if (historicalAssist) {
    bracket.dataset.historicalAssist = `L${historicalAssist.window}`;
  }
  if (historicalGoal) {
    bracket.dataset.historicalGoal = `L${historicalGoal.window}`;
  }
  const visibleCells = Array.from(
    bracket.querySelectorAll<HTMLElement>('.market-cell'),
  );
  if (visibleCells.length === 0) return null;
  visibleCells.at(-1)?.classList.add('market-fold-end');
  bracket.dataset.foldTone =
    visibleCells.at(-1)?.dataset.tone ?? 'unavailable';
  return bracket;
}

function aaStatNode(
  stats: PlayerStats,
  placement: 'top' | 'bottom' | 'single',
): HTMLElement {
  const stat = document.createElement('span');
  stat.className = `market-cell market-last aa-percentile aa-bracket-cell${
    placement === 'single' ? '' : ` aa-bracket-${placement}`
  }`;
  stat.dataset.available = String(stats.aaL10.value !== null);
  const fallbackTopPlayer = getMlsAaTopPlayer(
    stats.position,
    stats.slug,
  );
  const topRank = stats.mlsAaContext
    ? stats.mlsAaContext.rank
    : (fallbackTopPlayer?.rank ?? null);
  const icon = document.createElement('span');
  icon.className = 'market-icon aa-market-icon';
  icon.textContent = topRank ? `#${topRank}` : 'AA';
  icon.setAttribute('aria-hidden', 'true');
  const value = document.createElement('span');
  value.className = 'market-value';
  value.textContent = score(stats.aaL10);
  stat.append(icon, value);
  const limitedClubSample = stats.aaL10.sampleSize < 10;
  if (limitedClubSample) {
    const sampleWarningReason =
      `AA ${score(stats.aaL10)} · Datenbasis: ${stats.aaL10.sampleSize}/10 gültige ` +
      `Spiele mit mindestens 60 Minuten beim aktuellen Verein. ` +
      `Andere Vereine/Nationalteam ausgeschlossen.`;
    stat.dataset.limitedSample = 'true';
    stat.dataset.clubSampleSize = String(stats.aaL10.sampleSize);
    const warning = document.createElement('span');
    warning.className = 'aa-sample-warning';
    warning.textContent = '!';
    warning.tabIndex = 0;
    warning.setAttribute('role', 'note');
    warning.setAttribute(
      'aria-label',
      `Warnung: Begrenzte AA-Datenbasis. ${sampleWarningReason}`,
    );
    const warningGlyph = svgElement('svg', {
      class: 'aa-sample-warning-glyph',
      viewBox: '0 0 12 12',
      'aria-hidden': 'true',
    });
    warningGlyph.append(
      svgElement('path', {
        d: 'M5.15 1.1h1.7l-.35 6H5.5z',
      }),
      svgElement('circle', {
        cx: '6',
        cy: '9.7',
        r: '1.05',
      }),
    );
    const warningTooltip = document.createElement('span');
    warningTooltip.className = 'aa-sample-warning-tooltip';
    warningTooltip.setAttribute('aria-hidden', 'true');
    const warningTitle = document.createElement('span');
    warningTitle.className = 'aa-sample-warning-title';
    warningTitle.textContent = 'Begrenzte AA-Datenbasis';
    const warningDetail = document.createElement('span');
    warningDetail.className = 'aa-sample-warning-detail';
    warningDetail.textContent = sampleWarningReason;
    warningTooltip.append(warningTitle, warningDetail);
    warning.append(warningGlyph, warningTooltip);
    stat.append(warning);
  }
  if (topRank) {
    stat.dataset.topRank = String(topRank);
    stat.dataset.podiumFrame =
      topRank === 1
        ? 'gold'
        : topRank === 2
          ? 'silver'
          : 'bronze';
  }
  const fallbackBand = getMlsAaPercentileBand(
    stats.position,
    stats.aaL10.value,
    stats.aaL10.sampleSize,
  );
  const tone = stats.mlsAaContext
    ? stats.mlsAaContext.tone
    : (fallbackBand?.tone ?? null);
  const percentileBand = stats.mlsAaContext
    ? stats.mlsAaContext.percentileBand
    : (fallbackBand?.label ?? null);
  if (!tone || !percentileBand) {
    stat.dataset.tone = 'unavailable';
    stat.setAttribute(
      'aria-label',
      `AA L10 ${score(stats.aaL10)}: keine belastbare MLS-Perzentileinstufung${
        limitedClubSample
          ? `; Warnung: nur ${stats.aaL10.sampleSize} Vereinsspiele mit mindestens 60 Minuten`
          : ''
      }`,
    );
    return stat;
  }
  stat.dataset.tone = tone;
  stat.dataset.percentileBand = percentileBand;
  stat.setAttribute(
    'aria-label',
    `AA L10 ${score(stats.aaL10)} im MLS-Vergleich für ${stats.position}: ${percentileBand}${
      topRank ? `, Rang ${topRank}` : ''
    }${stats.mlsAaContext ? `, Stand ${stats.mlsAaContext.asOf}` : ''}${
      limitedClubSample
        ? `; Warnung: nur ${stats.aaL10.sampleSize} Vereinsspiele mit mindestens 60 Minuten`
        : ''
    }`,
  );
  return stat;
}

function cleanSheetBracketCellNode(
  probability: number | null | undefined,
): HTMLElement {
  const cell = document.createElement('span');
  cell.className =
    'market-cell market-first market-last clean-sheet-bracket-cell';
  const available = probability !== null && probability !== undefined;
  cell.dataset.available = String(available);
  cell.dataset.cleanSheet = 'true';
  const icon = document.createElement('span');
  icon.className = 'market-icon cs-market-icon';
  icon.textContent = 'CS';
  icon.setAttribute('aria-hidden', 'true');
  const value = document.createElement('span');
  value.className = 'market-value';
  value.textContent = available
    ? `${Math.round(probability * 100)}%`
    : '—';
  const band = getMlsCleanSheetPercentileBand(
    available ? probability : null,
  );
  if (band) {
    cell.dataset.tone = band.tone;
    cell.dataset.percentileBand = band.label;
  }
  cell.setAttribute(
    'aria-label',
    available
      ? `Next Clean Sheet: ${Math.round(probability * 100)} Prozent${
          band ? `, MLS-Vergleich ${band.label}` : ''
        }`
      : 'Next Clean Sheet: keine Quote',
  );
  const content = document.createElement('span');
  content.className = 'clean-sheet-content';
  content.append(icon, value);
  cell.append(content);
  return cell;
}

interface VisibleRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function clipsOverflow(value: string): boolean {
  return /^(?:auto|clip|hidden|scroll)$/.test(value);
}

function clippedAnchorRect(
  anchor: HTMLElement,
  rect: DOMRect,
): VisibleRect | null {
  const visible: VisibleRect = {
    left: Math.max(0, rect.left),
    right: Math.min(window.innerWidth, rect.right),
    top: Math.max(0, rect.top),
    bottom: Math.min(window.innerHeight, rect.bottom),
  };

  for (let ancestor = anchor.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    const clipsX = clipsOverflow(style.overflowX || style.overflow);
    const clipsY = clipsOverflow(style.overflowY || style.overflow);
    if (!clipsX && !clipsY) continue;
    const ancestorRect = ancestor.getBoundingClientRect();
    if (clipsX) {
      visible.left = Math.max(visible.left, ancestorRect.left);
      visible.right = Math.min(visible.right, ancestorRect.right);
    }
    if (clipsY) {
      visible.top = Math.max(visible.top, ancestorRect.top);
      visible.bottom = Math.min(visible.bottom, ancestorRect.bottom);
    }
  }

  return visible.right > visible.left && visible.bottom > visible.top
    ? visible
    : null;
}

function isAnchorExposed(
  container: HTMLElement,
  anchor: HTMLElement,
  rect: DOMRect,
): boolean {
  if (typeof document.elementFromPoint !== 'function') return true;

  const visible = clippedAnchorRect(anchor, rect);
  if (!visible) return false;

  // The bracket is attached to the card's top edge. If that edge has already
  // moved behind a scroll clip, keeping the fixed overlay visible would make
  // it float above Sorare's sticky toolbar while only the card footer remains.
  const topEdgeTolerance = 1;
  if (visible.top > rect.top + topEdgeTolerance) return false;

  const width = visible.right - visible.left;
  const sampleY = Math.min(
    visible.bottom - 0.5,
    Math.max(visible.top + 0.5, rect.top + Math.min(3, rect.height / 2)),
  );

  const points: ReadonlyArray<readonly [number, number]> = [
    [visible.left + width / 2, sampleY],
    [visible.left + width * 0.2, sampleY],
    [visible.right - width * 0.2, sampleY],
  ];

  return points.some(([x, y]) => {
    const exposedElement = document.elementFromPoint(x, y);
    return Boolean(
      exposedElement &&
        (exposedElement === container ||
          exposedElement === anchor ||
          container.contains(exposedElement)),
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
const packResultText = /\b(?:neuverpflichtungen|new\s+signings)\b/i;
const packCardStatusText =
  /^(?:neue\s+karte|neue\s+edition|neue\s+spielerin|neuer\s+spieler|new\s+(?:card|edition|player|signing))$/i;
const packDialogText = /\b(?:deine\s+karten|your\s+cards|neuverpflichtungen|new\s+signings)\b/i;
const packDialogHeaderText =
  /^(?:deine\s+karten|your\s+cards|neuverpflichtungen|new\s+signings)(?:\s*:\s*\d+\s*\/\s*\d+)?$/i;
const packStatusClearancePx = 10;
const miniBracketCardWidthPx = 88;
const packReservedStatusHeightPx = 24;
const packDialogHeaderClearancePx = 6;
const packOverlayMinimumHeightPx = 22;
const packBracketStableFrames = 6;
const packResultMinimumSettleFrames = 30;
const packBracketMaximumSettleFrames = 240;

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

function hasMatchingTextNode(element: Element, pattern: RegExp): boolean {
  const walker = element.ownerDocument.createTreeWalker(element, 4);
  let node = walker.nextNode();
  while (node) {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text && pattern.test(text)) return true;
    node = walker.nextNode();
  }
  return false;
}

function isPackResultScope(scope: Element): boolean {
  return (
    packResultText.test(normalizedElementText(scope)) ||
    hasMatchingTextNode(scope, packResultText)
  );
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
  const insidePackDialog = dialog
    ? packDialogText.test(normalizedElementText(dialog)) ||
      hasMatchingTextNode(dialog, packDialogText)
    : false;
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
  // The pack result grid is nested more deeply than the individual reveal.
  // Its semantic "Neuverpflichtungen / New signings" heading lives on the
  // dialog rather than in each card branch, so keep the dialog as a safe
  // fallback instead of treating the result cards as ordinary page cards.
  return insidePackDialog ? dialog : null;
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

function packOverlayStabilityRect(
  container: HTMLElement,
  panel: HTMLElement,
  packScope: HTMLElement,
): DOMRect {
  if (
    !panel.classList.contains('bracket-only') &&
    !isPackResultScope(packScope)
  ) {
    const decisionAnchor = packCardDecisionAnchor(packScope);
    if (decisionAnchor) return decisionAnchor.getBoundingClientRect();
  }
  return (
    visibleCardImageRect(container) ??
    container.getBoundingClientRect()
  );
}

function packDialogHeader(scope: HTMLElement): HTMLElement | null {
  const dialog =
    scope.closest<HTMLElement>('dialog, [role="dialog"], [aria-modal="true"]') ??
    scope;
  const candidates = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'h1, h2, h3, [role="heading"], div',
    ),
  ).filter(
    (candidate) =>
      packDialogHeaderText.test(normalizedElementText(candidate)) &&
      isVisiblePackAnchor(candidate, dialog),
  );
  const deepestCandidates = candidates.filter(
    (candidate) =>
      !candidates.some(
        (nested) => nested !== candidate && candidate.contains(nested),
      ),
  );
  return [...deepestCandidates].sort(
    (left, right) =>
      right.getBoundingClientRect().bottom -
      left.getBoundingClientRect().bottom,
  )[0] ?? null;
}

function packHeaderSafeAnchorTop(
  scope: HTMLElement,
  desiredAnchorTop: number,
  panelHeight: number,
): { top: number; clamped: boolean } {
  const header = packDialogHeader(scope);
  if (!header) return { top: desiredAnchorTop, clamped: false };
  const headerRect = header.getBoundingClientRect();
  const minimumAnchorTop =
    headerRect.bottom +
    packDialogHeaderClearancePx +
    Math.max(packOverlayMinimumHeightPx, panelHeight);
  return {
    top: Math.max(desiredAnchorTop, minimumAnchorTop),
    clamped: desiredAnchorTop < minimumAnchorTop,
  };
}

function isVisiblyRendered(
  container: HTMLElement,
  rect: DOMRect,
  anchor: HTMLElement = container,
  modalScope = activeModalScope(),
): boolean {
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
  if (modalScope && !modalScope.contains(container)) return false;
  if (container.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  if (typeof container.checkVisibility === 'function') {
    if (!container.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
      return false;
    }
    return isAnchorExposed(container, anchor, rect);
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
  return isAnchorExposed(container, anchor, rect);
}

interface OverlayPositionContext {
  modalScope: HTMLElement | null;
}

interface PositionedOverlay {
  readonly host: HTMLElement;
  isViewportPriorityActive(): boolean;
  refreshPositionNow(context: OverlayPositionContext): void;
  hideUntilPositionRefresh?(): void;
  handleLayoutMotionStart?(event: Event): void;
}

const positionedOverlays = new Set<PositionedOverlay>();
const pendingPositionedOverlays = new Set<PositionedOverlay>();
const layoutMotionEvents = [
  'animationstart',
  'animationiteration',
  'animationend',
  'animationcancel',
  'transitionrun',
  'transitionstart',
  'transitionend',
  'transitioncancel',
] as const;
const overlayMountSelector =
  '[data-sorare-overlay-root], [data-sorare-overlay-companion]';
let positionFrame: number | undefined;
let positionListenersAttached = false;
let marketBracketSide: MarketBracketSide = 'right';
let historicalAssistFallbackEnabled = false;
let historicalAssistWindow: HistoricalAssistWindow = 15;
let marketValueFormat: MarketValueFormat = 'percentage';
let marketBracketCompactView = false;
const lineupOddsOwners = new WeakMap<HTMLElement, OverlayView>();

function requestPositionFrame(callback: () => void): number {
  if (typeof window.requestAnimationFrame === 'function') {
    return window.requestAnimationFrame(callback);
  }
  return window.setTimeout(callback, 0);
}

function cancelPositionFrame(frame: number): void {
  if (typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(frame);
  } else {
    window.clearTimeout(frame);
  }
}

function cardRectsMatch(left: DOMRect, right: DOMRect): boolean {
  const tolerance = 0.25;
  return (
    Math.abs(left.top - right.top) <= tolerance &&
    Math.abs(left.left - right.left) <= tolerance &&
    Math.abs(left.width - right.width) <= tolerance &&
    Math.abs(left.height - right.height) <= tolerance
  );
}

function snapshotCardRect(rect: DOMRect): DOMRect {
  return {
    x: rect.x,
    y: rect.y,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
    width: rect.width,
    height: rect.height,
    toJSON: () => ({}),
  } as DOMRect;
}

function isPrimarySinglePackCard(
  container: HTMLElement,
  cardImage: VisibleCardImage,
): boolean {
  const dialog = container.closest<HTMLElement>(
    'dialog, [role="dialog"], [aria-modal="true"]',
  );
  if (!dialog || isPackResultScope(dialog)) {
    return true;
  }

  const candidates = Array.from(
    dialog.querySelectorAll<HTMLImageElement>('img[alt]'),
  )
    .filter((image) => sorareCardImageAlt.test(image.alt))
    .map((image) => ({ image, rect: image.getBoundingClientRect() }))
    .filter(
      ({ rect }) =>
        rect.width >= 40 &&
        rect.height >= 60 &&
        rect.bottom > 0 &&
        rect.top < window.innerHeight,
    );
  if (candidates.length <= 1) return true;

  const viewportCenter = window.innerWidth / 2;
  const primary = candidates.reduce((closest, candidate) => {
    const closestDistance = Math.abs(
      closest.rect.left + closest.rect.width / 2 - viewportCenter,
    );
    const candidateDistance = Math.abs(
      candidate.rect.left + candidate.rect.width / 2 - viewportCenter,
    );
    return candidateDistance < closestDistance ? candidate : closest;
  });
  return primary.image === cardImage.image;
}

function schedulePositionsAfterLayoutMotion(event: Event): void {
  if (
    event.target instanceof Element &&
    event.target.closest(overlayMountSelector)
  ) {
    return;
  }
  if (
    event.type === 'animationstart' ||
    event.type === 'transitionrun' ||
    event.type === 'transitionstart'
  ) {
    for (const view of positionedOverlays) {
      if (view.isViewportPriorityActive()) {
        view.handleLayoutMotionStart?.(event);
      }
    }
  }
  scheduleAllOverlayPositions();
}

function detachPositionListeners(): void {
  if (!positionListenersAttached) return;
  window.removeEventListener('resize', scheduleAllOverlayPositions);
  window.removeEventListener('scroll', scheduleAllOverlayPositions, true);
  for (const eventName of layoutMotionEvents) {
    window.removeEventListener(
      eventName,
      schedulePositionsAfterLayoutMotion,
      true,
    );
  }
  positionListenersAttached = false;
}

function unregisterPositionedOverlay(view: PositionedOverlay): void {
  positionedOverlays.delete(view);
  pendingPositionedOverlays.delete(view);
  if (positionedOverlays.size > 0) return;
  detachPositionListeners();
  if (positionFrame !== undefined) {
    cancelPositionFrame(positionFrame);
    positionFrame = undefined;
  }
}

function flushOverlayPositions(): void {
  positionFrame = undefined;
  const views = [...pendingPositionedOverlays];
  pendingPositionedOverlays.clear();
  const context: OverlayPositionContext = { modalScope: activeModalScope() };
  for (const view of views) {
    if (!view.host.isConnected) {
      unregisterPositionedOverlay(view);
      continue;
    }
    if (
      positionedOverlays.has(view) &&
      view.isViewportPriorityActive()
    ) {
      view.refreshPositionNow(context);
    }
  }
}

function ensurePositionFrame(): void {
  if (positionFrame !== undefined || pendingPositionedOverlays.size === 0) return;
  positionFrame = requestPositionFrame(flushOverlayPositions);
}

function scheduleOverlayPosition(view: PositionedOverlay): void {
  if (
    !positionedOverlays.has(view) ||
    !view.isViewportPriorityActive()
  ) {
    return;
  }
  pendingPositionedOverlays.add(view);
  ensurePositionFrame();
}

function scheduleAllOverlayPositions(event?: Event): void {
  for (const view of positionedOverlays) {
    if (!view.isViewportPriorityActive()) continue;
    if (event?.type === 'scroll') view.hideUntilPositionRefresh?.();
    pendingPositionedOverlays.add(view);
  }
  ensurePositionFrame();
}

function registerPositionedOverlay(view: PositionedOverlay): void {
  for (const registered of positionedOverlays) {
    if (!registered.host.isConnected) unregisterPositionedOverlay(registered);
  }
  positionedOverlays.add(view);
  if (positionListenersAttached) return;
  window.addEventListener('resize', scheduleAllOverlayPositions);
  window.addEventListener('scroll', scheduleAllOverlayPositions, true);
  for (const eventName of layoutMotionEvents) {
    window.addEventListener(
      eventName,
      schedulePositionsAfterLayoutMotion,
      true,
    );
  }
  positionListenersAttached = true;
}

export function applyMarketBracketSide(side: MarketBracketSide): void {
  marketBracketSide = side;
  for (const host of document.querySelectorAll<HTMLElement>(
    '[data-sorare-overlay-root]',
  )) {
    host.dataset.marketBracketSide = side;
  }
}

export function applyHistoricalAssistFallbackSettings(
  enabled: boolean,
  window: HistoricalAssistWindow,
): void {
  historicalAssistFallbackEnabled = enabled;
  historicalAssistWindow = window;
}

export function applyMarketValueFormat(format: MarketValueFormat): void {
  marketValueFormat = format;
  for (const host of document.querySelectorAll<HTMLElement>(
    '[data-sorare-overlay-root]',
  )) {
    host.dataset.marketValueFormat = format;
  }
}

export function applyMarketBracketCompactView(enabled: boolean): void {
  marketBracketCompactView = enabled;
  document.documentElement.toggleAttribute(
    'data-sorare-overlay-compact-view',
    enabled,
  );
  for (const host of document.querySelectorAll<HTMLElement>(
    '[data-sorare-overlay-root]',
  )) {
    if (enabled) host.dataset.marketBracketCompactView = 'true';
    else {
      delete host.dataset.marketBracketCompactView;
      delete host.dataset.marketBracketCardHover;
    }
  }
}

export class OverlayView {
  readonly host: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly playerMarketTooltip: HTMLDivElement;
  private readonly lineupOddsHost: HTMLSpanElement;
  private readonly lineupOddsBar: HTMLDivElement;
  private readonly lineupOddsTooltip: HTMLDivElement;
  private readonly cleanupCallbacks: Array<() => void> = [];
  private readonly reposition: (context?: OverlayPositionContext) => void;
  private lineupTeamRow: HTMLElement | null = null;
  private lineupTeamHoverTargets: HTMLElement[] = [];
  private packSettleFrame: number | undefined;
  private packMotionProbeFrame: number | undefined;
  private packSettleGeneration = 0;
  private lastStablePackRect: DOMRect | null = null;
  private packLayoutPhase: 'none' | 'reveal' | 'result' = 'none';
  private viewportPriorityActive = true;
  private destroyed = false;
  private readonly openMarketBracketForCardHover = (): void => {
    if (marketBracketCompactView) {
      this.host.dataset.marketBracketCardHover = 'true';
    }
  };
  private readonly closeMarketBracketForCardHover = (): void => {
    delete this.host.dataset.marketBracketCardHover;
  };

  constructor(
    private readonly container: HTMLElement,
    identity: { slug?: string; playerName?: string },
    position?: PlayerStats['position'],
  ) {
    this.host = document.createElement('div');
    this.host.dataset.sorareOverlayRoot = 'true';
    this.host.dataset.marketBracketSide = marketBracketSide;
    this.host.dataset.marketValueFormat = marketValueFormat;
    if (marketBracketCompactView) {
      this.host.dataset.marketBracketCompactView = 'true';
    }
    if (identity.slug) this.host.dataset.playerSlug = identity.slug;
    if (identity.playerName) this.host.dataset.playerName = identity.playerName;
    if (position) this.host.dataset.position = position;
    Object.assign(this.host.style, {
      position: 'fixed',
      zIndex: '2147483000',
      pointerEvents: 'none',
      transform: 'translateY(-100%)',
    });
    this.reposition = (context): void => {
      if (usesCompactMarketBrackets(this.container)) {
        this.host.dataset.compactMarketBrackets = 'true';
      } else {
        delete this.host.dataset.compactMarketBrackets;
      }
      if (!this.container.isConnected) {
        this.host.style.display = 'none';
        this.lineupOddsHost.hidden = true;
        this.bindLineupTeamRow(null);
        this.closePlayerMarketTooltip();
        return;
      }
      if (isScoreDetailsDialogTarget(this.container)) {
        this.host.style.display = 'none';
        this.lineupOddsHost.hidden = true;
        this.bindLineupTeamRow(null);
        this.lineupOddsHost.remove();
        this.closePlayerMarketTooltip();
        this.closeLineupTooltip();
        return;
      }
      const rect = this.container.getBoundingClientRect();
      const cardImage = visibleCardImage(this.container);
      const packScope = packRevealScope(this.container);
      const wasPrimaryPackCard = this.host.dataset.packPrimary === 'true';
      const isPrimaryPackCard =
        !packScope ||
        !cardImage ||
        isPrimarySinglePackCard(this.container, cardImage);
      this.host.dataset.packReveal = String(Boolean(packScope));
      this.host.dataset.packPrimary = String(isPrimaryPackCard);
      const visibilityAnchor = cardImage?.image ?? this.container;
      const visibilityRect = cardImage?.rect ?? rect;
      const isVisible =
        isPrimaryPackCard &&
        isVisiblyRendered(
          this.container,
          visibilityRect,
          visibilityAnchor,
          context?.modalScope,
        );
      this.host.style.display = isVisible ? '' : 'none';
      if (!isVisible) {
        this.lineupOddsHost.hidden = true;
        this.bindLineupTeamRow(null);
        this.closePlayerMarketTooltip();
        this.closeLineupTooltip();
        return;
      }
      const teamRow = lineupBuilderTeamRow(this.container);
      this.bindLineupTeamRow(teamRow);
      if (
        this.host.style.display === 'none' ||
        this.lineupOddsBar.dataset.ready !== 'true' ||
        !teamRow
      ) {
        this.lineupOddsHost.hidden = true;
        this.closeLineupTooltip();
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
        if (!isVisible) this.closeLineupTooltip();
        if (isVisible) {
          this.lineupOddsHost.style.setProperty(
            '--lineup-tooltip-clearance',
            cssPixels(teamRowRect.height + 5),
          );
          if (teamRow.nextElementSibling !== this.lineupOddsHost) {
            teamRow.insertAdjacentElement('afterend', this.lineupOddsHost);
          }
        }
      }
      const nextPackLayoutPhase = !packScope
        ? 'none'
        : isPackResultScope(packScope)
          ? 'result'
          : 'reveal';
      const packLayoutPhaseChanged =
        nextPackLayoutPhase !== this.packLayoutPhase;
      this.packLayoutPhase = nextPackLayoutPhase;
      if (!packScope) this.lastStablePackRect = null;
      if (packScope) {
        this.closePlayerMarketTooltip();
        if (
          packLayoutPhaseChanged &&
          this.panel.childElementCount > 0 &&
          this.host.dataset.packSettling !== 'true'
        ) {
          this.startPackBracketSettling();
        }
      }
      const cardImageRect = cardImage?.rect ?? null;
      if (
        packScope &&
        isPrimaryPackCard &&
        !wasPrimaryPackCard &&
        this.panel.childElementCount > 0 &&
        this.host.dataset.packSettling !== 'true'
      ) {
        this.startPackBracketSettling();
      }
      if (!isPrimaryPackCard) {
        this.host.style.display = 'none';
        this.lineupOddsHost.hidden = true;
        this.closePlayerMarketTooltip();
        this.closeLineupTooltip();
      }
      const compactLeft = cardImageRect?.left ?? rect.left + 4;
      const compactWidth = Math.max(
        40,
        cardImageRect?.width ?? rect.width - 8,
      );
      this.host.dataset.horizontalAnchor = cardImageRect
        ? 'card-image'
        : 'container-inset';
      if (compactWidth < miniBracketCardWidthPx) {
        this.host.dataset.cardSize = 'mini';
      } else {
        delete this.host.dataset.cardSize;
      }
      this.host.style.left = cssPixels(compactLeft);
      this.host.style.width = cssPixels(compactWidth);
      if (
        packScope &&
        (this.panel.classList.contains('bracket-only') ||
          isPackResultScope(packScope))
      ) {
        // Once the data has rendered, the overlay is no longer a status banner:
        // its bracket belongs to the visible card. Anchoring it to Sorare's
        // animated "new card/edition" label made the bracket drift upward as
        // bonus/status animations changed height during a pack reveal.
        const cardAnchorRect = cardImageRect ?? rect;
        delete this.host.dataset.packHeaderClamped;
        this.host.dataset.placement = 'pack-card-edge';
        this.host.style.top = cssPixels(cardAnchorRect.top - 1);
        this.host.style.bottom = '';
      } else if (packScope) {
        const decisionAnchor = packCardDecisionAnchor(packScope);
        let desiredAnchorTop: number;
        if (decisionAnchor) {
          // Anchor to Sorare's semantic pack status instead of a generated CSS
          // class, leaving status/edition bonus and card unobscured.
          const anchorRect = decisionAnchor.getBoundingClientRect();
          this.host.dataset.placement = 'pack-status-above';
          desiredAnchorTop = anchorRect.top - packStatusClearancePx;
        } else {
          // Sorare can delay or visually suppress the "New card/edition"
          // label. Reserve a complete status row anyway so the overlay never
          // makes an absent label indistinguishable from a covered one.
          this.host.dataset.placement = 'pack-safe-above';
          desiredAnchorTop = rect.top - packReservedStatusHeightPx;
        }
        const safeAnchor = packHeaderSafeAnchorTop(
          packScope,
          desiredAnchorTop,
          this.panel.getBoundingClientRect().height,
        );
        this.host.style.top = cssPixels(safeAnchor.top);
        this.host.style.bottom = '';
        if (safeAnchor.clamped) {
          this.host.dataset.packHeaderClamped = 'true';
        } else {
          delete this.host.dataset.packHeaderClamped;
        }
      } else {
        delete this.host.dataset.packHeaderClamped;
        this.host.dataset.placement = 'above';
        // Anchor the overlay to the card's top edge. A `bottom` offset depends
        // on the viewport height and shifts when a horizontal scrollbar appears.
        this.host.style.top = cssPixels(rect.top - 1);
        this.host.style.bottom = '';
      }

    };
    const shadow = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = styles;
    this.panel = document.createElement('div');
    this.panel.className = 'panel';
    this.playerMarketTooltip = document.createElement('div');
    this.playerMarketTooltip.className = 'player-market-tooltip';
    this.playerMarketTooltip.hidden = true;
    this.lineupOddsHost = document.createElement('span');
    this.lineupOddsHost.dataset.sorareOverlayCompanion = 'lineup-odds';
    this.lineupOddsHost.hidden = true;
    const lineupShadow = this.lineupOddsHost.attachShadow({ mode: 'open' });
    const lineupStyle = document.createElement('style');
    lineupStyle.textContent = lineupOddsStyles;
    this.lineupOddsBar = document.createElement('div');
    this.lineupOddsBar.className = 'lineup-odds-bar';
    this.lineupOddsBar.addEventListener(
      'mouseenter',
      this.openLineupTooltip,
    );
    this.lineupOddsBar.addEventListener(
      'mouseleave',
      this.closeLineupTooltip,
    );
    this.lineupOddsTooltip = document.createElement('div');
    this.lineupOddsTooltip.className = 'lineup-odds-tooltip';
    this.lineupOddsTooltip.hidden = true;
    lineupShadow.append(
      lineupStyle,
      this.lineupOddsBar,
      this.lineupOddsTooltip,
    );
    shadow.append(style, this.panel, this.playerMarketTooltip);
    (document.body ?? document.documentElement).append(this.host);
    this.container.addEventListener(
      'mouseenter',
      this.openMarketBracketForCardHover,
    );
    this.container.addEventListener(
      'mouseleave',
      this.closeMarketBracketForCardHover,
    );
    this.cleanupCallbacks.push(() => {
      this.container.removeEventListener(
        'mouseenter',
        this.openMarketBracketForCardHover,
      );
      this.container.removeEventListener(
        'mouseleave',
        this.closeMarketBracketForCardHover,
      );
    });
    this.reposition();
    registerPositionedOverlay(this);
    this.cleanupCallbacks.push(() => unregisterPositionedOverlay(this));
    if (typeof ResizeObserver !== 'undefined') {
      const resizeObserver = new ResizeObserver(() => scheduleOverlayPosition(this));
      resizeObserver.observe(container);
      this.cleanupCallbacks.push(() => resizeObserver.disconnect());
    }
    this.loading();
  }

  refreshPosition(): void {
    if (!this.destroyed) scheduleOverlayPosition(this);
  }

  isViewportPriorityActive(): boolean {
    return this.viewportPriorityActive;
  }

  setViewportPriorityActive(active: boolean): void {
    if (this.destroyed || this.viewportPriorityActive === active) return;
    this.viewportPriorityActive = active;
    if (active) {
      scheduleOverlayPosition(this);
      return;
    }
    pendingPositionedOverlays.delete(this);
    this.host.style.display = 'none';
    this.lineupOddsHost.hidden = true;
    this.bindLineupTeamRow(null);
    this.closePlayerMarketTooltip();
    this.closeLineupTooltip();
  }

  refreshPositionNow(context: OverlayPositionContext): void {
    if (!this.destroyed && this.viewportPriorityActive) {
      this.reposition(context);
    }
  }

  hideUntilPositionRefresh(): void {
    if (this.destroyed || !this.viewportPriorityActive) return;
    this.host.style.display = 'none';
    this.lineupOddsHost.hidden = true;
    this.closePlayerMarketTooltip();
    this.closeLineupTooltip();
  }

  handleLayoutMotionStart(event: Event): void {
    if (
      this.destroyed ||
      !(event.target instanceof Element) ||
      event.target.closest('[style*="--active"]') ||
      this.host.dataset.packDataPending === 'true'
    ) {
      return;
    }
    const packScope = packRevealScope(this.container);
    if (
      !packScope ||
      (!packScope.contains(event.target) &&
        !event.target.contains(packScope)) ||
      this.panel.childElementCount === 0
    ) {
      return;
    }
    if (
      this.host.dataset.packSettling === 'true' ||
      this.packMotionProbeFrame !== undefined
    ) {
      return;
    }
    this.packMotionProbeFrame = requestPositionFrame(() => {
      this.packMotionProbeFrame = undefined;
      if (this.destroyed) return;
      const currentScope = packRevealScope(this.container);
      if (!currentScope) return;
      const currentRect = packOverlayStabilityRect(
        this.container,
        this.panel,
        currentScope,
      );
      if (
        !this.lastStablePackRect ||
        !cardRectsMatch(this.lastStablePackRect, currentRect)
      ) {
        this.startPackBracketSettling();
      }
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    setLineupGoalSortValue(this.container, null);
    this.stopPackBracketSettling();
    if (this.packMotionProbeFrame !== undefined) {
      cancelPositionFrame(this.packMotionProbeFrame);
      this.packMotionProbeFrame = undefined;
    }
    for (const cleanup of this.cleanupCallbacks) cleanup();
    this.cleanupCallbacks.length = 0;
    this.bindLineupTeamRow(null);
    this.lineupOddsHost.remove();
    this.host.remove();
  }

  loading(): void {
    this.clearLineupOdds();
    this.clearPlayerMarketTooltip();
    this.state('Lade L10 …', 'pulse');
  }

  retrying(): void {
    this.clearLineupOdds();
    this.clearPlayerMarketTooltip();
    this.state(
      'Lade L10 erneut …',
      'pulse',
      'Die letzte Anfrage ist fehlgeschlagen oder läuft im Hintergrund weiter. Die Extension versucht es automatisch erneut.',
    );
  }

  error(): void {
    this.clearLineupOdds();
    this.clearPlayerMarketTooltip();
    this.state(
      'Kurz nicht verfügbar',
      'error',
      'Die zuletzt angefragten Daten konnten nicht geladen werden. Die Extension versucht es automatisch erneut.',
    );
  }

  noData(): void {
    this.clearLineupOdds();
    this.clearPlayerMarketTooltip();
    this.state('Keine L10-Daten', 'no-data');
  }

  render(stats: PlayerStats): void {
    if (this.destroyed) return;
    const hadRenderedBracket = Boolean(
      this.panel.querySelector('.market-bracket'),
    );
    const wasPackDataPending =
      this.host.dataset.packDataPending === 'true';
    delete this.host.dataset.packDataPending;
    this.host.dataset.position = stats.position;
    if (!hasAnyDisplayData(stats)) {
      this.noData();
      return;
    }
    const sortValue = goalSortValue(stats);
    setLineupGoalSortValue(
      this.container,
      sortValue?.probability ?? null,
      sortValue?.source,
    );
    this.renderLineupOdds(stats.nextGame);
    this.renderPlayerMarketTooltip(stats);
    this.panel.replaceChildren();
    this.panel.classList.add('bracket-only');
    const marketBracket = marketBracketNode(stats);
    if (marketBracket) {
      for (const marketCell of marketBracket.querySelectorAll('[data-market]')) {
        marketCell.addEventListener(
          'mouseenter',
          this.openPlayerMarketTooltip,
        );
        marketCell.addEventListener(
          'mouseleave',
          this.closePlayerMarketTooltip,
        );
      }
      this.panel.append(marketBracket);
    }
    this.reposition();
    const packScope = packRevealScope(this.container);
    if (packScope && this.packSettleFrame === undefined) {
      const currentRect = packOverlayStabilityRect(
        this.container,
        this.panel,
        packScope,
      );
      const geometryAlreadyStable =
        this.lastStablePackRect !== null &&
        cardRectsMatch(this.lastStablePackRect, currentRect);
      if (
        wasPackDataPending ||
        !hadRenderedBracket ||
        !geometryAlreadyStable
      ) {
        this.startPackBracketSettling();
      }
    }
  }

  private stopPackBracketSettling(): void {
    this.packSettleGeneration += 1;
    if (this.packSettleFrame !== undefined) {
      cancelPositionFrame(this.packSettleFrame);
      this.packSettleFrame = undefined;
    }
    delete this.host.dataset.packSettling;
  }

  private startPackBracketSettling(): void {
    this.stopPackBracketSettling();
    const initialScope = packRevealScope(this.container);
    if (!initialScope || this.panel.childElementCount === 0) return;

    const generation = this.packSettleGeneration;
    const minimumObservedFrames = isPackResultScope(initialScope)
      ? packResultMinimumSettleFrames
      : 0;
    let previousRect: DOMRect | null = null;
    let stableFrames = 0;
    let observedFrames = 0;
    this.host.dataset.packSettling = 'true';

    const checkStability = (): void => {
      this.packSettleFrame = undefined;
      if (this.destroyed || generation !== this.packSettleGeneration) return;
      if (!this.container.isConnected) {
        this.stopPackBracketSettling();
        return;
      }

      const packScope = packRevealScope(this.container);
      if (!packScope || this.panel.childElementCount === 0) {
        this.stopPackBracketSettling();
        return;
      }

      const currentRect = packOverlayStabilityRect(
        this.container,
        this.panel,
        packScope,
      );
      stableFrames =
        previousRect && cardRectsMatch(previousRect, currentRect)
          ? stableFrames + 1
          : 0;
      previousRect = currentRect;
      observedFrames += 1;
      this.reposition();

      const stable =
        stableFrames >= packBracketStableFrames &&
        observedFrames >= minimumObservedFrames;
      const safetyLimitReached =
        observedFrames >= packBracketMaximumSettleFrames;
      if (stable || safetyLimitReached) {
        this.lastStablePackRect = snapshotCardRect(currentRect);
        delete this.host.dataset.packSettling;
        this.reposition();
        return;
      }

      this.packSettleFrame = requestPositionFrame(checkStability);
    };

    this.packSettleFrame = requestPositionFrame(checkStability);
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
    const homeTeam = document.createElement('span');
    homeTeam.className = 'tooltip-team';
    homeTeam.dataset.outcome = 'home';
    homeTeam.dataset.role = probabilities.playerIsHome ? 'player' : 'opponent';
    homeTeam.textContent = nextGame?.homeTeamName ?? 'Heimteam';
    const awayTeam = document.createElement('span');
    awayTeam.className = 'tooltip-team';
    awayTeam.dataset.outcome = 'away';
    awayTeam.dataset.role = probabilities.playerIsAway ? 'player' : 'opponent';
    awayTeam.textContent = nextGame?.awayTeamName ?? 'Auswärtsteam';
    const separator = document.createElement('span');
    separator.className = 'tooltip-separator';
    separator.textContent = '–';
    const fixture = document.createElement('div');
    fixture.className = 'tooltip-fixture';
    fixture.append(homeTeam, separator, awayTeam);
    const odds = document.createElement('div');
    odds.className = 'tooltip-odds';
    odds.append(
      ...values.map(({ outcome, value, role }) => {
        const odd = document.createElement('span');
        odd.className = 'tooltip-odd';
        odd.dataset.outcome = outcome;
        odd.dataset.role = role;
        const prefix = outcome === 'home' ? 'H' : outcome === 'draw' ? 'D' : 'A';
        odd.textContent = `${prefix} ${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
        return odd;
      }),
    );
    const tooltipLabel = document.createElement('div');
    tooltipLabel.className = 'tooltip-label';
    tooltipLabel.textContent = 'Quoten';
    this.lineupOddsTooltip.replaceChildren(
      tooltipLabel,
      fixture,
      odds,
    );
    this.lineupOddsTooltip.hidden = false;
    this.lineupOddsBar.dataset.ready = 'true';
  }

  private renderPlayerMarketTooltip(stats: PlayerStats): void {
    const bookmakerMarkets = document.createElement('div');
    bookmakerMarkets.className = 'bookmaker-markets';
    const goalMarket = bookmakerMarketNode(
      'Tor',
      stats.nextGame?.marketOdds?.goal,
    );
    const assistMarket = bookmakerMarketNode(
      'Assist',
      stats.nextGame?.marketOdds?.assist,
    );
    const historicalGoalMarket = historicalMarketNode(
      'goal',
      selectedHistoricalMarket(stats, 'goal'),
    );
    const historicalAssistMarket = historicalMarketNode(
      'assist',
      selectedHistoricalMarket(stats, 'assist'),
    );
    if (goalMarket) bookmakerMarkets.append(goalMarket);
    if (assistMarket) bookmakerMarkets.append(assistMarket);
    if (historicalGoalMarket) {
      bookmakerMarkets.append(historicalGoalMarket);
    }
    if (historicalAssistMarket) {
      bookmakerMarkets.append(historicalAssistMarket);
    }
    if (bookmakerMarkets.childElementCount === 0) {
      this.clearPlayerMarketTooltip();
      return;
    }
    const tooltipLabel = document.createElement('div');
    tooltipLabel.className = 'tooltip-label';
    tooltipLabel.textContent =
      historicalGoalMarket || historicalAssistMarket
      ? 'Spielerquoten & Historie'
      : 'Spielerquoten';
    this.playerMarketTooltip.replaceChildren(
      tooltipLabel,
      bookmakerMarkets,
    );
    this.playerMarketTooltip.hidden = false;
  }

  private clearPlayerMarketTooltip(): void {
    this.playerMarketTooltip.replaceChildren();
    this.playerMarketTooltip.hidden = true;
    this.closePlayerMarketTooltip();
  }

  private clearLineupOdds(): void {
    this.lineupOddsBar.replaceChildren();
    this.lineupOddsTooltip.replaceChildren();
    this.lineupOddsTooltip.hidden = true;
    this.closeLineupTooltip();
    delete this.lineupOddsBar.dataset.ready;
    this.lineupOddsHost.hidden = true;
  }

  private readonly openLineupTooltip = (): void => {
    if (
      this.lineupOddsBar.dataset.ready === 'true' &&
      !this.lineupOddsTooltip.hidden
    ) {
      this.closePlayerMarketTooltip();
      this.lineupOddsHost.dataset.tooltipOpen = 'true';
    }
  };

  private readonly closeLineupTooltip = (): void => {
    delete this.lineupOddsHost.dataset.tooltipOpen;
  };

  private readonly openPlayerMarketTooltip = (): void => {
    if (
      this.playerMarketTooltip.hidden ||
      this.host.dataset.packReveal === 'true'
    ) {
      return;
    }
    this.closeLineupTooltip();
    const panelRect = this.panel.getBoundingClientRect();
    const tooltipRect = this.playerMarketTooltip.getBoundingClientRect();
    const tooltipWidth = tooltipRect.width || 170;
    const panelCenter = panelRect.left + panelRect.width / 2;
    const viewportPadding = 6;
    const minimumCenter = tooltipWidth / 2 + viewportPadding;
    const maximumCenter = Math.max(
      minimumCenter,
      window.innerWidth - tooltipWidth / 2 - viewportPadding,
    );
    const clampedCenter = Math.min(
      maximumCenter,
      Math.max(minimumCenter, panelCenter),
    );
    this.host.style.setProperty(
      '--player-tooltip-shift-x',
      cssPixels(clampedCenter - panelCenter),
    );
    this.host.dataset.playerMarketTooltipPlacement =
      panelRect.top >= tooltipRect.height + 8 ? 'above' : 'below';
    this.host.dataset.playerMarketTooltipOpen = 'true';
  };

  private readonly closePlayerMarketTooltip = (): void => {
    delete this.host.dataset.playerMarketTooltipOpen;
  };

  private bindLineupTeamRow(teamRow: HTMLElement | null): void {
    if (
      teamRow &&
      lineupOddsOwners.has(teamRow) &&
      lineupOddsOwners.get(teamRow) !== this
    ) {
      teamRow = null;
    }
    const nextHoverTargets = teamRow
      ? Array.from(
          teamRow.querySelectorAll<HTMLElement>('[aria-label="Team"]'),
        )
      : [];
    if (
      this.lineupTeamRow === teamRow &&
      nextHoverTargets.length === this.lineupTeamHoverTargets.length &&
      nextHoverTargets.every(
        (target, index) => target === this.lineupTeamHoverTargets[index],
      )
    ) {
      return;
    }
    for (const target of this.lineupTeamHoverTargets) {
      target.removeEventListener('mouseenter', this.openLineupTooltip);
      target.removeEventListener('mouseleave', this.closeLineupTooltip);
    }
    const previousTeamRow = this.lineupTeamRow;
    if (
      previousTeamRow &&
      lineupOddsOwners.get(previousTeamRow) === this
    ) {
      lineupOddsOwners.delete(previousTeamRow);
    }
    this.lineupTeamRow = teamRow;
    if (teamRow) lineupOddsOwners.set(teamRow, this);
    this.lineupTeamHoverTargets = nextHoverTargets;
    this.closeLineupTooltip();
    for (const target of this.lineupTeamHoverTargets) {
      target.addEventListener('mouseenter', this.openLineupTooltip);
      target.addEventListener('mouseleave', this.closeLineupTooltip);
    }
  }

  private state(
    message: string,
    modifier: string,
    title?: string,
  ): void {
    if (this.destroyed) return;
    setLineupGoalSortValue(this.container, null);
    this.stopPackBracketSettling();
    this.panel.replaceChildren();
    if (modifier === 'no-data') {
      this.panel.classList.add('bracket-only');
      this.panel.append(noL10BracketNode(message));
    } else {
      this.panel.classList.remove('bracket-only');
      const state = document.createElement('div');
      state.className = `state ${modifier}`.trim();
      state.textContent = message;
      if (title) state.title = title;
      this.panel.append(state);
    }
    this.reposition();
    if (!packRevealScope(this.container)) {
      delete this.host.dataset.packDataPending;
      return;
    }
    if (modifier === 'pulse') {
      this.host.dataset.packDataPending = 'true';
      this.host.dataset.packSettling = 'true';
      return;
    }
    delete this.host.dataset.packDataPending;
    this.startPackBracketSettling();
  }
}
