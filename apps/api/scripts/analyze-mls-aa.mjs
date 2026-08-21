const url = process.env.SORARE_GRAPHQL_URL ?? 'https://api.sorare.com/graphql';
const minimumAppearances = 5;
const minimumMinutes = 60;
const pageSize = 30;
const scoreBatchSize = 5;
const allPositions = ['Goalkeeper', 'Defender', 'Midfielder', 'Forward'];
const requestedPosition = process.env.BENCHMARK_POSITION;
const positionsToAnalyze = requestedPosition ? [requestedPosition] : allPositions;
if (positionsToAnalyze.some((position) => !allPositions.includes(position))) {
  throw new Error(
    `BENCHMARK_POSITION must be one of: ${allPositions.join(', ')}`,
  );
}
const requestDelayMs = Number(process.env.BENCHMARK_REQUEST_DELAY_MS ?? 100);
const query = `
  query MlsAaBenchmarks($first: Int!, $after: String) {
    football {
      competition(slug: "mlspa") {
        displayName
        orderedPlayers(first: $first, after: $after, limit: LAST_10) {
          pageInfo { hasNextPage endCursor }
          nodes {
            slug
            displayName
            position
            cardPositions
            lastTenSo5Appearances(teamMode: CLUB)
            playerGameScores(last: 1, lowCoverage: false) {
              ... on PlayerGameScore {
                averageScore(type: LAST_TEN_PLAYED_AVERAGE_ALL_AROUND_SCORE)
              }
            }
          }
        }
      }
    }
  }
`;
const scoresQuery = `
  query MlsAaRawScores($slugs: [String!], $position: Position) {
    players(slugs: $slugs) {
      __typename
      ... on Player {
        slug
        activeClub { id }
        playerGameScores(last: 15, lowCoverage: true, position: $position) {
          __typename
          positionTyped
          ... on PlayerGameScore {
            allAroundScore
            footballGame { date lowCoverage }
            footballPlayerGameStats { playedInGame minsPlayed anyTeam { id } }
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
        'user-agent': 'sorare-football-overlay-benchmark/0.1',
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

async function fetchScores(slugs, position) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'sorare-football-overlay-benchmark/0.1',
        ...(process.env.SORARE_API_KEY ? { APIKEY: process.env.SORARE_API_KEY } : {}),
      },
      body: JSON.stringify({ query: scoresQuery, variables: { slugs, position } }),
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
    return envelope.data.players;
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

function rounded(value) {
  return Math.round(value * 100) / 100;
}

const players = [];
let after = null;
let competitionName = 'Major League Soccer';
do {
  const competition = await fetchPage(after);
  competitionName = competition.displayName;
  players.push(...competition.orderedPlayers.nodes);
  after = competition.orderedPlayers.pageInfo.hasNextPage
    ? competition.orderedPlayers.pageInfo.endCursor
    : null;
  if (after) await sleep(requestDelayMs);
} while (after);

const candidates = players.filter(
  (player) =>
    player.playerGameScores[0]?.averageScore != null &&
    player.lastTenSo5Appearances >= minimumAppearances,
);
const candidateBySlug = new Map(candidates.map((player) => [player.slug, player]));
const eligible = [];
for (const position of positionsToAnalyze) {
  const positionCandidates = candidates.filter(
    (player) => (player.cardPositions[0] ?? player.position) === position,
  );
  for (let index = 0; index < positionCandidates.length; index += scoreBatchSize) {
    const batch = positionCandidates.slice(index, index + scoreBatchSize);
    const scorePlayers = await fetchScores(
      batch.map(({ slug }) => slug),
      position,
    );
    for (const scorePlayer of scorePlayers) {
      if (scorePlayer.__typename !== 'Player') continue;
      const seed = candidateBySlug.get(scorePlayer.slug);
      if (!seed) continue;
      const activeClubId = scorePlayer.activeClub?.id;
      const validScores = scorePlayer.playerGameScores
        .filter(
          (score) =>
            score?.__typename === 'PlayerGameScore' &&
            score.positionTyped === position &&
            score.footballPlayerGameStats.playedInGame &&
            (score.footballPlayerGameStats.minsPlayed ?? 0) >= minimumMinutes &&
            !score.footballGame.lowCoverage &&
            (!activeClubId ||
              score.footballPlayerGameStats.anyTeam?.id === activeClubId),
        )
        .sort(
          (left, right) =>
            Date.parse(right.footballGame.date) - Date.parse(left.footballGame.date),
        )
        .slice(0, 10);
      if (validScores.length < minimumAppearances) continue;
      eligible.push({
        ...seed,
        position,
        appearances: validScores.length,
        aa:
          validScores.reduce((sum, score) => sum + score.allAroundScore, 0) /
          validScores.length,
      });
    }
    if (index + scoreBatchSize < positionCandidates.length) {
      await sleep(requestDelayMs);
    }
  }
}
const positions = {};
for (const position of positionsToAnalyze) {
  const group = eligible.filter((player) => player.position === position);
  const values = group.map(({ aa }) => aa).sort((left, right) => left - right);
  positions[position] = {
    sampleSize: values.length,
    min: rounded(values[0]),
    p10: rounded(quantile(values, 0.1)),
    p20: rounded(quantile(values, 0.2)),
    p40: rounded(quantile(values, 0.4)),
    median: rounded(quantile(values, 0.5)),
    p60: rounded(quantile(values, 0.6)),
    p80: rounded(quantile(values, 0.8)),
    p90: rounded(quantile(values, 0.9)),
    mean: rounded(values.reduce((sum, value) => sum + value, 0) / values.length),
    max: rounded(values.at(-1)),
    topFive: group
      .sort((left, right) => right.aa - left.aa)
      .slice(0, 5)
      .map(({ slug, displayName, aa, appearances }, index) => ({
        rank: index + 1,
        slug,
        displayName,
        aa: rounded(aa),
        appearances,
      })),
  };
}

process.stdout.write(
  `${JSON.stringify(
    {
      competition: competitionName,
      competitionSlug: 'mlspa',
      retrievedAt: new Date().toISOString(),
      methodology: {
        metric: 'mean allAroundScore of newest ten valid appearances',
        minimumMinutes,
        minimumAppearances,
        dnpExcluded: true,
        lowCoverageExcluded: true,
        currentClubOnlyWhenKnown: true,
        position: 'cardPositions[0], falling back to player.position',
      },
      rawPopulationSize: players.length,
      eligiblePopulationSize: eligible.length,
      positions,
    },
    null,
    2,
  )}\n`,
);
