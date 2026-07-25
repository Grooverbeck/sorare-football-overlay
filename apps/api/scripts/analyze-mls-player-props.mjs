import {
  normalizePlayerName,
  normalizeTeamName,
  playerNameMatchScore,
} from '../src/providers/market-odds-provider.ts';

const oddsApiKey = process.env.THE_ODDS_API_KEY;
const propsFeedUrl = process.env.PROPS_FEED_URL;
if (!oddsApiKey && !propsFeedUrl) {
  throw new Error(
    'THE_ODDS_API_KEY or PROPS_FEED_URL is required.',
  );
}

const sorareUrl =
  process.env.SORARE_GRAPHQL_URL ?? 'https://api.sorare.com/graphql';
const oddsBaseUrl =
  process.env.ODDS_API_BASE_URL ?? 'https://api.the-odds-api.com/v4';
const sportKey = process.env.ODDS_API_SPORT_KEY ?? 'soccer_usa_mls';
const region = process.env.ODDS_API_REGION ?? 'us';
const topN = Math.max(1, Math.min(25, Number(process.env.PROPS_TOP_N ?? 10)));
const now = new Date();

function defaultWeekend(reference) {
  const saturday = new Date(
    Date.UTC(
      reference.getUTCFullYear(),
      reference.getUTCMonth(),
      reference.getUTCDate(),
    ),
  );
  saturday.setUTCDate(
    saturday.getUTCDate() + ((6 - saturday.getUTCDay() + 7) % 7),
  );
  const end = new Date(saturday);
  // Includes Sunday evening kickoffs in North American local time.
  end.setUTCDate(end.getUTCDate() + 3);
  return { from: saturday, to: end };
}

const defaults = defaultWeekend(now);
const from = new Date(process.env.PROPS_FROM ?? defaults.from.toISOString());
const to = new Date(process.env.PROPS_TO ?? defaults.to.toISOString());
if (
  !Number.isFinite(from.getTime()) ||
  !Number.isFinite(to.getTime()) ||
  from >= to
) {
  throw new Error('PROPS_FROM and PROPS_TO must define a valid ISO date range.');
}

const markets = ['player_goal_scorer_anytime', 'player_assists'];
const positionOrder = ['Goalkeeper', 'Defender', 'Midfielder', 'Forward'];
const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function normalizeWords(value) {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

async function fetchWithRetry(url, init = {}) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, init);
    if (
      (response.status === 429 || [502, 503, 504].includes(response.status)) &&
      attempt < 3
    ) {
      const retryAfter = Number(response.headers.get('retry-after'));
      await response.body?.cancel();
      await sleep(
        Number.isFinite(retryAfter)
          ? retryAfter * 1_000
          : Math.min(8_000, 500 * 2 ** attempt),
      );
      continue;
    }
    return response;
  }
  throw new Error('Retry budget exhausted.');
}

async function fetchJson(url, init) {
  const response = await fetchWithRetry(url, init);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  return { data: await response.json(), headers: response.headers };
}

const rosterQuery = `
  query MlsPlayerPropsRoster($first: Int!, $after: String) {
    football {
      competition(slug: "mlspa") {
        orderedPlayers(first: $first, after: $after, limit: LAST_10) {
          pageInfo { hasNextPage endCursor }
          nodes {
            slug
            displayName
            position
            cardPositions
            activeClub { id shortName }
          }
        }
      }
    }
  }
`;

async function loadMlsRoster() {
  const players = [];
  let after = null;
  do {
    const { data: envelope } = await fetchJson(sorareUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'sorare-football-overlay-props-analysis/0.1',
        ...(process.env.SORARE_API_KEY
          ? { APIKEY: process.env.SORARE_API_KEY }
          : {}),
      },
      body: JSON.stringify({
        query: rosterQuery,
        variables: { first: 30, after },
      }),
    });
    if (envelope.errors?.length) {
      throw new Error(envelope.errors.map(({ message }) => message).join('; '));
    }
    const connection = envelope.data?.football?.competition?.orderedPlayers;
    if (!connection) throw new Error('Sorare MLS roster is unavailable.');
    players.push(...connection.nodes);
    after = connection.pageInfo.hasNextPage
      ? connection.pageInfo.endCursor
      : null;
    if (after) await sleep(100);
  } while (after);
  return players;
}

