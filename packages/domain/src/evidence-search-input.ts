import {z} from 'zod';

export const EvidenceSearchSchema=z.strictObject({
 query:z.string().trim().max(2000),project_id:z.uuid().nullable().default(null),context_id:z.uuid().nullable().default(null),
 versions:z.enum(['latest','history']).default('latest'),from:z.iso.datetime().nullable().default(null),to:z.iso.datetime().nullable().default(null),
 event_kinds:z.array(z.enum(['observation','request','proposal','acceptance','dispatch','receipt','inspection','correction','cancellation'])).max(9).default([]),
 quantity:z.string().regex(/^(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,6})?$/).nullable().default(null),
 asserted_only:z.boolean().default(true),limit:z.number().int().min(1).max(30).default(10),
}).refine(v=>!v.from||!v.to||v.from<v.to,'INVALID_PERIOD');

export const ReadToolSchema=z.enum(['search_evidence','resolve_entities','list_exceptions','get_artifact']);
/** Parsed schema defaults are not filters. Only the pinned project may survive routing. */
export function canonicalReadInput(tool:string,value:unknown,project:string|null=null):{query:string;project_id:string|null}|null{
 if(!ReadToolSchema.safeParse(tool).success||!value||typeof value!=='object'||Array.isArray(value))return null;
 const input=value as Record<string,unknown>;
 if(input.project_id!=null&&input.project_id!==project)return null;
 if(tool==='search_evidence'){
  const parsed=EvidenceSearchSchema.safeParse(input);if(!parsed.success)return null;
  const defaults=EvidenceSearchSchema.parse({query:parsed.data.query,project_id:parsed.data.project_id});
  if(JSON.stringify(parsed.data)!==JSON.stringify(defaults))return null;
  return {query:parsed.data.query,project_id:parsed.data.project_id};
 }
 if(Object.keys(input).some(k=>k!=='query'&&k!=='project_id')||input.query!==undefined&&typeof input.query!=='string')return null;
 return {query:typeof input.query==='string'?input.query:'',project_id:input.project_id as string|null??null};
}
