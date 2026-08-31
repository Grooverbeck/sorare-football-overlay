export const PLAYER_STATS_BATCH_QUERY = /* GraphQL */ `
  query PlayerStatsBatch($slugs: [String!], $position: Position) {
    players(slugs: $slugs) {
      __typename
      ... on Player {
        slug
        displayName
        position
        cardPositions
        anyPositions
        activeClub {
          id
          slug
        }
        nextGame {
          __typename
          ... on Game {
            id
            date
            competition {
              slug
            }
            homeTeam {
              id
              shortName
              slug
            }
            awayTeam {
              id
              shortName
              slug
            }
            homeStats {
              __typename
              ... on FootballTeamGameStats {
                cleanSheetOdds
                winOddsBasisPoints
                drawOddsBasisPoints
                loseOddsBasisPoints
              }
            }
            awayStats {
              __typename
              ... on FootballTeamGameStats {
                cleanSheetOdds
                winOddsBasisPoints
                drawOddsBasisPoints
                loseOddsBasisPoints
              }
            }
          }
        }
        playerGameScores(last: 15, lowCoverage: true, position: $position) {
          __typename
          positionTyped
          ... on PlayerGameScore {
            allAroundScore
            footballGame {
              date
              lowCoverage
              statusTyped
              winner {
                id
              }
            }
            footballPlayerGameStats {
              anyTeam {
                id
              }
              goals
              minsPlayed
              cleanSheet60
              playedInGame
            }
          }
        }
      }
    }
  }
`;

export const PLAYER_NEXT_GAMES_QUERY = /* GraphQL */ `
  query PlayerNextGames($slugs: [String!]) {
    players(slugs: $slugs) {
      __typename
      ... on Player {
        slug
        activeClub {
          id
          slug
        }
        nextGame {
          __typename
          ... on Game {
            id
            date
            competition {
              slug
            }
            homeTeam {
              id
              shortName
              slug
            }
            awayTeam {
              id
              shortName
              slug
            }
            homeStats {
              __typename
              ... on FootballTeamGameStats {
                cleanSheetOdds
                winOddsBasisPoints
                drawOddsBasisPoints
                loseOddsBasisPoints
              }
            }
            awayStats {
              __typename
              ... on FootballTeamGameStats {
                cleanSheetOdds
                winOddsBasisPoints
                drawOddsBasisPoints
                loseOddsBasisPoints
              }
            }
          }
        }
      }
    }
  }
`;

export const PLAYER_APPEARANCE_HISTORY_QUERY = /* GraphQL */ `
  query PlayerAppearanceHistory(
    $slug: String!
    $position: Position
    $first: Int!
    $after: String
  ) {
    anyPlayer(slug: $slug) {
      __typename
      ... on Player {
        pastGames(first: $first, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            date
            lowCoverage
            statusTyped
            winner {
              id
            }
            playerGameScore(playerSlug: $slug, position: $position) {
              __typename
              positionTyped
              ... on PlayerGameScore {
                allAroundScore
                footballPlayerGameStats {
                  anyTeam {
                    id
                  }
                  goals
                  goalAssist
                  minsPlayed
                  cleanSheet60
                  playedInGame
                }
              }
            }
          }
        }
      }
    }
  }
`;
