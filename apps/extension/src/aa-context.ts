import type { PlayerStats } from '@sorare-overlay/shared';

// Only retain AA for the matching team/position. Club and national history
// can finish in either order, independently of fixture/market responses.
export function mergeAaContext(incoming: PlayerStats, cached?: PlayerStats): PlayerStats {
  if (!cached || incoming.slug !== cached.slug || incoming.position !== cached.position) return incoming;
  const partialClubHistory = incoming.pendingRefreshes?.includes('formHistory') &&
    !cached.pendingRefreshes?.includes('formHistory');
  const cachedClub = cached.aaClub ?? (cached.aaContext?.kind !== 'national'
    ? {aaL10: cached.aaL10, aaL10TeamWinRate: cached.aaL10TeamWinRate} : undefined);
  if (partialClubHistory && cachedClub && incoming.aaClub) incoming = {...incoming, aaClub: cachedClub};
  const sameNational = cached.aaContext?.kind === 'national' &&
    cached.aaContext.teamSlug === incoming.nextGame?.playerTeamSlug;
  if (incoming.aaContext?.state === 'loading' && sameNational) {
    return {...incoming, aaL10: cached.aaL10, aaL10TeamWinRate: cached.aaL10TeamWinRate,
      aaContext: {...cached.aaContext!, state: 'loading'}};
  }
  if (incoming.aaContext?.kind === 'national') {
    // Reject a national projection belonging to a fixture we already retired.
    if (incoming.aaContext.teamSlug !== incoming.nextGame?.playerTeamSlug) {
      if (sameNational) return {...incoming, aaL10: cached.aaL10,
        aaL10TeamWinRate: cached.aaL10TeamWinRate, aaContext: cached.aaContext};
      const club = incoming.aaClub ?? cached.aaClub;
      return club ? {...incoming, ...club, aaContext: {kind: 'club', state: 'ready'}} : incoming;
    }
    return incoming;
  }
  if (partialClubHistory && cachedClub) {
    return {...incoming, ...cachedClub};
  }
  return incoming;
}
