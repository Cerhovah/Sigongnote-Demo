import {z} from 'zod';
import {EvidenceSearchSchema} from '@sigongnote/domain';
import type {Tx} from './auth.js';
import {ApiFault} from './routes.js';

export {EvidenceSearchSchema} from '@sigongnote/domain';
export type EvidenceSearch=z.infer<typeof EvidenceSearchSchema>;
const meanings=[['receipt',/인수(?:한)?|받은|받았던|수령(?:한)?/gu],['dispatch',/출고(?:한)?|출발한/gu],['request',/요청(?:한)?|부탁한|발주(?:한)?/gu],['proposal',/제안(?:한)?|제시한/gu],['inspection',/검수(?:한)?|검사한/gu],['correction',/정정(?:한)?|고친|수정한/gu],['cancellation',/취소(?:한)?|철회한/gu]] as const;
export function searchPlan(text:string,projectNames:string[]=[],now=new Date()):EvidenceSearch {
 let query=text.normalize('NFKC');for(const name of projectNames)query=query.replaceAll(name,' ');
 const event_kinds:EvidenceSearch['event_kinds']=[];
 for(const [kind,pattern]of meanings){const word=new RegExp(`(?:${pattern.source})(?=$|\\s|[,.!?을를])`,'gu');if(query.match(word)){event_kinds.push(kind);query=query.replace(word,' ');}}
 const quantity=/(?<![\d,.])((?:0|[1-9][0-9]{0,19}|[1-9][0-9]{0,2}(?:,[0-9]{3}){1,6})(?:\.[0-9]{1,6})?)\s*(?:개|장|박스|kg|m2|미터)(?=\s|$|[를을])/iu.exec(query);
 if(quantity)query=query.replace(quantity[0],' ');
 const history=/이전\s*판|옛날\s*판|모든\s*판|수정\s*전/u.test(query);query=query.replace(/이전\s*판|옛날\s*판|모든\s*판|수정\s*전/gu,' ');
 let from:string|null=null,to:string|null=null;
 if(/지난달/u.test(query)){const kst=new Date(now.getTime()+9*3600000),year=kst.getUTCFullYear(),month=kst.getUTCMonth();from=new Date(Date.UTC(year,month-1,1)-9*3600000).toISOString();to=new Date(Date.UTC(year,month,1)-9*3600000).toISOString();query=query.replace(/지난달/gu,' ');}
 else if(/최근\s*일주일|지난\s*7일/u.test(query)){from=new Date(now.getTime()-7*86400000).toISOString();to=now.toISOString();query=query.replace(/최근\s*일주일|지난\s*7일/gu,' ');}
 query=query.replace(/찾아\s*줘(?:요)?|찾아주세요|보여\s*줘(?:요)?|보여주세요|검색해\s*줘(?:요)?|검색|열어\s*줘(?:요)?|업체가|지난번|보내준|만든|작성된|공유받은|지급해준|최근|최신|자료|문서|원문|관련|좀|주세요|부탁해요/gu,' ').replace(/[?!.，,]/gu,' ');
 query=query.split(/\s+/u).map(t=>t.replace(/(?:에서|으로|부터|까지|의|을|를)$/u,'')).filter(t=>t.length>=2).slice(0,8).join(' ');
 return EvidenceSearchSchema.parse({query,versions:history?'history':'latest',event_kinds,quantity:quantity?.[1]?.replaceAll(',','')??null,from,to});
}
export async function searchEvidence(tx:Tx,tenant:string,input:unknown,onlyRevisions?:string[]){
 const parsed=EvidenceSearchSchema.safeParse(input);if(!parsed.success)throw new ApiFault('INVALID_CONTRACT');const q=parsed.data;
 if(q.project_id&&!(await tx`select id from app.projects where tenant_id=${tenant}::uuid and id=${q.project_id}::uuid`).length)throw new ApiFault('NOT_FOUND');
 if(q.context_id&&!(await tx`select id from app.work_contexts where tenant_id=${tenant}::uuid and id=${q.context_id}::uuid and (${q.project_id}::uuid is null or project_id=${q.project_id}::uuid)`).length)throw new ApiFault('NOT_FOUND');
 const terms=q.query.toLocaleLowerCase().split(/\s+/u).filter(Boolean).slice(0,8);
 // Semantic retrieval uses already validated source facts. It never promotes a search match into an approved fact.
 const rows=await tx`with eligible as materialized (
  select r.*,b.sha256,o.categories,o.state organization_state,o.context_id,pr.display_name project_name,w.label work_label,
   i.job_id index_job_id,i.parser_version,i.manifest
  from app.document_revisions r join app.evidence_blobs b on b.tenant_id=r.tenant_id and b.id=r.blob_id
  left join app.evidence_organizations o on o.tenant_id=r.tenant_id and o.revision_id=r.id
  left join app.projects pr on pr.tenant_id=o.tenant_id and pr.id=o.project_id left join app.work_contexts w on w.tenant_id=o.tenant_id and w.id=o.context_id
  left join lateral(select job_id,parser_version,manifest from app.evidence_chunk_indexes where tenant_id=r.tenant_id and revision_id=r.id and published order by created_at desc,job_id desc limit 1)i on true
  where r.tenant_id=${tenant}::uuid and app.revision_accessible(r.tenant_id,r.id)
  and (${q.project_id}::uuid is null or o.project_id=${q.project_id}::uuid or (o.state='conflict' and ${q.project_id}::uuid=any(o.project_candidates)))
  and (${q.context_id}::uuid is null or o.context_id=${q.context_id}::uuid)
  and (${onlyRevisions??null}::uuid[] is null or r.id=any(${onlyRevisions??null}::uuid[]))
  and (${q.versions}='history' or not exists(select 1 from app.document_revisions n where n.tenant_id=r.tenant_id and n.document_id=r.document_id and n.revision_number>r.revision_number))
  and not exists(select 1 from unnest(${terms}::text[]) term where not exists(
   select 1 from app.revision_search_spans(r.tenant_id,r.id) all_spans
   left join lateral(select text from app.audio_corrections where tenant_id=r.tenant_id and revision_id=r.id and locator=all_spans.locator order by created_at desc,command_id desc limit 1) correction on true
   where position(term in lower(coalesce(correction.text,all_spans.text)))>0))
  and (cardinality(${q.event_kinds}::text[])>0 or ${q.quantity}::text is not null or ((${q.from}::timestamptz is null or r.created_at>=${q.from}::timestamptz) and (${q.to}::timestamptz is null or r.created_at<${q.to}::timestamptz)))
  and exists(select 1 from app.revision_search_spans(r.tenant_id,r.id))
  order by r.created_at desc,r.id limit ${!terms.length&&!q.event_kinds.length&&q.quantity===null?q.limit:null}
 ), candidates as (
  select r.id revision_id,r.sha256,r.created_at,r.revision_number,r.categories,r.organization_state,r.project_name,r.work_label,r.index_job_id,r.parser_version,
   coalesce(r.manifest->'coverage','{}') coverage,left(coalesce(corr.text,s.text),400) excerpt,s.locator,s.ordinal,corr.command_id correction_id,
   case when sem.matched then 2 else 1 end rank,
   left(coalesce(corr.text,s.text),100) title
  from eligible r cross join lateral app.revision_search_spans(r.tenant_id,r.id) s
  left join lateral(select text,command_id from app.audio_corrections where tenant_id=r.tenant_id and revision_id=r.id and locator=s.locator order by created_at desc,command_id desc limit 1)corr on true
  cross join lateral(select exists(select 1 from app.fact_candidates f
   where (cardinality(${q.event_kinds}::text[])>0 or ${q.quantity}::text is not null) and f.tenant_id=r.tenant_id and f.source_revision=r.id and f.semantic is not null and corr.command_id is null
   and (${q.event_kinds}::text[]='{}' or f.semantic->>'eventKind'=any(${q.event_kinds}::text[]))
   and (not ${q.asserted_only} or f.semantic->>'assertionStatus'='asserted')
   and (${q.quantity}::text is null or case when position('.' in f.semantic#>>'{quantity,value}')>0 then rtrim(rtrim(f.semantic#>>'{quantity,value}','0'),'.') else f.semantic#>>'{quantity,value}' end=${q.quantity?.includes('.')?q.quantity.replace(/0+$/u,'').replace(/\.$/u,''):q.quantity})
   and (${q.from}::timestamptz is null or app.evidence_event_time(f.semantic->>'effectiveAt',r.created_at)>=${q.from}::timestamptz)
   and (${q.to}::timestamptz is null or app.evidence_event_time(f.semantic->>'effectiveAt',r.created_at)<${q.to}::timestamptz)
   and exists(select 1 from jsonb_array_elements(case when jsonb_typeof(f.semantic->'evidence')='array' then f.semantic->'evidence' else '[]'::jsonb end)e
    join app.evidence_chunks c on c.tenant_id=r.tenant_id and c.job_id=r.index_job_id and c.revision_id=r.id and c.ordinal=s.ordinal
    where e->>'indexJobId'=c.job_id::text and e->>'ordinal'=c.ordinal::text and e->>'contentHash'=c.content_hash and e->>'locator'=s.locator and position(e->>'quote' in c.text)>0)) matched)sem
  where (cardinality(${q.event_kinds}::text[])=0 and ${q.quantity}::text is null or sem.matched)
  and (sem.matched or (${q.from}::timestamptz is null or r.created_at>=${q.from}::timestamptz) and (${q.to}::timestamptz is null or r.created_at<${q.to}::timestamptz))
  and (cardinality(${terms}::text[])=0 or sem.matched or exists(select 1 from unnest(${terms}::text[]) term where position(term in lower(coalesce(corr.text,s.text)))>0))
 ), ranked as(select distinct on(revision_id) * from candidates order by revision_id,rank desc,ordinal)
 select * from ranked order by rank desc,created_at desc,revision_id limit ${q.limit}`;
 return rows.map(r=>({type:'evidence',...r,revision_id:String(r.revision_id),title:String(r.title??'자료'),excerpt:String(r.excerpt),evidence_ref:{revision_id:r.revision_id,index_job_id:r.index_job_id,ordinal:r.ordinal,locator:r.locator,source_hash:r.sha256},match_kind:Number(r.rank)===2?'semantic':'lexical',version_scope:q.versions}));
}

const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'&&!(v instanceof Date)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)])):v;
export async function refreshSearchResponse(tx:Tx,tenant:string,response:any){
 if(!response.cards?.length&&!response.retrieval_request)return response;
 let cards:Awaited<ReturnType<typeof searchEvidence>>;try{cards=await searchEvidence(tx,tenant,response.retrieval_request??{query:''},response.cards.map((c:any)=>c.revision_id));}catch(error){if(!(error instanceof ApiFault)||error.code!=='NOT_FOUND')throw error;cards=[];}
 return JSON.stringify(canonical(cards))===JSON.stringify(canonical(response.cards))?response:{...response,cards,text:cards.length?`${cards.length}개 자료를 현재 근거로 다시 확인했어요.`:'현재 열 수 있는 해당 자료가 없어요. 문서판이나 연결 범위가 바뀌었을 수 있어요.'};
}
