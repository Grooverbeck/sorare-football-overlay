import { gql } from 'graphql-tag';

export const PLAYER_STATS_BATCH_QUERY = gql`
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
            }
            awayTeam {
              id
              shortName
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
              id
              date
              lowCoverage
            }
            footballPlayerGameStats {
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

export const PLAYER_NEXT_GAMES_QUERY = gql`
  query PlayerNextGames($slugs: [String!]) {
    players(slugs: $slugs) {
      __typename
      ... on Player {
        slug
        activeClub {
          id
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
            }
            awayTeam {
              id
              shortName
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

export const PLAYER_APPEARANCE_HISTORY_QUERY = gql`
  query PlayerAppearanceHistory($slug: String!, $position: Position) {
    anyPlayer(slug: $slug) {
      __typename
      ... on Player {
        pastGames(first: 40) {
          nodes {
            date
            lowCoverage
            playerGameScore(playerSlug: $slug, position: $position) {
              __typename
              positionTyped
              ... on PlayerGameScore {
                allAroundScore
                footballPlayerGameStats {
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
