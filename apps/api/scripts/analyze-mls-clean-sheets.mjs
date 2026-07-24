const url = process.env.SORARE_GRAPHQL_URL ?? 'https://api.sorare.com/graphql';
const seasonStart = process.env.MLS_SEASON_START ?? `${new Date().getUTCFullYear()}-01-01T00:00:00Z`;
// 25 keeps the anonymous Sorare query below its complexity limit of 500.
const pageSize = 25;
const query = `
  query MlsCleanSheetHistory($first: Int!, $after: String) {
    football {
      competition(slug: "mlspa") {
        displayName
        pastGames(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            date
            homeGoals
            awayGoals
            homeTeam {
              __typename
              ... on Club { slug name }
            }
            awayTeam {
              __typename
              ... on Club { slug name }
            }
            homeStats {
              __typename
              ... on FootballTeamGameStats { cleanSheetOdds }
            }
            awayStats {
              __typename
              ... on FootballTeamGameStats { cleanSheetOdds }
            }
          }
        }
      }
    }
  }
`;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchPage(after) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'sorare-football-overlay-clean-sheet-benchmark/0.1',
        ...(process.env.SORARE_API_KEY ? { APIKEY: process.env.SORARE_API_KEY } : {}),
      },
      body: JSON.stringify({ query, variables: { first: pageSize, after } }),
    });
    if (response.status === 429 && attempt < 3) {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (!response.ok) throw new Error(`Sorare returned HTTP ${response.status}`);
    const envelope = await response.json();
    if (envelope.errors?.length) {
      throw new Error(envelope.errors.map(({ message }) => message).join('; '));
    }
    return envelope.data.football.competition;
  }
  throw new Error('Sorare retry budget exhausted');
}

