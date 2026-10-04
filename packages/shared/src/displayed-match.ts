import * as z from 'zod';

// Hints identify visible public teams, never provider event IDs or trusted
// fixture data. The server must confirm membership, both teams and the game.
const TeamReferenceSchema = z.string().trim().max(200).regex(
  /^(?:country:[a-z]{2}(?:-[a-z0-9]{1,8})?|team:[a-z0-9]+(?:-[a-z0-9]+)*|id:(?:Club|NationalTeam):[a-f0-9-]{36})$/,
);
export const DisplayedMatchSchema = z.object({
  home: TeamReferenceSchema,
  away: TeamReferenceSchema,
  phase: z.enum(['live', 'played']),
  homeScore: z.number().int().min(0).max(30),
  awayScore: z.number().int().min(0).max(30),
  gameId: z.string().regex(/^Game:[a-f0-9-]{36}$/).optional(),
}).refine(value => value.home !== value.away, 'Displayed teams must differ');
export type DisplayedMatch = z.infer<typeof DisplayedMatchSchema>;

export function displayedMatchKey(match: DisplayedMatch): string {
  return JSON.stringify([match.home, match.away, match.phase,
    ...(match.phase === 'played' ? [match.homeScore, match.awayScore] : [])]);
}
