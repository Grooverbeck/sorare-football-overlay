const sorareUrl =
  process.env.SORARE_GRAPHQL_URL ?? 'https://api.sorare.com/graphql';
const statsApiUrl =
  process.env.PLAYER_STATS_API_URL ??
  'https://sorare-football-overlay-api.grooverbeck.workers.dev/api/player-stats';
const windowHours = Math.max(
  1,
  Math.min(168, Number(process.env.ODDS_FETCH_WINDOW_HOURS ?? 24)),
);
const now = Date.now();
const windowEnd = now + windowHours * 60 * 60 * 1_000;

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchJson(url, init = {}) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(60_000),
    });
    if (
      (response.status === 429 || [502, 503, 504].includes(response.status)) &&
      attempt < 3
    ) {
      await response.body?.cancel();
      await sleep(Math.min(8_000, 500 * 2 ** attempt));
      continue;
    }
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`HTTP ${response.status}: ${message.slice(0, 500)}`);
    }
    return response.json();
  }
  throw new Error('Retry budget exhausted.');
}

async function sorareQuery(query, variables) {
  const envelope = await fetchJson(sorareUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'sorare-football-overlay-odds-prewarm/0.1',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (envelope.errors?.length) {
    throw new Error(envelope.errors.map(({ message }) => message).join('; '));
  }
  return envelope.data;
}

const fixtureQuery = `
  query MlsUpcomingFixtures($first: Int!) {
    football {
      competition(slug: "mlspa") {
        futureGames(first: $first) {
          nodes {
            id
            date
            homeTeam { slug shortName }
            awayTeam { slug shortName }
          }
        }
      }
    }
  }
`;

const fixtureData = await sorareQuery(fixtureQuery, { first: 50 });
const fixtures = fixtureData.football.competition.futureGames.nodes
  .filter((game) => {
    const kickoff = Date.parse(game.date);
    return (
      kickoff >= now &&
      kickoff <= windowEnd &&
      game.homeTeam?.slug &&
      game.awayTeam?.slug
    );
  })
  .sort((left, right) => Date.parse(left.date) - Date.parse(right.date));

if (fixtures.length === 0) {
  console.log(`Keine MLS-Begegnung in den nächsten ${windowHours} Stunden.`);
  process.exit(0);
}

const clubSlugs = [...new Set(fixtures.map((fixture) => fixture.homeTeam.slug))];
const variableDefinitions = clubSlugs
  .map((_, index) => `$club${index}: String!`)
  .join(', ');
const clubFields = clubSlugs
  .map(
    (_, index) => `
      club${index}: club(slug: $club${index}) {
        slug
        activePlayers(first: 5) {
          nodes {
            slug
            displayName
            position
            cardPositions
          }
        }
      }
    `,
  )
  .join('\n');
const representativeQuery = `
  query MlsFixtureRepresentatives(${variableDefinitions}) {
    football {
      ${clubFields}
    }
  }
`;
const representativeData = await sorareQuery(
  representativeQuery,
  Object.fromEntries(clubSlugs.map((slug, index) => [`club${index}`, slug])),
);

const positionPriority = new Map([
  ['Forward', 0],
  ['Midfielder', 1],
  ['Defender', 2],
  ['Goalkeeper', 3],
]);
const representatives = clubSlugs.flatMap((clubSlug, index) => {
  const players = representativeData.football[`club${index}`]?.activePlayers?.nodes ??
    [];
  const player = [...players]
    .sort(
      (left, right) =>
        (positionPriority.get(left.cardPositions?.[0] ?? left.position) ?? 9) -
        (positionPriority.get(right.cardPositions?.[0] ?? right.position) ?? 9),
    )
    .find(
      (candidate) =>
        (candidate.cardPositions?.[0] ?? candidate.position) !== 'Goalkeeper',
    );
  return player ? [{ clubSlug, ...player }] : [];
});

const slugs = representatives.map(({ slug }) => slug);
if (slugs.length === 0) {
  throw new Error('Für die anstehenden MLS-Begegnungen wurde kein Feldspieler gefunden.');
}

const positions = Object.fromEntries(
  representatives.map((player) => [
    player.slug,
    player.cardPositions?.[0] ?? player.position,
  ]),
);
const response = await fetchJson(statsApiUrl, {
  method: 'POST',
  headers: {
    accept: 'application/json',
    'content-type': 'application/json',
  },
  body: JSON.stringify({ slugs, playerNames: [], positions }),
});

console.log(
  `${fixtures.length} MLS-Begegnungen in den nächsten ${windowHours} Stunden ` +
    `mit ${slugs.length} Repräsentanten vorgewärmt.`,
);
for (const fixture of fixtures) {
  const representative = representatives.find(
    ({ clubSlug }) => clubSlug === fixture.homeTeam.slug,
  );
  const player = response.data?.find(
    ({ slug }) => slug === representative?.slug,
  );
  const market = player?.nextGame?.marketOdds;
  const goal =
    market?.goal ? `${Math.round(market.goal.probability * 100)} % Tor` : 'Tor –';
  const assist =
    market?.assist
      ? `${Math.round(market.assist.probability * 100)} % Assist`
      : 'Assist –';
  console.log(
    `${fixture.date} · ${fixture.homeTeam.shortName} – ` +
      `${fixture.awayTeam.shortName} · ${player?.displayName ?? '—'} · ` +
      `${goal} · ${assist}`,
  );
}
