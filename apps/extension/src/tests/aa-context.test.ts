import type { PlayerStats } from '@sorare-overlay/shared';
import { describe, expect, it } from 'vitest';
import { mergeAaContext } from '../aa-context.js';

const club: PlayerStats = {
  slug:'danso',displayName:'Danso',position:'Defender',aaL10:{value:1.455,sampleSize:4},
  aaL10TeamWinRate:{value:.25,sampleSize:4},cleanSheetL10:{value:.2,sampleSize:10},
  goalL10:{value:.1,sampleSize:10},excludedLowCoverage:0,
  nextGame:{date:'2030-09-26T18:45:00Z',playerTeamSlug:'club',cleanSheetProbability:.3,matchProbabilities:null},
  aaContext:{kind:'club',teamSlug:'club',state:'ready'},
};
const national: PlayerStats = {...club,aaL10:{value:17.332,sampleSize:10},aaL10TeamWinRate:{value:.5,sampleSize:10},
  aaClub:{aaL10:club.aaL10,aaL10TeamWinRate:club.aaL10TeamWinRate},
  aaContext:{kind:'national',teamSlug:'austria',state:'ready'},
  nextGame:{...club.nextGame!,playerTeamSlug:'austria'},
};

describe('AA context transitions',()=>{
  it('does not overwrite new national AA when the club history is still partial',()=>{
    const result=mergeAaContext({...national,aaClub:{aaL10:{value:2,sampleSize:1}},pendingRefreshes:['formHistory']},club);
    expect(result.aaL10).toEqual(national.aaL10);
    expect(result.aaClub?.aaL10).toEqual(club.aaL10);
  });
  it('retains national values during a temporary context lookup, only for the same fixture team',()=>{
    const incoming={...club,nextGame:national.nextGame,aaContext:{kind:'club' as const,state:'loading' as const},pendingRefreshes:['aaContext' as const]};
    expect(mergeAaContext(incoming,national)).toMatchObject({aaL10:national.aaL10,aaContext:{kind:'national',state:'loading'}});
    expect(mergeAaContext({...incoming,nextGame:club.nextGame},national).aaL10).toEqual(club.aaL10);
  });
  it('returns to the stored club value during partial club history without borrowing national AA',()=>{
    const incoming={...club,aaL10:{value:2,sampleSize:1},pendingRefreshes:['formHistory' as const]};
    expect(mergeAaContext(incoming,national)).toMatchObject({aaL10:club.aaL10,aaL10TeamWinRate:club.aaL10TeamWinRate,aaContext:{kind:'club'}});
  });
  it('honors a confirmed empty national history and keeps the club backup',()=>{
    const incoming={...national,aaL10:{value:null,sampleSize:0}};
    expect(mergeAaContext(incoming,club).aaL10.value).toBeNull();
    expect(mergeAaContext(incoming,club).aaClub?.aaL10.value).toBe(1.455);
  });
  it('rejects a late national projection after its fixture was replaced with a club game',()=>{
    const incoming={...national,nextGame:club.nextGame};
    expect(mergeAaContext(incoming,club)).toMatchObject({aaL10:club.aaL10,aaContext:{kind:'club'}});
  });
  it('never borrows values from another player or card position',()=>{
    const incoming={...club,position:'Midfielder' as const,aaL10:{value:2,sampleSize:1},pendingRefreshes:['formHistory' as const]};
    expect(mergeAaContext(incoming,national).aaL10.value).toBe(2);
  });
});
