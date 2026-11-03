import {resolveEntityLinks,type EntityKind,type EntityLinkInput,type EntityReference,type EntityAlias} from '@sigongnote/domain';
import type {WorkerOptions} from './parse-worker.js';
export type EntityDirectoryInput={tenant_id:string;revision_id:string;job_id:string;context_hash:string;
 catalog:Record<string,any>[];aliases:Record<string,any>[];identity_spans:{text:string;locator:string}[];
 bindings:{project_id:string|null;scope_mode:string}[]};
/** Server-owned bindings/IDs and whole-index source quotes are the only identity authority. */
export function linkDirectoryEvidence(raw:EntityDirectoryInput){
 let partial=raw.catalog.length>20000||raw.aliases.length>20000||raw.identity_spans.length>1000;
 const references:EntityReference[]=raw.catalog.slice(0,20000).map(c=>({tenantId:c.tenant_id,id:c.id,targetKind:c.kind,displayName:c.display_name,
  ...(c.project_id?{projectId:c.project_id}:{}),...(c.contract_id?{contractId:c.contract_id}:{}),...(c.party_id?{partyId:c.party_id}:{}),...(c.role?{role:c.role}:{}),...(c.item_type_id?{itemTypeId:c.item_type_id}:{})}));
 const evidence=raw.identity_spans.slice(0,1000).map((s,i)=>({id:`source:${i}`,tenantId:raw.tenant_id,revisionId:raw.revision_id,locator:s.locator,text:s.text,active:true}));
 const aliases:EntityAlias[]=raw.aliases.slice(0,20000).map(a=>{
  const id=`alias:${a.id}`;evidence.push({id,tenantId:raw.tenant_id,revisionId:a.evidence_revision,locator:a.evidence_locator,text:a.evidence_text,active:true});
  return {tenantId:raw.tenant_id,id:a.id,targetKind:a.target_kind,targetId:a.target_id,text:a.alias_text,scope:a.scope,scopeId:a.scope_id,status:a.status,evidenceIds:[id],
   ...(a.role?{role:a.role}:{}),...(a.valid_from?{validFrom:new Date(a.valid_from).toISOString()}:{}),...(a.valid_until?{validUntil:new Date(a.valid_until).toISOString()}: {})};
 });
 const mentions:EntityLinkInput['mentions']=[];
 const names=new Map<string,{kind:EntityKind;text:string}>();
 for(const r of references)names.set(`${r.targetKind}:${r.displayName}`,{kind:r.targetKind,text:r.displayName});
 for(const a of aliases)names.set(`${a.targetKind}:${a.text}`,{kind:a.targetKind,text:a.text});
 for(const [key,n]of names){const ids=evidence.filter(e=>e.id.startsWith('source:')&&e.text.normalize('NFKC').toLowerCase().includes(n.text.normalize('NFKC').toLowerCase())).map(e=>e.id);
  if(ids.length)mentions.push({id:key,targetKind:n.kind,text:n.text,evidenceIds:ids});if(mentions.length>=999){partial=true;break;}}
 const binding=raw.bindings.length===1?raw.bindings[0]:undefined;
 if(binding?.project_id){evidence.push({id:'binding',tenantId:raw.tenant_id,revisionId:raw.revision_id,locator:'binding:0',text:'',active:true});
  mentions.unshift({id:'folder-project',targetKind:'project',existingId:binding.project_id,evidenceIds:['binding']});}
 const input:EntityLinkInput={tenantId:raw.tenant_id,revisionId:raw.revision_id,documentScope:binding?.scope_mode==='company_common'?'common':'unknown',effectiveAt:null,context:{},mentions,references,aliases,evidence};
 let result=resolveEntityLinks(input);
 const projects=[...new Set(result.links.filter(l=>l.targetKind==='project'&&l.status==='linked').map(l=>l.targetId!))];
 if(projects.length===1){input.context.projectId=projects[0]!;result=resolveEntityLinks(input);}
 const contracts=[...new Set(result.links.filter(l=>l.targetKind==='contract'&&l.status==='linked').map(l=>l.targetId!))];
 if(contracts.length===1){input.context.contractId=contracts[0]!;result=resolveEntityLinks(input);}
 if(partial)for(const link of result.links){if(link.status==='linked'){link.status='candidate_only';link.targetId=null;}link.reasons.push('directory_coverage_incomplete');}
 return {...result,coverage:partial?'partial':'complete',evidence:evidence.map(({id,revisionId,locator})=>({id,revisionId,locator}))};
}
export async function identifyNext(options:Pick<WorkerOptions,'db'|'policy'|'tenantScope'>){
 const {db}=options;const [row]=await db`select app.next_entity_link_input(${options.tenantScope??null}::uuid,${db.json(options.policy)}) input`;
 if(!row?.input)return false;
 const input=row.input as EntityDirectoryInput,result=linkDirectoryEvidence(input);
 const [saved]=await db`select app.save_entity_links(${input.tenant_id}::uuid,${input.job_id}::uuid,${input.context_hash},${db.json(result)},${db.json(options.policy)}) ok`;
 return Boolean(saved?.ok);
}
