export interface FixtureRefreshHint {key:string; nextCheckAt:string}
export const fixtureIdentityAttribute='data-sorare-overlay-fixture-identity';
export const fixtureRefreshAttribute='data-sorare-overlay-fixture-refresh';
export const retiredFixtureAttribute='data-sorare-overlay-retired-fixture';
export const fixtureChangedEvent='sorare-overlay:fixture-changed';

export function readFixtureRefresh(element:HTMLElement):FixtureRefreshHint|undefined {
  try {
    const value:unknown=JSON.parse(element.getAttribute(fixtureRefreshAttribute) ?? 'null');
    if(value && typeof value==='object' && 'key' in value && typeof value.key==='string' && 'nextCheckAt' in value && typeof value.nextCheckAt==='string' && Number.isFinite(Date.parse(value.nextCheckAt))) return {key:value.key,nextCheckAt:value.nextCheckAt};
  } catch { /* absent or obsolete markup */ }
  return undefined;
}

export function olderFixture(candidate:string|null, current:string|null):boolean {
  if(!candidate || !current) return false;
  const a=Number(candidate.split(':')[2]), b=Number(current.split(':')[2]);
  return Number.isFinite(a) && Number.isFinite(b) && a<b;
}

export function retiredFixture(candidate:string|null, retired:string|null):boolean {
  return Boolean(candidate && retired && (candidate===retired || olderFixture(candidate,retired)));
}

// One wake-up per coordinator, not one interval per card. Hidden tabs do no
// work; visibility resume also catches up after the browser delays a timer.
export class FixtureRefreshScheduler {
  private timer:number|undefined;
  private running=false;
  private listening=false;
  private generation=0;
  private readonly retryAfter=new Map<string,number>();
  private readonly onVisibility=()=>this.schedule();
  constructor(private readonly hints:()=>FixtureRefreshHint[],private readonly refresh:(keys:ReadonlySet<string>)=>Promise<void>,private readonly now:()=>number=Date.now) {}
  schedule():void {
    if(this.timer!==undefined) window.clearTimeout(this.timer);
    this.timer=undefined;
    if(this.running) return;
    const hints=this.hints();
    if(!hints.length) return;
    if(!this.listening) {document.addEventListener('visibilitychange',this.onVisibility);this.listening=true;}
    if(document.visibilityState==='hidden') return;
    const keys=new Set(hints.map(h=>h.key));
    for(const key of this.retryAfter.keys()) if(!keys.has(key)) this.retryAfter.delete(key);
    const at=Math.min(...hints.map(h=>Math.max(Date.parse(h.nextCheckAt),this.retryAfter.get(h.key)??0)));
    if(!Number.isFinite(at)) return;
    this.timer=window.setTimeout(()=>void this.run(),Math.min(2_147_000_000,Math.max(250,at-this.now())));
  }
  private async run():Promise<void> {
    this.timer=undefined;
    if(document.visibilityState==='hidden') {this.schedule();return;}
    const now=this.now();
    const due=new Set(this.hints().filter(h=>Date.parse(h.nextCheckAt)<=now && (this.retryAfter.get(h.key)??0)<=now).map(h=>h.key));
    if(!due.size) {this.schedule();return;}
    for(const key of due) this.retryAfter.set(key,now+30_000);
    const generation=this.generation;
    this.running=true;
    try {await this.refresh(due);} catch { /* preserve values; bounded retry */ }
    finally {if(generation===this.generation){this.running=false;this.schedule();}}
  }
  stop():void {
    this.generation++;
    this.running=false;
    if(this.timer!==undefined)window.clearTimeout(this.timer);
    this.timer=undefined;
    document.removeEventListener('visibilitychange',this.onVisibility);
    this.listening=false;
    this.retryAfter.clear();
  }
}