async function loadEvents() {
  if (propsFeedUrl) {
    const url = new URL(propsFeedUrl);
    url.searchParams.set('from', from.toISOString());
    url.searchParams.set('to', to.toISOString());
    const { data } = await fetchJson(url);
    return data;
  }
  const url = new URL(
    `${oddsBaseUrl.replace(/\/$/, '')}/sports/${encodeURIComponent(
      sportKey,
    )}/events`,
  );
  url.searchParams.set('apiKey', oddsApiKey);
  const { data } = await fetchJson(url);
  return data.filter((event) => {
    const kickoff = Date.parse(event.commence_time);
    return kickoff >= from.getTime() && kickoff < to.getTime();
  });
}

async function loadEventOdds(event) {
  const url = new URL(
    `${oddsBaseUrl.replace(/\/$/, '')}/sports/${encodeURIComponent(
      sportKey,
    )}/events/${encodeURIComponent(event.id)}/odds`,
  );
  url.searchParams.set('apiKey', oddsApiKey);
  url.searchParams.set('regions', region);
  url.searchParams.set('markets', markets.join(','));
  url.searchParams.set('oddsFormat', 'decimal');
  const response = await fetchWithRetry(url);
  if (response.status === 422) {
    await response.body?.cancel();
    // A fixture can expose only one of the two props. Querying separately
    // preserves the supported market without inventing the missing one.
    const partial = await Promise.all(
      markets.map(async (market) => {
        const single = new URL(url);
        single.searchParams.set('markets', market);
        const result = await fetchWithRetry(single);
        if (!result.ok) {
          await result.body?.cancel();
          return null;
        }
        return { data: await result.json(), headers: result.headers };
      }),
    );
    const available = partial.filter(Boolean);
    if (available.length === 0) return { event, bookmakers: [], quota: null };
    const bookmakers = new Map();
    for (const { data } of available) {
      for (const bookmaker of data.bookmakers ?? []) {
        const existing = bookmakers.get(bookmaker.key) ?? {
          ...bookmaker,
          markets: [],
        };
        existing.markets.push(...(bookmaker.markets ?? []));
        bookmakers.set(bookmaker.key, existing);
      }
    }
    return {
      ...event,
      bookmakers: [...bookmakers.values()],
      quota: available.at(-1)?.headers ?? null,
    };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { ...event, bookmakers: [], quota: null };
  }
  return {
    ...(await response.json()),
    quota: response.headers,
  };
}

