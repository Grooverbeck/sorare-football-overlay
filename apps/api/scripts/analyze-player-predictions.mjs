import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  PlayerStatsSchema,
  PlayerStatsSuccessResponseSchema,
} from '@sorare-overlay/shared';
import {
  calculatePlayerPrediction,
} from '@sorare-overlay/shared/player-prediction';

const DEFAULT_API_URL =
  'https://sorare-football-overlay-api.grooverbeck.workers.dev/api/player-stats';

const positionAliases = new Map([
  ['gk', 'Goalkeeper'],
  ['goalkeeper', 'Goalkeeper'],
  ['tw', 'Goalkeeper'],
  ['def', 'Defender'],
  ['defender', 'Defender'],
  ['df', 'Defender'],
  ['mid', 'Midfielder'],
  ['midfielder', 'Midfielder'],
  ['mf', 'Midfielder'],
  ['fwd', 'Forward'],
  ['forward', 'Forward'],
  ['fw', 'Forward'],
]);

function printHelp() {
  console.log(`
Separate Spieler-Prognose (kein Bestandteil des Browser-Overlays)

Live-Daten laden:
  npm run analyze:player-prediction -- --player slug:Position [--player ...]

Gespeicherte API-Antwort auswerten:
  npm run analyze:player-prediction -- --input pfad/zur/antwort.json

Optionen:
  -p, --player <slug:Position>  Wiederholbar; Position z. B. FWD, MID, DEF, GK
      --input <datei>           PlayerStats-Array oder API-Erfolgsantwort
      --api-url <url>           Standard: PREDICTION_API_URL oder Produktions-API
      --refresh-fixtures        Fehlende/abgelaufene nächste Spiele synchron laden
      --json                    Vollständige, versionierte JSON-Ausgabe
  -h, --help                    Diese Hilfe anzeigen
`);
}

function normalizePosition(raw) {
  const position = positionAliases.get(raw.trim().toLowerCase());
  if (!position) {
    throw new Error(
      `Unbekannte Position "${raw}". Erlaubt sind FWD, MID, DEF und GK.`,
    );
  }
  return position;
}

export function parsePlayerSpec(spec) {
  const separator = spec.lastIndexOf(':');
  if (separator <= 0 || separator === spec.length - 1) {
    throw new Error(
      `Ungültiger Spieler "${spec}". Erwartet wird slug:Position.`,
    );
  }
  return {
    slug: spec.slice(0, separator).trim().toLowerCase(),
    position: normalizePosition(spec.slice(separator + 1)),
  };
}

export function predictionFromPlayerStats(stats) {
  return calculatePlayerPrediction({
    position: stats.position,
    aa: stats.aaL10,
    goalMarket: stats.nextGame?.marketOdds?.goal ?? null,
    assistMarket: stats.nextGame?.marketOdds?.assist ?? null,
    historicalGoalL15: stats.historicalGoals?.l15 ?? null,
    historicalAssistL15: stats.historicalAssists?.l15 ?? null,
    cleanSheetProbability: stats.nextGame?.cleanSheetProbability ?? null,
  });
}

async function loadPlayersFromFile(filename) {
  const raw = JSON.parse(await readFile(resolve(filename), 'utf8'));
  const response = PlayerStatsSuccessResponseSchema.safeParse(raw);
  if (response.success) return response.data.data;
  return PlayerStatsSchema.array().parse(raw);
}

async function loadPlayersFromApi(playerSpecs, apiUrl, refreshFixtures) {
  const players = playerSpecs.map(parsePlayerSpec);
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      slugs: players.map(({ slug }) => slug),
      positions: Object.fromEntries(
        players.map(({ slug, position }) => [slug, position]),
      ),
      includeHistoricalAssists: true,
      supportsPartialFormHistory: false,
      refreshFixtures,
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    const message = body?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`Spielerdaten konnten nicht geladen werden: ${message}`);
  }
  return PlayerStatsSuccessResponseSchema.parse(body).data;
}

function formatProbability(component) {
  return component.probability === null
    ? '—'
    : `${Math.round(component.probability * 100)}%`;
}

function formatIndex(prediction) {
  if (prediction.index === null) return '—';
  return prediction.unit === 'normalized_probability'
    ? `${Math.round(prediction.index * 100)}%`
    : prediction.index.toFixed(1);
}

function printTable(results) {
  console.table(
    results.map(({ player, prediction }) => ({
      Spieler: player.displayName,
      Position: player.position,
      Prognose: formatIndex(prediction),
      Status: prediction.complete
        ? 'vollständig'
        : `unvollständig (${prediction.missingComponents.join(', ')})`,
      AA: prediction.aa.value ?? '—',
      Tor: formatProbability(prediction.goal),
      Torquelle: prediction.goal.source,
      Assist: formatProbability(prediction.assist),
      Assistquelle: prediction.assist.source,
      CS: formatProbability(prediction.cleanSheet),
    })),
  );
  console.log(
    '\nHinweis: Die Indizes sind nur innerhalb derselben Position vergleichbar.',
  );
}

async function main() {
  const { values } = parseArgs({
    options: {
      player: { type: 'string', short: 'p', multiple: true },
      input: { type: 'string' },
      'api-url': { type: 'string' },
      'refresh-fixtures': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    printHelp();
    return;
  }
  if (values.input && values.player?.length) {
    throw new Error('--input und --player können nicht kombiniert werden.');
  }
  if (!values.input && !values.player?.length) {
    printHelp();
    throw new Error('Mindestens --player oder --input ist erforderlich.');
  }

  const apiUrl =
    values['api-url'] ?? process.env.PREDICTION_API_URL ?? DEFAULT_API_URL;
  const players = values.input
    ? await loadPlayersFromFile(values.input)
    : await loadPlayersFromApi(
        values.player,
        apiUrl,
        values['refresh-fixtures'],
      );
  const results = players.map((player) => ({
    player,
    prediction: predictionFromPlayerStats(player),
  }));

  if (values.json) {
    console.log(
      JSON.stringify(
        results.map(({ player, prediction }) => ({
          slug: player.slug,
          displayName: player.displayName,
          position: player.position,
          fixtureDate: player.nextGame?.date ?? null,
          prediction,
        })),
        null,
        2,
      ),
    );
    return;
  }
  printTable(results);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
