const apiKey = process.env.THE_ODDS_API_KEY;
if (!apiKey) {
  throw new Error('THE_ODDS_API_KEY is required.');
}

const baseUrl =
  process.env.ODDS_API_BASE_URL ?? 'https://api.the-odds-api.com/v4';
const sportKey = process.env.ODDS_API_SPORT_KEY ?? 'soccer_usa_mls';
const regions = (process.env.PROPS_REGIONS ?? 'us,us2,uk,eu,au')
  .split(',')
  .map((region) => region.trim())
  .filter(Boolean);
const targetFamilyName = normalize(process.env.PROPS_TARGET ?? 'Choiniere');
const now = Date.now();
const from = Date.parse(
  process.env.PROPS_FROM ?? new Date(now - 12 * 60 * 60 * 1_000).toISOString(),
);
const to = Date.parse(
  process.env.PROPS_TO ?? new Date(now + 48 * 60 * 60 * 1_000).toISOString(),
);
let lastQuota = null;

function normalize(value) {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function eventLabel(event) {
  return `${event.home_team} - ${event.away_team}`;
}

function quotaFrom(headers) {
  return {
    used: headers.get('x-requests-used'),
    remaining: headers.get('x-requests-remaining'),
    last: headers.get('x-requests-last'),
  };
}

async function fetchJson(url) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
    });
    lastQuota = quotaFrom(response.headers);
    if (
      (response.status === 429 || [502, 503, 504].includes(response.status)) &&
      attempt < 3
    ) {
      await response.body?.cancel();
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(8_000, 500 * 2 ** attempt)),
      );
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { status: response.status, body: null };
    }
    return { status: response.status, body: await response.json() };
  }
  return { status: 599, body: null };
}

async function loadEvents() {
  const url = new URL(
    `${baseUrl.replace(/\/$/, '')}/sports/${encodeURIComponent(
      sportKey,
    )}/events`,
  );
  url.searchParams.set('apiKey', apiKey);
  const response = await fetchJson(url);
  if (!response.body) {
    throw new Error(`The Odds API events request failed (${response.status}).`);
  }
  return response.body
    .filter((event) => {
      const kickoff = Date.parse(event.commence_time);
      return kickoff >= from && kickoff < to;
    })
    .sort(
      (left, right) =>
        Date.parse(left.commence_time) - Date.parse(right.commence_time),
    );
}

async function loadMarket(event, region, market) {
  const url = new URL(
    `${baseUrl.replace(/\/$/, '')}/sports/${encodeURIComponent(
      sportKey,
    )}/events/${encodeURIComponent(event.id)}/odds`,
  );
  url.searchParams.set('apiKey', apiKey);
  url.searchParams.set('regions', region);
  url.searchParams.set('markets', market);
  url.searchParams.set('oddsFormat', 'decimal');
  return fetchJson(url);
}

function positiveOutcome(outcome) {
  const name = normalize(outcome.name);
  return !['no', 'under'].includes(name);
}

function playerName(outcome) {
  if (outcome.description) return String(outcome.description);
  const name = normalize(outcome.name);
  if (['yes', 'no', 'over', 'under'].includes(name)) return null;
  return String(outcome.name);
}

function extractMarket(payload, marketKey) {
  const quotes = [];
  for (const bookmaker of payload?.bookmakers ?? []) {
    for (const market of bookmaker.markets ?? []) {
      if (market.key !== marketKey) continue;
      for (const outcome of market.outcomes ?? []) {
        const name = playerName(outcome);
        if (!name || !positiveOutcome(outcome) || !(outcome.price > 1)) {
          continue;
        }
        quotes.push({
          player: name,
          bookmaker: bookmaker.title,
          bookmakerKey: bookmaker.key,
          decimalOdds: outcome.price,
          rawProbability: 1 / outcome.price,
        });
      }
    }
  }
  return quotes;
}

function uniquePlayers(quotes) {
  return new Set(quotes.map((quote) => normalize(quote.player))).size;
}

async function mapWithConcurrency(values, concurrency, worker) {
  const output = new Array(values.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        output[index] = await worker(values[index], index);
      }
    },
  );
  await Promise.all(runners);
  return output;
}

const events = await loadEvents();
const targetEvent = events.find((event) => {
  const teams = `${normalize(event.home_team)} ${normalize(event.away_team)}`;
  return (
    (teams.includes('lafc') || teams.includes('los angeles')) &&
    teams.includes('sporting kansas city')
  );
});
if (!targetEvent) {
  throw new Error('LAFC - Sporting Kansas City was not found.');
}

const regionResults = {};
for (const region of regions) {
  const assistRows = await mapWithConcurrency(events, 3, async (event) => {
    const response = await loadMarket(event, region, 'player_assists');
    const quotes = response.body
      ? extractMarket(response.body, 'player_assists')
      : [];
    return {
      fixture: eventLabel(event),
      status: response.status,
      bookmakers: new Set(quotes.map((quote) => quote.bookmaker)).size,
      players: uniquePlayers(quotes),
      targetQuotes: quotes.filter((quote) =>
        normalize(quote.player).includes(targetFamilyName),
      ),
    };
  });
  const goalResponse = await loadMarket(
    targetEvent,
    region,
    'player_goal_scorer_anytime',
  );
  const goalQuotes = goalResponse.body
    ? extractMarket(goalResponse.body, 'player_goal_scorer_anytime')
    : [];
  regionResults[region] = {
    assistFixtures: assistRows.filter((row) => row.players > 0).length,
    assistPlayers: assistRows.reduce((total, row) => total + row.players, 0),
    assistDetails: assistRows
      .filter((row) => row.players > 0)
      .map(({ fixture, bookmakers, players }) => ({
        fixture,
        bookmakers,
        players,
      })),
    targetAssistQuotes: assistRows.flatMap((row) => row.targetQuotes),
    targetGoalQuotes: goalQuotes.filter((quote) =>
      normalize(quote.player).includes(targetFamilyName),
    ),
  };
}

console.log(
  JSON.stringify(
    {
      scannedAt: new Date().toISOString(),
      eventCount: events.length,
      regions,
      targetFixture: eventLabel(targetEvent),
      regionResults,
      quota: lastQuota,
    },
    null,
    2,
  ),
);