function quantile(sorted, fraction) {
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function rounded(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function summarize(observations) {
  return {
    sampleSize: observations.length,
    meanPredicted: rounded(
      observations.reduce((sum, item) => sum + item.probability, 0) / observations.length,
    ),
    actualCleanSheetRate: rounded(
      observations.filter((item) => item.cleanSheet).length / observations.length,
    ),
    brierScore: rounded(
      observations.reduce(
        (sum, item) => sum + (item.probability - Number(item.cleanSheet)) ** 2,
        0,
      ) / observations.length,
    ),
  };
}

const games = [];
let after = null;
let competitionName = 'Major League Soccer';
let reachedPreviousSeason = false;
do {
  const competition = await fetchPage(after);
  competitionName = competition.displayName;
  const currentSeasonGames = competition.pastGames.nodes.filter(
    ({ date }) => Date.parse(date) >= Date.parse(seasonStart),
  );
  games.push(...currentSeasonGames);
  reachedPreviousSeason = currentSeasonGames.length < competition.pastGames.nodes.length;
  after =
    !reachedPreviousSeason && competition.pastGames.pageInfo.hasNextPage
      ? competition.pastGames.pageInfo.endCursor
      : null;
  if (after) await sleep(100);
} while (after);

const observations = games.flatMap((game) => {
  const homeTeam =
    game.homeTeam?.__typename === 'Club'
      ? { slug: game.homeTeam.slug, name: game.homeTeam.name }
      : null;
  const awayTeam =
    game.awayTeam?.__typename === 'Club'
      ? { slug: game.awayTeam.slug, name: game.awayTeam.name }
      : null;
  return [
    {
      gameId: game.id,
      date: game.date,
      venue: 'home',
      team: homeTeam,
      opponent: awayTeam,
      odds:
        game.homeStats?.__typename === 'FootballTeamGameStats'
          ? game.homeStats.cleanSheetOdds
          : null,
      cleanSheet: game.awayGoals === 0,
    },
    {
      gameId: game.id,
      date: game.date,
      venue: 'away',
      team: awayTeam,
      opponent: homeTeam,
      odds:
        game.awayStats?.__typename === 'FootballTeamGameStats'
          ? game.awayStats.cleanSheetOdds
          : null,
      cleanSheet: game.homeGoals === 0,
    },
  ];
});

const quoted = observations.flatMap((observation) =>
  observation.odds != null && observation.odds >= 1
    ? [{ ...observation, probability: Math.min(1, 1 / observation.odds) }]
    : [],
);
if (quoted.length === 0) throw new Error('No historical MLS clean-sheet odds were returned');

const probabilities = quoted
  .map(({ probability }) => probability)
  .sort((left, right) => left - right);
const thresholds = {
  p20: quantile(probabilities, 0.2),
  p40: quantile(probabilities, 0.4),
  p60: quantile(probabilities, 0.6),
  p80: quantile(probabilities, 0.8),
  p90: quantile(probabilities, 0.9),
};
const bands = [
  { label: 'P0–20', minimum: 0, maximum: thresholds.p20 },
  { label: 'P20–40', minimum: thresholds.p20, maximum: thresholds.p40 },
  { label: 'P40–60', minimum: thresholds.p40, maximum: thresholds.p60 },
  { label: 'P60–80', minimum: thresholds.p60, maximum: thresholds.p80 },
  { label: 'P80–90', minimum: thresholds.p80, maximum: thresholds.p90 },
  { label: 'P90–100', minimum: thresholds.p90, maximum: 1.000001 },
].map((band) => {
  const members = quoted.filter(
    ({ probability }) => probability >= band.minimum && probability < band.maximum,
  );
  return {
    label: band.label,
    minimum: rounded(band.minimum),
    maximum: rounded(Math.min(1, band.maximum)),
    ...summarize(members),
  };
});

const teams = new Map();
for (const observation of quoted) {
  if (!observation.team) continue;
  const team = teams.get(observation.team.slug) ?? {
    slug: observation.team.slug,
    name: observation.team.name,
    observations: [],
  };
  team.observations.push(observation);
  teams.set(observation.team.slug, team);
}

process.stdout.write(
  `${JSON.stringify(
    {
      competition: competitionName,
      competitionSlug: 'mlspa',
      seasonStart,
      through: games[0]?.date ?? null,
      retrievedAt: new Date().toISOString(),
      methodology: {
        prediction: '1 / historical Sorare cleanSheetOdds',
        outcome: 'opponent goals = 0',
        population: 'home and away team sides in completed MLS matches',
      },
      matches: games.length,
      possibleTeamSides: observations.length,
      quotedTeamSides: quoted.length,
      oddsCoverage: rounded(quoted.length / observations.length),
      overall: summarize(quoted),
      home: summarize(quoted.filter(({ venue }) => venue === 'home')),
      away: summarize(quoted.filter(({ venue }) => venue === 'away')),
      distribution: {
        min: rounded(probabilities[0]),
        p10: rounded(quantile(probabilities, 0.1)),
        p20: rounded(thresholds.p20),
        p40: rounded(thresholds.p40),
        median: rounded(quantile(probabilities, 0.5)),
        p60: rounded(thresholds.p60),
        p80: rounded(thresholds.p80),
        p90: rounded(thresholds.p90),
        max: rounded(probabilities.at(-1)),
      },
      topHistoricalPredictions: [...quoted]
        .sort((left, right) => right.probability - left.probability)
        .slice(0, 10)
        .map(({ date, venue, team, opponent, odds, probability, cleanSheet }) => ({
          date,
          venue,
          team: team?.name ?? null,
          opponent: opponent?.name ?? null,
          decimalOdds: odds,
          probability: rounded(probability),
          cleanSheet,
        })),
      bands,
      teams: [...teams.values()]
        .filter(({ observations: teamObservations }) => teamObservations.length >= 10)
        .map(({ slug, name, observations: teamObservations }) => ({
          slug,
          name,
          ...summarize(teamObservations),
        }))
        .sort(
          (left, right) =>
            right.actualCleanSheetRate - left.actualCleanSheetRate ||
            right.meanPredicted - left.meanPredicted,
        ),
    },
    null,
    2,
  )}\n`,
);
