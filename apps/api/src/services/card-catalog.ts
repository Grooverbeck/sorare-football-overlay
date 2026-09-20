import { CardIdentitySchema, CardPlayerSlugSchema, sorarePictureId, type CardIdentity, type CardIdentitiesResponse } from '@sorare-overlay/shared';
import * as z from 'zod';
import type { SorareGraphqlClient } from '../graphql/client.js';

const ScopeSchema = z.object({
  slug: CardPlayerSlugSchema,
  customCardEditionNames: z.array(z.string().min(1).max(120)).max(40),
  season: z.object({startYear: z.number().int().min(2000).max(2200)}),
  availableCompetitions: z.array(z.object({slug: CardPlayerSlugSchema})).max(40),
});
export type CardCatalogScope = z.infer<typeof ScopeSchema>;
const PageInfoSchema = z.object({hasNextPage: z.boolean(), endCursor: z.string().max(1000).nullable()});
const CardsPageSchema = z.object({cardsWhere: z.object({nodes: z.array(z.object({
  pictureUrl: z.string().max(2000).nullable(), customCardEditionName: z.string().nullable(),
  anyPlayer: z.object({slug: CardPlayerSlugSchema}),
})).max(100)})});

/** All identity evidence comes from public Sorare responses, never client mappings. */
export class SorareCardCatalogSource {
  constructor(private readonly client: Pick<SorareGraphqlClient, 'request'>) {}

  async scope(): Promise<CardCatalogScope | null> {
    const data = await this.client.request(`query CardCatalogScope { cardSet { currentSet {
      slug customCardEditionNames season { startYear } availableCompetitions { slug }
    } } }`, {});
    return z.object({cardSet:z.object({currentSet:ScopeSchema.nullable()})}).parse(data).cardSet.currentSet;
  }

  async players(competition: string, after: string | null): Promise<{slugs: string[]; next: string | null}> {
    const data = await this.client.request(`query CardCatalogPlayers($competition: String!, $after: String) {
      football { competition(slug: $competition) { orderedPlayers(first: 100, after: $after, limit: LAST_10) {
        nodes { slug } pageInfo { hasNextPage endCursor }
      } } }
    }`, {competition, after});
    const page = z.object({football:z.object({competition:z.object({orderedPlayers:z.object({
      nodes:z.array(z.object({slug:CardPlayerSlugSchema})).max(100), pageInfo:PageInfoSchema,
    })})})}).parse(data).football.competition.orderedPlayers;
    if (page.pageInfo.hasNextPage && (!page.pageInfo.endCursor || page.pageInfo.endCursor === after)) throw new Error('Non-advancing card catalog roster cursor');
    return {slugs:[...new Set(page.nodes.map(row=>row.slug))], next:page.pageInfo.hasNextPage?page.pageInfo.endCursor:null};
  }

  async cards(playerSlug: string, scope: CardCatalogScope, edition?: string): Promise<{identities: CardIdentity[]; editions: string[]}> {
    const data = CardsPageSchema.parse(await this.client.request(`query CardCatalogPictures($player: String!, $year: Int!, $edition: String, $first: Int!) {
      cardsWhere(first: $first, sport: FOOTBALL, rarities: [common], seasonStartYears: [$year], playerSlugs: [$player], customCardEditionName: $edition) {
        nodes { pictureUrl ... on Card { customCardEditionName } anyPlayer { slug } }
      }
    }`, {player:playerSlug,year:scope.season.startYear,edition:edition??null,first:edition?5:50}));
    const identities = new Map<string,CardIdentity>();
    const editions = new Set<string>();
    for (const card of data.cardsWhere.nodes) {
      if (card.anyPlayer.slug !== playerSlug) throw new Error('Sorare returned a different catalog player');
      if (!card.customCardEditionName || !scope.customCardEditionNames.includes(card.customCardEditionName)) continue;
      if (edition && card.customCardEditionName !== edition) throw new Error('Sorare returned a different card edition');
      const pictureId = card.pictureUrl ? sorarePictureId(card.pictureUrl) : null;
      if (!pictureId) continue;
      identities.set(pictureId, {pictureId,playerSlug});
      editions.add(card.customCardEditionName);
    }
    return {identities:[...identities.values()],editions:[...editions]};
  }
}

