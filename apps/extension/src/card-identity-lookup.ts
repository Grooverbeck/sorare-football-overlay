import { CardIdentitiesResponseSchema, CardPictureIdSchema, type CardIdentitiesResponse } from '@sorare-overlay/shared';
import { hasKnownCardPictureIdentity } from './dom.js';

type Candidate = {pictureId:string; container:HTMLElement};
type FetchIdentities = (ids:string[])=>Promise<CardIdentitiesResponse>;
const fetchIdentities:FetchIdentities = async pictureIds => {
  const reply=await chrome.runtime.sendMessage({type:'FETCH_CARD_IDENTITIES',requestId:crypto.randomUUID(),payload:{pictureIds}});
  if(!reply?.ok) throw new Error('Card catalog unavailable');
  return CardIdentitiesResponseSchema.parse(reply.value);
};

export class CardIdentityLookup {
  private readonly pending=new Map<string,{cards:Set<HTMLElement>;due:number}>();
  private timer:number|undefined;
  private active=false;
  private inFlight=false;
  constructor(private readonly onResolved:(slugs:Record<string,string>)=>void,private readonly fetcher:FetchIdentities=fetchIdentities,private readonly now:()=>number=Date.now) {}
  start():void {this.active=true;this.schedule();}
  stop():void {this.active=false;this.pending.clear();if(this.timer!==undefined)window.clearTimeout(this.timer);this.timer=undefined;}
  add(candidates:readonly Candidate[]):void {
    if(!this.active) return;
    for(const {pictureId,container} of candidates) {
      const id=CardPictureIdSchema.safeParse(pictureId);
      if(!id.success || hasKnownCardPictureIdentity(id.data)) continue;
      let item=this.pending.get(id.data);
      if(!item) {
        if(this.pending.size>=2000) continue;
        item={cards:new Set(),due:0};this.pending.set(id.data,item);
      }
      item.cards.add(container);
    }
    this.schedule();
  }
  private schedule():void {
    if(!this.active || this.inFlight || this.timer!==undefined || !this.pending.size) return;
    this.prune();
    if(!this.pending.size) return;
    const delay=Math.max(100,Math.min(...[...this.pending.values()].map(value=>value.due))-this.now());
    this.timer=window.setTimeout(()=>{this.timer=undefined;void this.flush();},delay);
  }
  private prune():void {
    for(const [id,item] of this.pending) {
      for(const card of item.cards) if(!card.isConnected) item.cards.delete(card);
      if(!item.cards.size || hasKnownCardPictureIdentity(id)) this.pending.delete(id);
    }
  }
  private async flush():Promise<void> {
    if(!this.active) return;
    this.prune();
    const ids=[...this.pending].filter(([,item])=>item.due<=this.now()).slice(0,100).map(([id])=>id);
    if(!ids.length) {this.schedule();return;}
    // No periodic requests while Sorare is in a background tab.
    if(document.hidden) {
      for(const id of ids) this.pending.get(id)!.due=this.now()+300_000;
      this.schedule();return;
    }
    this.inFlight=true;
    let retrySeconds=300;
    try {
      const response=CardIdentitiesResponseSchema.parse(await this.fetcher(ids));
      if(response.data.some(row=>!ids.includes(row.pictureId))) throw new Error('Unexpected catalog identity');
      retrySeconds=response.retryAfterSeconds;
      if(this.active) this.onResolved(Object.fromEntries(response.data.map(row=>[row.pictureId,row.playerSlug])));
      for(const row of response.data) this.pending.delete(row.pictureId);
    } catch {
      // A catalog outage must not affect stats for recognized cards.
    } finally {
      for(const id of ids) {const item=this.pending.get(id);if(item)item.due=this.now()+retrySeconds*1000;}
      this.inFlight=false;this.schedule();
    }
  }
}
