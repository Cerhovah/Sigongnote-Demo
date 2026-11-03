import { organizeEvidence, type OrganizationInput } from "@sigongnote/domain";
import type { WorkerOptions } from "./parse-worker.js";
import {identifyNext,linkDirectoryEvidence} from './entity-links.js';
/** Resume immutable parse results after a crash, without another queue or model call. */
export async function organizeNext(options:WorkerOptions){
 const {db}=options;
 const [row]=await db`select app.next_organization_input(${options.tenantScope??null}::uuid,${db.json(options.policy)}) input`;
 if(!row?.input)return identifyNext(options);
 const input=row.input;try{const proposal=organizeEvidence({tenantId:input.tenant_id,revisionId:input.revision_id,spans:input.output.spans,projects:input.projects,bindings:input.bindings,bundles:input.bundles} as OrganizationInput);
 const [identityRow]=await db`select app.entity_link_input(${input.tenant_id}::uuid,${input.job_id}::uuid,${db.json(options.policy)}) input`;
 if(!identityRow?.input)return false;
 const identity=linkDirectoryEvidence(identityRow.input);
 const projectLinks=identity.links.filter(l=>l.targetKind==='project');
 proposal.project_candidates=[...new Set(projectLinks.flatMap(l=>l.candidates.map(c=>c.targetId)))].sort();
 const common=input.bindings.some((b:{scope_mode:string})=>b.scope_mode==='company_common');
 proposal.project_id=!common&&proposal.project_candidates.length===1&&projectLinks.some(l=>l.status==='linked')?proposal.project_candidates[0]!:null;
 proposal.state=common?'common':proposal.project_candidates.length>1?'conflict':proposal.project_id?'linked':'unassigned';
 if(!proposal.project_id){proposal.work_label=null;proposal.bundle_id=null;}
 const [linked]=await db`select app.save_entity_links(${input.tenant_id}::uuid,${input.job_id}::uuid,${identityRow.input.context_hash},${db.json(identity)},${db.json(options.policy)}) ok`;
 if(!linked?.ok)return false;
 const [saved]=await db`select app.save_organization(${input.tenant_id}::uuid,${input.job_id}::uuid,${input.context_hash},${db.json(proposal)},${db.json(options.policy)}) ok`;
 return Boolean(saved?.ok);
 }catch{await db`select app.organization_failed(${input.tenant_id}::uuid,${input.job_id}::uuid)`;return false;}
}
