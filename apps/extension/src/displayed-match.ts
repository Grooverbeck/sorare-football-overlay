import {DisplayedMatchSchema,displayedMatchKey,type DisplayedMatch} from '@sorare-overlay/shared';

export const displayedFixtureAttribute='data-sorare-overlay-displayed-fixture';
export const displayedContextAttribute='data-sorare-overlay-displayed-context';

function teamReference(image:HTMLImageElement):string|null {
  try {
    const url=new URL(image.src);
    if(!['frontend-assets.sorare.com','assets.sorare.com'].includes(url.hostname))return null;
    const code=url.pathname.match(/\/flags\/([a-z]{2}(?:-[a-z0-9]{1,8})?)\.svg$/i)?.[1];
    if(code)return `country:${code.toLowerCase()}`;
    const club=url.pathname.match(/\/club\/([a-f0-9-]{36})\//i)?.[1];
    if(club)return `id:Club:${club.toLowerCase()}`;
    if(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(image.alt))return `team:${image.alt}`;
  } catch { /* unknown image source */ }
  return null;
}

// Only passive lineups with one visible score footer. Never infer national
// allegiance from the country printed on a card or from private React state.
export function readDisplayedMatch(container:HTMLElement):DisplayedMatch|undefined {
  const segments=location.pathname.split('/');
  if(!segments.includes('football')||(!segments.includes('lineups')&&!segments.includes('squad'))||segments.some(s=>s==='compose-team'||s==='compose'))return undefined;
  let scope:HTMLElement|null=container;
  for(let depth=0;scope&&depth<7;depth++,scope=scope.parentElement) {
    const footers=scope.querySelectorAll('footer');
    if(footers.length!==1)continue;
    const footer=footers[0]!;
    if(/\d{1,2}:\d{2}/.test(footer.textContent??''))return undefined;
    const teams=[...footer.querySelectorAll<HTMLImageElement>('img')].flatMap(image=>{const ref=teamReference(image);return ref?[{image,ref}]:[];});
    if(teams.length!==2)continue;
    const refs=teams.map(t=>t.ref);
    let scoreScope:HTMLElement|null=teams[0]!.image.parentElement;
    while(scoreScope&&!scoreScope.contains(teams[1]!.image)&&scoreScope!==footer)scoreScope=scoreScope.parentElement;
    if(!scoreScope||scoreScope===footer)continue;
    const score=scoreScope.textContent?.match(/^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/);
    if(!score)continue;
    const live=Boolean(footer.querySelector('[style*="--c-red-300"]'));
    const parsed=DisplayedMatchSchema.safeParse({home:refs[0],away:refs[1],phase:live?'live':'played',homeScore:Number(score[1]),awayScore:Number(score[2])});
    if(!parsed.success)return undefined;
    try {
      const known=JSON.parse(container.getAttribute(displayedFixtureAttribute)??'null');
      const previous=typeof known?.key==='string'?JSON.parse(known.key):null;
      const sameScope=known?.viewPath===location.pathname&&(known?.key===displayedMatchKey(parsed.data)||
        (previous?.[0]===parsed.data.home&&previous?.[1]===parsed.data.away&&previous?.[2]==='live'&&parsed.data.phase==='played'));
      if(known?.state==='confirmed'&&sameScope&&/^Game:[a-f0-9-]{36}$/.test(known.gameId??''))parsed.data.gameId=known.gameId;
    } catch { /* no previous confirmation */ }
    return parsed.data;
  }
  return undefined;
}
