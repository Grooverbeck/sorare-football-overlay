// One-off initial public catalogue build. Recurring additions are handled by
// the Worker's bounded cron. No user cookies, collections or bookmaker calls.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SorareGraphqlClient } from '../src/graphql/client.js';
import { SorareCardCatalogSource } from '../src/services/card-catalog.js';
import { CardIdentitySchema, type CardIdentity } from '@sorare-overlay/shared';

const directory=resolve('artifacts/card-catalog');
await mkdir(directory,{recursive:true});
if(!process.env.SORARE_API_KEY) throw new Error('SORARE_API_KEY is required for the bounded initial catalogue build');
let nextRequestAt=0;
const client=new SorareGraphqlClient({url:process.env.SORARE_GRAPHQL_URL??'https://api.sorare.com/graphql',
  requestTimeoutMs:10000,maxRetries:1,logger:{debug(){},info(){},warn(){},error(){}},
  ...(process.env.SORARE_API_KEY?{apiKey:process.env.SORARE_API_KEY}:{}),
  fetchImpl:async(...args)=>{
    const wait=Math.max(0,nextRequestAt-Date.now());
    nextRequestAt=Math.max(nextRequestAt,Date.now())+750;
    if(wait)await new Promise(resolve=>setTimeout(resolve,wait));
    return fetch(...args);
  },
});
const source=new SorareCardCatalogSource(client);
const scope=await source.scope();if(!scope) throw new Error('No active public card set');
const file=resolve(directory,`${scope.slug}-${scope.season.startYear}.json`);
let done:Record<string,CardIdentity[]>={};
try {const saved=JSON.parse(await readFile(file,'utf8'));if(saved.scope===JSON.stringify(scope)) {
  for(const [slug,rows] of Object.entries(saved.players??{})) if(Array.isArray(rows)) done[slug]=rows.map(row=>CardIdentitySchema.parse(row));
}} catch(error) {if(error instanceof Error && !('code' in error && error.code==='ENOENT')) throw error;}
const slugs=new Set<string>();
for(const competition of scope.availableCompetitions) {
  let cursor:string|null=null;
  for(let page=0;page<50;page++) {
    const result=await source.players(competition.slug,cursor);
    result.slugs.forEach(slug=>slugs.add(slug));cursor=result.next;
    if(!cursor)break;
    if(page===49)throw new Error('Roster pagination exceeded bounded bootstrap limit');
  }
}
console.log(JSON.stringify({set:scope.slug,players:slugs.size,alreadyChecked:Object.keys(done).length}));
const queue=[...slugs].filter(slug=>!done[slug]);
// Two small queries at a time, globally paced to at most 80 starts/minute.
for(let offset=0;offset<queue.length;offset+=2) {
  const rows=await Promise.all(queue.slice(offset,offset+2).map(async slug=>({slug,result:await source.cards(slug,scope)})));
  for(const {slug,result} of rows)done[slug]=result.identities;
  if(offset%50===0 || offset+2>=queue.length) {
    await writeFile(file,JSON.stringify({scope:JSON.stringify(scope),players:done}));
    console.log(JSON.stringify({checked:Object.keys(done).length,total:slugs.size,pictures:new Set(Object.values(done).flat().map(row=>row.pictureId)).size}));
  }
  await new Promise(resolve=>setTimeout(resolve,500));
}
const identities=new Map<string,CardIdentity>();
for(const row of Object.values(done).flat()) {
  const previous=identities.get(row.pictureId);
  if(previous && previous.playerSlug!==row.playerSlug) throw new Error('Conflicting public picture identities');
  identities.set(row.pictureId,row);
}
const values=[...identities.values()];const statements:string[]=[];
for(let offset=0;offset<values.length;offset+=250) {
  const json=JSON.stringify(values.slice(offset,offset+250)).replaceAll("'","''");
  statements.push(`INSERT INTO cache_entries(cache_key,value,expires_at,updated_at)
SELECT 'card-picture:v1:'||json_extract(item.value,'$.pictureId'),item.value,NULL,unixepoch()
FROM json_each('${json}') AS item WHERE true
ON CONFLICT(cache_key) DO UPDATE SET value=CASE
WHEN json_extract(cache_entries.value,'$.conflict')=1 OR json_extract(cache_entries.value,'$.playerSlug')<>json_extract(excluded.value,'$.playerSlug')
THEN json_object('pictureId',json_extract(excluded.value,'$.pictureId'),'conflict',json('true')) ELSE excluded.value END,
expires_at=NULL,updated_at=excluded.updated_at;`);
}
const sql=resolve(directory,`${scope.slug}-${scope.season.startYear}.sql`);
await writeFile(sql,statements.join('\n'));
console.log(JSON.stringify({complete:true,players:slugs.size,pictures:values.length,sql}));
