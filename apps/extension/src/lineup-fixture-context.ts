import {FIXTURE_STATUS_START_MS} from '@sorare-overlay/shared';
import {teamSlugsLikelyMatch} from './player-identity.js';

export interface LineupTeamSide {slug?:string; label:string; selected:boolean}
const canonicalTeamSlug=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function lineupTeamSides(teamRow:HTMLElement):LineupTeamSide[]|null {
  const nodes=[...teamRow.querySelectorAll<HTMLElement>(':scope > [aria-label="Team"]')];
  if(nodes.length!==2)return null;
  return nodes.map(node=>{
    const slugs=new Set([...node.querySelectorAll<HTMLImageElement>('img[alt]')]
      .map(image=>image.alt.trim().toLowerCase()).filter(alt=>canonicalTeamSlug.test(alt)));
    return {...(slugs.size===1?{slug:[...slugs][0]!}:{}),label:node.textContent?.trim()??'',
      selected:node.classList.contains('highlighted')||node.getAttribute('aria-current')==='true'||node.getAttribute('aria-selected')==='true'||node.dataset.state==='active'};
  });
}

export function lineupBuilderTeamRow(container:HTMLElement):HTMLElement|null {
  const grid=container.closest<HTMLElement>('[class~="slots5"]');
  if(grid) {
    const slot=[...grid.children].find(child=>child.contains(container));
    if(!slot)return null;
    const counts=new Map<HTMLElement,number>();
    for(const node of slot.querySelectorAll<HTMLElement>('[aria-label="Team"]')) {
      if(node.parentElement)counts.set(node.parentElement,(counts.get(node.parentElement)??0)+1);
    }
    const rows=[...counts].filter(([,count])=>count===2).map(([row])=>row);
    return rows.length===1?rows[0]!:null;
  }
  for(let scope=container.parentElement,depth=0;scope&&depth<6;scope=scope.parentElement,depth++) {
    const counts=new Map<HTMLElement,number>();
    for(const node of scope.querySelectorAll<HTMLElement>('[aria-label="Team"]')) {
      if(node.parentElement)counts.set(node.parentElement,(counts.get(node.parentElement)??0)+1);
    }
    const rows=[...counts].filter(([,count])=>count===2).map(([row])=>row);
    if(rows.length===1)return rows[0]!;
    if(rows.length>1)return null;
  }
  return null;
}

export function fixtureMatchesCanonicalLineupSides(
  fixture:{homeTeamSlug?:string|undefined;awayTeamSlug?:string|undefined},sides:readonly LineupTeamSide[],
):boolean|null {
  if(sides.length!==2||!sides[0]?.slug||!sides[1]?.slug||!fixture.homeTeamSlug||!fixture.awayTeamSlug)return null;
  const home=sides.findIndex(side=>teamSlugsLikelyMatch(side.slug,fixture.homeTeamSlug));
  const away=sides.findIndex(side=>teamSlugsLikelyMatch(side.slug,fixture.awayTeamSlug));
  return home>=0&&away>=0&&home!==away;
}

function parseIdentity(key:string|null) {
  const match=key?.match(/^fixture-status:v1:(\d+):([a-z0-9-]+):([a-z0-9-]+)$/);
  if(!match||!canonicalTeamSlug.test(match[2]!)||!canonicalTeamSlug.test(match[3]!)||match[2]===match[3])return null;
  const kickoff=Number(match[1])*1000;
  return Number.isSafeInteger(kickoff)?{kickoff,home:match[2]!,away:match[3]!}:null;
}

export type FixtureContextDecision='none'|'correct-context'|'retain-context';

/** DOM evidence is only a local acceptance gate for a server-owned fixture.
 * It never creates fixtures, copies player quotes, or enters the backend cache.
 * Exact slugs prevent a senior flag from accepting a similarly named youth team.
 */
export function visibleFixtureContextDecision(
  container:HTMLElement,candidateKey:string|null,currentKey:string|null,
  candidatePlayerTeam:string|undefined,now=Date.now(),
):FixtureContextDecision {
  const candidate=parseIdentity(candidateKey),current=parseIdentity(currentKey);
  if(!candidate||!current||candidateKey===currentKey)return 'none';
  const row=lineupBuilderTeamRow(container),sides=row&&lineupTeamSides(row);
  if(!sides||sides.some(side=>!side.slug)||sides[0]!.slug===sides[1]!.slug)return 'none';
  const selected=sides.filter(side=>side.selected);
  if(selected.length!==1)return 'none';
  const matches=(fixture:{home:string;away:string})=>sides.some(side=>side.slug===fixture.home)&&sides.some(side=>side.slug===fixture.away);
  const candidateMatches=matches(candidate),currentMatches=matches(current);
  // Once the visible match is corrected, a late future club response is not
  // "newer" merely because its kickoff is later. Protect the complete context.
  if(currentMatches&&(!candidateMatches||(candidatePlayerTeam&&candidatePlayerTeam!==selected[0]!.slug)))return 'retain-context';
  if(!candidateMatches||currentMatches||candidatePlayerTeam!==selected[0]!.slug)return 'none';
  const lead=candidate.kickoff-now;
  if(lead < -FIXTURE_STATUS_START_MS || lead>7*86400_000)return 'none';
  const label=row!.closest('button, [role="button"]')?.parentElement?.nextElementSibling?.textContent?.trim()??'';
  const time=label.match(/(?:^|,\s*)(\d{1,2}):(\d{2})$/);
  const date=new Date(candidate.kickoff);
  if(time&&(Number(time[1])!==date.getHours()||Number(time[2])!==date.getMinutes()))return 'none';
  return 'correct-context';
}