function outcomeProbability(market, outcomes) {
  const relevant = outcomes.filter(
    (outcome) =>
      market !== 'player_assists' ||
      outcome.point == null ||
      Math.abs(outcome.point - 0.5) < 0.001,
  );
  const positive = relevant.find((outcome) =>
    ['yes', 'over'].includes(normalizeWords(outcome.name)),
  );
  if (!positive || !(positive.price > 1)) return null;
  const positiveImplied = 1 / positive.price;
  const negative = relevant.find((outcome) =>
    ['no', 'under'].includes(normalizeWords(outcome.name)),
  );
  if (!negative || !(negative.price > 1)) return positiveImplied;
  const negativeImplied = 1 / negative.price;
  return positiveImplied / (positiveImplied + negativeImplied);
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function extractProps(eventOdds) {
  const values = new Map();
  for (const bookmaker of eventOdds.bookmakers ?? []) {
    for (const market of bookmaker.markets ?? []) {
      if (!markets.includes(market.key)) continue;
      const byPlayer = new Map();
      for (const outcome of market.outcomes ?? []) {
        let playerName = outcome.description;
        let normalizedOutcome = outcome;
        if (
          !playerName &&
          !['yes', 'no', 'over', 'under'].includes(
            normalizeWords(outcome.name),
          )
        ) {
          playerName = outcome.name;
          normalizedOutcome = { ...outcome, name: 'Yes' };
        }
        if (!playerName) continue;
        const normalized = normalizePlayerName(playerName);
        const group = byPlayer.get(normalized) ?? {
          displayName: playerName,
          outcomes: [],
        };
        group.outcomes.push(normalizedOutcome);
        byPlayer.set(normalized, group);
      }
      for (const [normalized, group] of byPlayer) {
        const probability = outcomeProbability(market.key, group.outcomes);
        if (probability == null) continue;
        const key = `${market.key}|${normalized}`;
        const entry = values.get(key) ?? {
          market: market.key,
          playerName: group.displayName,
          normalized,
          probabilities: [],
        };
        entry.probabilities.push(probability);
        values.set(key, entry);
      }
    }
  }
  return [...values.values()].map((entry) => ({
    market: entry.market,
    playerName: entry.playerName,
    normalized: entry.normalized,
    probability: median(entry.probabilities),
    bookmakerCount: entry.probabilities.length,
    kickoff: eventOdds.commence_time,
    homeTeam: eventOdds.home_team,
    awayTeam: eventOdds.away_team,
  }));
}

function resolveRosterPlayer(entry, roster) {
  const fixtureTeams = new Set([
    normalizeTeamName(entry.homeTeam),
    normalizeTeamName(entry.awayTeam),
  ]);
  const fixtureRoster = roster.filter(
    (player) =>
      player.activeClub?.shortName &&
      fixtureTeams.has(normalizeTeamName(player.activeClub.shortName)),
  );
  const candidates = fixtureRoster
    .map((player) => ({
      player,
      score: playerNameMatchScore(player.displayName, entry.playerName),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score);
  const best = candidates[0];
  if (
    !best ||
    candidates.filter(({ score }) => score === best.score).length !== 1
  ) {
    return null;
  }
  return best.player;
}

function percentage(value) {
  return `${(value * 100).toFixed(1).replace('.', ',')} %`;
}

const [roster, eventsPayload] = await Promise.all([
  loadMlsRoster(),
  loadEvents(),
]);
const events = propsFeedUrl ? eventsPayload.events : eventsPayload;
const eventOdds = propsFeedUrl ? eventsPayload.eventOdds : [];
if (!propsFeedUrl) {
  for (let index = 0; index < events.length; index += 4) {
    eventOdds.push(
      ...(await Promise.all(events.slice(index, index + 4).map(loadEventOdds))),
    );
  }
}

const unresolved = [];
const rows = eventOdds.flatMap(extractProps).flatMap((entry) => {
  const player = resolveRosterPlayer(entry, roster);
  if (!player) {
    unresolved.push(entry.playerName);
    return [];
  }
  return [
    {
      ...entry,
      slug: player.slug,
      displayName: player.displayName,
      position: player.cardPositions?.[0] ?? player.position,
      club: player.activeClub?.shortName ?? null,
    },
  ];
});

console.log(
  `# MLS Player-Props ${from.toISOString()} bis ${to.toISOString()}\n`,
);
console.log(
  `${events.length} Begegnungen · ${roster.length} MLS-Spieler · Markt-Konsens aus Dezimalquoten\n`,
);
for (const position of positionOrder) {
  console.log(`## ${position}\n`);
  for (const [market, title] of [
    ['player_goal_scorer_anytime', 'Tor'],
    ['player_assists', 'Assist'],
  ]) {
    console.log(`### ${title}\n`);
    const ranked = rows
      .filter((row) => row.position === position && row.market === market)
      .sort((left, right) => right.probability - left.probability)
      .slice(0, topN);
    if (ranked.length === 0) {
      console.log('_Keine Marktquoten angeboten._\n');
      continue;
    }
    ranked.forEach((row, index) => {
      const fixture = `${row.homeTeam} – ${row.awayTeam}`;
      const club = row.club ? ` · ${row.club}` : '';
      console.log(
        `${index + 1}. **${row.displayName}**${club} — ${percentage(
          row.probability,
        )} · ${row.bookmakerCount} Buchmacher · ${fixture}`,
      );
    });
    console.log('');
  }
}

if (unresolved.length > 0) {
  console.log(
    `Nicht eindeutig Sorare-Positionen zugeordnet: ${[
      ...new Set(unresolved),
    ].join(', ')}`,
  );
}

const quotaHeaders = eventOdds
  .map(({ quota }) => quota)
  .filter(Boolean)
  .at(-1);
if (quotaHeaders) {
  console.log(
    `\nThe Odds API Kontingent: verwendet ${quotaHeaders.get(
      'x-requests-used',
    ) ?? '?'} · verbleibend ${quotaHeaders.get('x-requests-remaining') ?? '?'}`,
  );
}
