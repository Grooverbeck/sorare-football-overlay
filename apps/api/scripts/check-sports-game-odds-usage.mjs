import { sportsGameOddsQuotaUsage } from '../src/providers/sports-game-odds-provider.ts';

const apiKey = process.env.SPORTS_GAME_ODDS_API_KEY?.trim();
if (!apiKey) {
  throw new Error(
    'SPORTS_GAME_ODDS_API_KEY fehlt. Hinterlege den Key in apps/api/.dev.vars.',
  );
}

const baseUrl = (
  process.env.SPORTS_GAME_ODDS_BASE_URL ??
  'https://api.sportsgameodds.com/v2'
).replace(/\/+$/, '');
const checkedAt = new Date().toISOString();
const response = await fetch(`${baseUrl}/account/usage`, {
  headers: {
    'X-Api-Key': apiKey,
  },
  signal: AbortSignal.timeout(10_000),
});
const body = await response.json();
if (!response.ok) {
  throw new Error(
    `SportsGameOdds Usage-Abfrage fehlgeschlagen (HTTP ${response.status}).`,
  );
}

const usage = sportsGameOddsQuotaUsage(body, checkedAt);
if (!usage) {
  throw new Error(
    'SportsGameOdds hat kein auswertbares monatliches Objektlimit geliefert.',
  );
}

const formatTimestamp = (value) =>
  new Intl.DateTimeFormat('de-DE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Berlin',
  }).format(new Date(value));

let period;
if (usage.interval.startsAt && usage.interval.endsAt) {
  period = `${formatTimestamp(usage.interval.startsAt)} – ${formatTimestamp(
    usage.interval.endsAt,
  )}`;
} else if (usage.interval.endsAt) {
  period = `bis ${formatTimestamp(usage.interval.endsAt)} (Start nicht übermittelt)`;
} else {
  period =
    'monatliches Anbieterintervall; genauer Start und Reset werden nicht übermittelt';
}

const usagePercent = Math.round((usage.used / usage.limit) * 1_000) / 10;
console.log(
  [
    'SportsGameOdds Usage',
    `Intervall: monatlich`,
    `Zeitraum: ${period}`,
    `Nutzung: ${usage.used} / ${usage.limit} Objekte (${usagePercent} %)`,
    `Verbleibend: ${usage.remaining} Objekte`,
    `Abgefragt: ${formatTimestamp(usage.checkedAt)}`,
  ].join('\n'),
);
