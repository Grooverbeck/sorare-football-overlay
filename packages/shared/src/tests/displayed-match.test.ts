import {it,expect} from 'vitest';
import {PlayerStatsRequestSchema,DisplayedMatchSchema,displayedMatchKey} from '../index.js';
const hint={home:'country:gr',away:'country:de',phase:'live' as const,homeScore:0,awayScore:1};
it('accepts bounded public-team hints only for requested players and rejects false fixture/provider identities',()=>{
  expect(PlayerStatsRequestSchema.safeParse({slugs:['lennart-karl'],displayedMatches:{'lennart-karl':hint}}).success).toBe(true);
  expect(PlayerStatsRequestSchema.safeParse({slugs:['lennart-karl'],displayedMatches:{other:hint}}).success).toBe(false);
  expect(DisplayedMatchSchema.safeParse({...hint,home:hint.away}).success).toBe(false);
  expect(DisplayedMatchSchema.safeParse({...hint,gameId:'odds-api-io:some-event'}).success).toBe(false);
  expect(DisplayedMatchSchema.safeParse({...hint,awayScore:99}).success).toBe(false);
  expect(displayedMatchKey(hint)).toBe(displayedMatchKey({...hint,homeScore:1,awayScore:2}));
});