export const CardCatalogStateSchema = z.object({
  scope: ScopeSchema.nullable(), scopeCheckedAt: z.number(), competitionIndex: z.number().int().min(0),
  rosterCursor:z.string().nullable(), players:z.array(CardPlayerSlugSchema).max(100), playerIndex:z.number().int().min(0),
  missingEditions:z.array(z.string()).max(40), sampled:z.boolean(), nextRunAt:z.number(),
});
export type CardCatalogState = z.infer<typeof CardCatalogStateSchema>;
export const emptyCardCatalogState = ():CardCatalogState => ({scope:null,scopeCheckedAt:0,competitionIndex:0,rosterCursor:null,players:[],playerIndex:0,missingEditions:[],sampled:false,nextRunAt:0});

export interface CardCatalogStore {
  read(ids: readonly string[]): Promise<CardIdentity[]>;
  acquire(token: string, now: number): Promise<boolean>;
  state(): Promise<CardCatalogState | null>;
  save(token: string, state: CardCatalogState, identities: readonly CardIdentity[], now: number): Promise<boolean>;
}

export class CardIdentityService {
  constructor(private readonly store: Pick<CardCatalogStore, 'read'>) {}
  async resolve(ids: readonly string[]): Promise<CardIdentitiesResponse> {
    const requested = new Set(ids);
    const data = (await this.store.read(ids)).map(row=>CardIdentitySchema.parse(row)).filter(row=>requested.has(row.pictureId));
    return {data,retryAfterSeconds:300};
  }
}

/** Small resumable cron slices; request handlers only read the finished index. */
export class CardCatalogRefresher {
  constructor(private readonly source: Pick<SorareCardCatalogSource,'scope'|'players'|'cards'>, private readonly store:CardCatalogStore, private readonly now:()=>number=Date.now) {}

  async run(maxQueries=8): Promise<{queries:number; pictures:number}> {
    const token=crypto.randomUUID();
    const summary={queries:0,pictures:0};
    if (!await this.store.acquire(token,this.now())) return summary;
    let state=(await this.store.state())??emptyCardCatalogState();
    if(!state.scope && state.nextRunAt>this.now()) return summary;
    const started=this.now();
    const save=async(identities:CardIdentity[]=[])=>this.store.save(token,state,identities,this.now());
    if (!state.scope || this.now()-state.scopeCheckedAt>=86400_000) {
      const scope=await this.source.scope(); summary.queries++;
      if (!scope) {state.nextRunAt=this.now()+3600_000; await save();return summary;}
      if (!state.scope || JSON.stringify(scope)!==JSON.stringify(state.scope)) state=emptyCardCatalogState();
      state.scope=scope;state.scopeCheckedAt=this.now();
      if (!await save()) return summary;
    }
    if (state.nextRunAt>this.now()) return summary;
    const scope=state.scope!;
    while(summary.queries<Math.min(12,maxQueries) && this.now()-started<60_000) {
      if(state.playerIndex>=state.players.length) {
        if(state.competitionIndex>=scope.availableCompetitions.length) {
          state={...emptyCardCatalogState(),scope,scopeCheckedAt:state.scopeCheckedAt,nextRunAt:this.now()+86400_000};
          await save();break;
        }
        const page=await this.source.players(scope.availableCompetitions[state.competitionIndex]!.slug,state.rosterCursor);
        summary.queries++;state.players=page.slugs;state.playerIndex=0;state.rosterCursor=page.next;
        if(!page.next) state.competitionIndex++;
        if(!await save()) break;
        continue;
      }
      const player=state.players[state.playerIndex]!;
      const edition=state.sampled?state.missingEditions[0]:undefined;
      if(state.sampled && !edition) {state.playerIndex++;state.sampled=false;continue;}
      const result=await this.source.cards(player,scope,edition);summary.queries++;
      if(edition) state.missingEditions.shift();
      else {
        state.sampled=true;
        // Players without any current-set card should not fan out to all skins.
        state.missingEditions=result.identities.length?scope.customCardEditionNames.filter(value=>!result.editions.includes(value)):[];
      }
      if(!state.missingEditions.length) {state.playerIndex++;state.sampled=false;}
      summary.pictures+=result.identities.length;
      if(!await save(result.identities)) break;
    }
    return summary;
  }
}
