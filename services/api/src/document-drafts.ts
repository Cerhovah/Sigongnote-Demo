import {DocumentFormSchema} from '@sigongnote/contracts';
import {linkDirectoryEvidence} from './entity-links.js';
import type {DocumentFact} from '@sigongnote/domain';
import {createHash,randomUUID} from "node:crypto";
import {z} from "zod";
import type {FastifyInstance} from "fastify";
import {calculateDocument,partialDocument,remainingBillable,remainingQuantity,decimalMicros,reusableOutcome,type DraftLine,type DocumentType} from "@sigongnote/domain";
import {composeDocumentEvidence,type DraftSource,type DocumentObservation} from "@sigongnote/domain";
import {currentSource} from "./outcomes.js";
import {inAuthorizedTransaction,type Tx} from "./auth.js";
import {ApiFault,execute,membership,once,principal,tenantHeader,type Services} from "./routes.js";
function canonical(v:unknown):unknown{if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)]));return v;}
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(canonical(JSON.parse(JSON.stringify(v))))).digest('hex');
export const documentNames={estimate:'견적서',purchase_order:'발주서',invoice:'청구서',delivery_statement:'거래명세서'};
const date=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const itemKey=(scope:string,l:DraftLine)=>hash([scope,l.description,l.spec,l.unit,l.locator.startsWith('quote:')?l.locator:null]);
type BasisSource={id:string;created_at:string;sha256:string;context_id:string|null;work_label:string|null;source_kind:'local'|'revision';source_revision:number|null;local_revision:number|null;local_version:number|null;output:{status:string;spans:{text:string;locator:string}[];excerptTruncated?:boolean}};
function basisSource(row:Record<string,any>):BasisSource{return {id:String(row.id),created_at:new Date(row.created_at).toISOString(),sha256:String(row.sha256),context_id:row.context_id??null,work_label:row.work_label??null,source_kind:row.source_kind,source_revision:row.source_revision==null?null:Number(row.source_revision),local_revision:row.local_revision==null?null:Number(row.local_revision),local_version:row.local_version==null?null:Number(row.local_version),output:row.output};}

async function basis(tx:Tx,tenant:string,project:string,type:DocumentType,contextId?:string,localSourceId?:string){
 const [context]=contextId?await tx`select id,bundle_id,label from app.work_contexts where tenant_id=${tenant}::uuid and project_id=${project}::uuid and id=${contextId}::uuid`:[];
 if(contextId&&!context)throw new ApiFault('NOT_FOUND');
 const [company]=await tx`select display_name from app.tenants where id=${tenant}::uuid`;
 const [site]=await tx`select display_name,version from app.projects where tenant_id=${tenant}::uuid and id=${project}::uuid`;if(!site)throw new ApiFault('NOT_FOUND');
 const revisionSources=await tx`select r.id,r.created_at,b.sha256,p.output,o.context_id,w.label work_label,'revision' source_kind,r.revision_number source_revision,null::int local_revision,null::bigint local_version from app.document_revisions r
  join app.evidence_blobs b on b.tenant_id=r.tenant_id and b.id=r.blob_id join app.parse_results p on p.tenant_id=r.tenant_id and p.revision_id=r.id
  join app.evidence_organizations o on o.tenant_id=r.tenant_id and o.revision_id=r.id left join app.work_contexts w on w.tenant_id=o.tenant_id and w.id=o.context_id
  where r.tenant_id=${tenant}::uuid and ${localSourceId??null}::uuid is null and o.project_id=${project}::uuid and (${contextId??null}::uuid is null or o.context_id=${contextId??null}::uuid) and o.state<>'conflict' and not (coalesce(p.output->'issues','[]'::jsonb) ? 'stt_unconfirmed') and app.revision_accessible(r.tenant_id,r.id)
  and not exists(select 1 from app.document_revisions n where n.tenant_id=r.tenant_id and n.document_id=r.document_id and n.revision_number>r.revision_number)
  order by r.created_at desc,r.id limit 101`;
 const localSources=!contextId?await tx`select l.id,l.updated_at created_at,l.sha256,l.file_name,l.local_revision,l.version local_version,null::uuid context_id,l.file_name work_label,'local' source_kind,
  jsonb_build_object('status','complete','spans',jsonb_build_array(jsonb_build_object('text',l.excerpt,'locator','local:excerpt')),'excerptTruncated',length(l.excerpt)>=12000) output
  from app.local_journal_entries l where l.tenant_id=${tenant}::uuid and l.project_id=${project}::uuid and (${localSourceId??null}::uuid is null or l.id=${localSourceId??null}::uuid) and l.excerpt<>'' and app.local_document_source_readable(l.tenant_id,l.id) order by l.received_at desc,l.id limit 101`:[];
 if(localSourceId&&!localSources.length)throw new ApiFault('NOT_FOUND');
 const sources:BasisSource[]=[...revisionSources.map(basisSource),...localSources.map(s=>basisSource({...s,output:{...s.output,spans:String(s.output.spans[0]?.text??'').split(/\r?\n/).map((text,index)=>({text,locator:'local:line:'+index}))}}))];
 const eventRows=type==='estimate'&&sources.length?await tx`select e.id,e.source_ref,e.source_version,e.quantities from app.work_events e where e.tenant_id=${tenant}::uuid and e.project_id=${project}::uuid and e.source_ref=any(${sources.map(s=>s.id)}::uuid[]) and e.status in ('open','resolved') and e.kind in ('request','agreement','change','correction') and app.work_event_readable(e.tenant_id,e.id) order by e.created_at,e.id limit 100`:[];
 const observations:DocumentObservation[]=eventRows.filter(e=>sources.some(s=>s.id===e.source_ref&&typeof e.source_version==='string'&&e.source_version.startsWith(`${s.local_revision??s.source_revision}:${s.sha256}:`))).flatMap(e=>(Array.isArray(e.quantities)?e.quantities:[]).flatMap((q:any)=>typeof q.item==='string'&&typeof q.unit==='string'&&(q.quantity===null||typeof q.quantity==='string')?[{id:String(e.id),revision:String(e.source_ref),description:q.item,quantity:q.quantity,unit:q.unit}]:[]));
 const bundles=await tx`select b.*,o.version order_version from app.work_bundles b join app.work_orders o on o.tenant_id=b.tenant_id and o.id=b.work_order_id where b.tenant_id=${tenant}::uuid and o.project_id=${project}::uuid order by b.id`;
 const quotes=await tx`select q.*,r.margin_bps,r.vat_mode,r.condition_tags,r.cost_coverage,r.missing,r.state revision_state from app.quotes q join app.quote_revisions r on r.tenant_id=q.tenant_id and r.id=q.current_revision_id join app.work_bundles w on w.tenant_id=q.tenant_id and w.id=q.bundle_id join app.work_orders o on o.tenant_id=w.tenant_id and o.id=w.work_order_id where q.tenant_id=${tenant}::uuid and o.project_id=${project}::uuid and (${contextId??null}::uuid is null or q.bundle_id=${context?.bundle_id??null}::uuid) and q.status<>'cancelled' and not exists(select 1 from app.document_drafts d where d.tenant_id=q.tenant_id and d.quote_revision_id=q.current_revision_id) order by q.created_at desc,q.id limit 2`;
 const quote=quotes[0];
 const quoteLines=quote?await tx`select l.*,r.id current_rate_id,r.source_revision_id current_source_revision,r.source_blob_sha256 current_source_hash,r.rate_minor current_rate,r.observed_on::text,r.valid_until::text,r.condition_tags rate_conditions,r.tax_mode rate_tax,r.candidate_count,
  (app.revision_accessible(l.tenant_id,r.source_revision_id) and not exists(select 1 from app.document_revisions n join app.document_revisions old on old.tenant_id=n.tenant_id and old.document_id=n.document_id where old.tenant_id=l.tenant_id and old.id=r.source_revision_id and n.revision_number>old.revision_number)) accessible
  from app.quote_lines l left join app.rate_observations original on original.tenant_id=l.tenant_id and original.id=l.source_rate_id
  left join lateral(select current.*,count(*) over(partition by dr.revision_number) candidate_count from app.rate_observations current join app.document_revisions dr on dr.tenant_id=current.tenant_id and dr.id=current.source_revision_id join app.document_revisions old on old.tenant_id=original.tenant_id and old.id=original.source_revision_id where current.tenant_id=l.tenant_id and dr.document_id=old.document_id and current.category=original.category and current.unit_code=original.unit_code and current.trade_pack_id=original.trade_pack_id and current.trade_pack_version=original.trade_pack_version order by dr.revision_number desc,current.id limit 1)r on true
  where l.tenant_id=${tenant}::uuid and l.revision_id=${quote.current_revision_id}::uuid order by l.position` :[];
 const agreements=await tx`select a.*,e.revision_id,
  coalesce((select sum(r.amount_minor) from app.billing_reservations r where r.tenant_id=a.tenant_id and r.billing_basis_id=a.id and r.state='held'),0)::text reserved,
  coalesce((select sum(l.gross_minor) from app.invoices i join app.invoice_lines l on l.tenant_id=i.tenant_id and l.invoice_id=i.id where i.tenant_id=a.tenant_id and i.agreement_id=a.id and i.status='approved'),0)::text invoiced,
  exists(select 1 from app.outcomes x where x.tenant_id=a.tenant_id and x.bundle_id=a.bundle_id and x.scope_completed and not exists(select 1 from app.outcomes n where n.tenant_id=x.tenant_id and n.bundle_id=x.bundle_id and n.version>x.version)) completed
  from app.billing_agreements a join app.work_bundles w on w.tenant_id=a.tenant_id and w.id=a.bundle_id join app.work_orders o on o.tenant_id=w.tenant_id and o.id=w.work_order_id join app.evidence_index e on e.tenant_id=a.tenant_id and e.id=a.source_evidence_id
  where a.tenant_id=${tenant}::uuid and o.project_id=${project}::uuid order by a.id`;
 const purchases=await tx`select p.id,p.state,p.version,l.item_key,l.quantity::text,l.returned_quantity::text from app.purchase_orders p join app.purchase_order_lines l on l.tenant_id=p.tenant_id and l.order_id=p.id where p.tenant_id=${tenant}::uuid and p.project_id=${project}::uuid and (${contextId??null}::uuid is null or exists(select 1 from app.document_drafts d where d.tenant_id=p.tenant_id and d.id=p.draft_id and coalesce(d.internal_snapshot->'overrides'->>'context_id',d.internal_snapshot->>'scope')=${contextId??null})) and p.state not in ('draft','cancelled') order by p.id,l.id`;
 const outcomes=await tx`select x.*,w.display_name work_label,d.evidence_ids from app.outcomes x join app.work_bundles w on w.tenant_id=x.tenant_id and w.id=x.bundle_id join app.work_orders o on o.tenant_id=w.tenant_id and o.id=w.work_order_id join app.decisions d on d.tenant_id=x.tenant_id and d.id=x.decision_id where x.tenant_id=${tenant}::uuid and o.project_id=${project}::uuid and not exists(select 1 from app.outcomes n where n.tenant_id=x.tenant_id and n.bundle_id=x.bundle_id and n.version>x.version) order by x.id limit 100`;
 for(const outcome of outcomes){const current=await currentSource(tx,tenant,String(outcome.bundle_id));outcome.current=current.fingerprint===outcome.source_state_sha256;outcome.tax_known=current.costRows.length>0&&current.costRows.every(c=>['exclusive','not_applicable'].includes(String(c.cost_tax_mode)));const evidenceIds=[...new Set([...(outcome.evidence_ids as string[]),...current.costRows.flatMap(c=>c.cost_evidence_ids as string[])])];const evidence=await tx`select revision_id from app.evidence_index where tenant_id=${tenant}::uuid and id=any(${evidenceIds}::uuid[]) and app.revision_accessible(tenant_id,revision_id)`;outcome.refs=evidence.map(e=>e.revision_id);outcome.accessible=evidence.length===evidenceIds.length;}
 const contracts=await tx`select l.* from app.contract_lines l join app.work_orders o on o.tenant_id=l.tenant_id and o.id=l.work_order_id where l.tenant_id=${tenant}::uuid and o.project_id=${project}::uuid order by l.id`;
 const projections=contextId?await tx`select context_id,version,observed_version,event_watermark from app.work_projections where tenant_id=${tenant}::uuid and context_id=${contextId}::uuid`:[];
 const semanticFacts:DocumentFact[]=[];let semanticPartial=false;
 if(contextId){const [row]=await tx`select app.document_facts(${tenant}::uuid,${contextId}::uuid) value`;const current=row?.value;semanticPartial=current?.partial??false;for(const f of current?.facts??[]){const linked=linkDirectoryEvidence(f.identity);semanticFacts.push({...f,semantic:{...f.semantic,entityLinks:linked.links,entityCoverage:linked.coverage}});}}
 const receiptApprovals=contextId?await tx`select c.proposal,e.effects from app.work_decision_cases c join app.exception_events v on v.tenant_id=c.tenant_id and v.exception_id=c.id and v.kind='decision' join app.work_command_effects e on e.tenant_id=v.tenant_id and e.decision_id=v.decision_id where c.tenant_id=${tenant}::uuid and c.context_id=${contextId}::uuid and c.proposal?'semantic_basis'`:[];
 const inScope=(b:any)=>!contextId||b.bundle_id===context?.bundle_id;
 const scopedQuote=quote&&inScope(quote)?quote:null;
 return {company:company?.display_name??'',site,sources,observations,projections,receiptApprovals,semanticFacts,semanticPartial,context:context??null,bundles:bundles.filter(b=>!contextId||b.id===context?.bundle_id),quote:localSourceId?null:scopedQuote,quoteLines:localSourceId?[]:scopedQuote?quoteLines:[],agreements:agreements.filter(inScope),purchases,contracts:contracts.filter(c=>!contextId||bundles.some(b=>b.id===context?.bundle_id&&b.work_order_id===c.work_order_id)),outcomes:outcomes.filter(inScope),as_of:date(),type};
}
type Basis=Awaited<ReturnType<typeof basis>>;
const answers=z.strictObject({form:DocumentFormSchema.optional(),context_id:z.uuid().optional(),lines:z.string().min(2).max(64000).optional(),quantities:z.string().min(2).max(16000).optional(),recipient:z.string().trim().min(1).max(120).optional(),margin_bps:z.number().int().min(0).max(9999).optional(),tax_mode:z.enum(['exclusive','inclusive','not_applicable']).optional(),tax_bps:z.number().int().min(0).max(10000).optional()});
type Answers=z.infer<typeof answers>&{local_source_id?:string;lines_basis?:string};
const quantityAnswers=z.array(z.strictObject({id:z.string().min(1).max(500),quantity:z.string().regex(/^(0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/)})).max(100);
const lineAnswers=z.array(z.strictObject({id:z.string().min(1).max(500).optional(),description:z.string().trim().min(1).max(180),spec:z.string().trim().max(180).default(''),unit:z.string().trim().min(1).max(30),quantity:z.string().regex(/^(0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/).refine(q=>decimalMicros(q)>0n),unit_price:z.string().regex(/^(0|[1-9][0-9]{0,14})$/)})).min(1).max(100);
const lineBasis=(b:Basis)=>hash(b.sources.map(s=>({id:s.id,sha256:s.sha256,revision:s.local_revision??null,version:s.local_version??null})));
function calculate(b:Basis,overrides:Answers={}){
 const sources:DraftSource[]=b.sources.map(s=>({id:String(s.id),sha256:String(s.sha256),created_at:String(s.created_at),spans:s.output.spans??[],partial:s.output.status!=='complete'||s.output.excerptTruncated===true}));
 const extracted=composeDocumentEvidence(b.type,sources,b.semanticFacts,b.as_of,b.observations),missing=overrides.lines===undefined?[...extracted.issues]:[];if(b.semanticPartial&&overrides.lines===undefined)missing.push('아직 확인 중인 변경 자료');
 const policy=extracted.policy;let usedOutcome:Basis["outcomes"][number]|null=null;let lines:DraftLine[]=extracted.lines;let scope=overrides.local_source_id??String(b.bundles.length===1?b.bundles[0]!.id:'');let billingScope=scope;
 if(b.sources.length>100)missing.push('한 번에 확인할 업무 범위');
 if(extracted.selected){
  const source=b.sources.find(s=>s.id===extracted.selected!.id);const matching=b.bundles.filter(w=>w.display_name===source?.work_label);billingScope=b.context?.bundle_id?String(b.context.bundle_id):matching.length===1?String(matching[0]!.id):'';scope=String(b.context?.id??source?.context_id??billingScope);
  if(b.type==='estimate'&&lines.length===1&&lines[0]!.description===source?.work_label&&lines[0]!.purchaseRate===null&&extracted.conditions!==null){
   const line=lines[0]!,unit=({식:'lump',개:'ea',공수:'day'} as Record<string,string>)[line.unit]??line.unit;
   const eligible=b.outcomes.filter(o=>o.work_label===source?.work_label&&o.unit_code===unit&&o.accessible&&o.tax_known&&reusableOutcome({quantity:String(o.quantity_value),actualCost:o.actual_cost_minor===null?null:String(o.actual_cost_minor),unknownCosts:Number(o.unknown_cost_cases),completed:o.scope_completed,ownerLabor:o.owner_labor_included,observedOn:new Date(o.created_at).toISOString().slice(0,10),asOf:b.as_of,conditions:o.condition_tags,targetConditions:extracted.conditions!,current:o.current}));
   if(eligible.length===1){usedOutcome=eligible[0]!;const outcome=usedOutcome,q=decimalMicros(String(outcome.quantity_value));lines=[{...line,purchaseRate:((BigInt(String(outcome.actual_cost_minor))*1000000n+q/2n)/q).toString(),rateCurrent:true}];}
  }

  if(!scope)scope=String(source?.id??'');
 }else if(!extracted.issues.length&&b.quote){
  const q=b.quote;scope=String(q.bundle_id);policy.marginBps=Number(q.margin_bps);policy.taxMode=String(q.vat_mode) as typeof policy.taxMode;
  // The legacy quote API had implicit 10%; require an explicit source policy for new documents.
  if(policy.taxMode==='not_applicable')policy.taxBps=0;
  if(b.bundles.length!==1)missing.push('견적을 준비할 이번 일');
  if(!b.bundles.some(w=>w.id===q.bundle_id&&w.trade_pack_hash===q.trade_pack_hash))missing.push('바뀐 공사 조건과 원가 범위');
  if((q.cost_coverage as {state:string}[]).some(c=>c.state==='unknown'))missing.push('아직 모르는 원가 범위');
  lines=b.quoteLines.filter(l=>l.included&&(b.type!=='purchase_order'||l.category==='material')).map(l=>{
   const age=(Date.parse(b.as_of)-Date.parse(String(l.observed_on)))/86400000;
   const fresh=Number(l.candidate_count)===1&&l.accessible===true&&age>=0&&age<=90&&String(l.valid_until)>=b.as_of&&['exclusive','not_applicable'].includes(String(l.rate_tax))&&(l.rate_conditions as string[]|null)?.every(t=>(q.condition_tags as string[]).includes(t))===true;
   return {id:String(l.id),description:({material:'자재',labor:'인건비',transport:'운송비',equipment:'장비비',revisit:'재방문',other:'기타',defect:'하자 조치',waste:'폐기물',owner_labor:'대표 작업',allocated_overhead:'배분 경비'} as Record<string,string>)[String(l.category)]??'비용 항목',spec:'',unit:({ea:'개',lump:'식',day:'공수',m2:'㎡',m:'m'} as Record<string,string>)[String(l.unit_code)]??'단위 확인 필요',quantity:String(l.quantity_value),purchaseRate:l.current_rate==null?null:String(l.current_rate),salesRate:null,ordered:'0',sourceRevision:String(l.current_source_revision??''),locator:`quote:${l.id}`,rateCurrent:fresh};
  });
  if(q.target_order_id&&b.bundles.some(w=>w.work_order_id===q.target_order_id&&String(w.order_version)!==String(q.expected_order_version)))missing.push('변경된 계약 범위');
 }
 if(overrides.lines!==undefined){
  if(b.type!=='estimate')throw new ApiFault('INVALID_CONTRACT');let parsed:z.infer<typeof lineAnswers>;try{parsed=lineAnswers.parse(JSON.parse(overrides.lines));}catch{throw new ApiFault('INVALID_CONTRACT');}
  const ids=parsed.map((l,i)=>l.id??`manual:${i+1}`);if(new Set(ids).size!==ids.length)throw new ApiFault('INVALID_CONTRACT');
  const previous=lines;lines=parsed.map((l,i)=>({id:ids[i]!,description:l.description,spec:l.spec,unit:l.unit,quantity:l.quantity,purchaseRate:l.unit_price,salesRate:null,ordered:'0',sourceRevision:previous.find(p=>p.id===ids[i])?.sourceRevision??overrides.local_source_id??'',locator:'owner-input:'+ids[i],rateCurrent:true}));
  extracted.notes.push('대표가 입력한 품목·수량·매입단가로 계산한 초안');
  if(overrides.lines_basis&&overrides.lines_basis!==lineBasis(b))missing.push('바뀐 원문의 품목·수량 확인');
 }
 if(b.type==='purchase_order')lines=lines.map(l=>{
  const orders=b.purchases.filter(p=>p.item_key===itemKey(scope,l));
  if(orders.some(p=>p.state==='delivery_unknown'))missing.push(`${l.description}의 발주 전달 여부`);
  // PostgreSQL numeric computes exact six-place quantities without floating point.
  const micros=(v:string)=>{const [w='0',f='']=v.split('.');return BigInt(w)*1000000n+BigInt(f.padEnd(6,'0'));};
  const amount=orders.reduce((sum,p)=>sum+micros(String(p.quantity))-micros(String(p.returned_quantity)),0n);
  return {...l,ordered:`${amount/1000000n}.${(amount%1000000n).toString().padStart(6,'0')}`};
 });
 const orderQuantities=b.type==='purchase_order'?lines.map(l=>({id:l.id,description:l.description,unit:l.unit,available:l.quantity===null?null:(()=>{try{return remainingQuantity(l.quantity!,l.ordered);}catch{return null;}})()})):[];
 if(overrides.quantities!==undefined){
  if(b.type!=='purchase_order')throw new ApiFault('INVALID_CONTRACT');let parsed:z.infer<typeof quantityAnswers>;try{parsed=quantityAnswers.parse(JSON.parse(overrides.quantities));}catch{throw new ApiFault('INVALID_CONTRACT');}
  if(new Set(parsed.map(p=>p.id)).size!==parsed.length)throw new ApiFault('INVALID_CONTRACT');
  if(parsed.length){
   if(parsed.length!==lines.length||parsed.some(p=>!lines.some(l=>l.id===p.id)))missing.push('바뀐 품목의 이번 발주 수량');
   lines=lines.map(l=>{const p=parsed.find(p=>p.id===l.id),available=orderQuantities.find(p=>p.id===l.id)?.available;if(!p||available===null||available===undefined||decimalMicros(p.quantity)>decimalMicros(available)){missing.push(`${l.description}의 이번 발주 수량`);return l;}
    const n=decimalMicros(l.ordered)+decimalMicros(p.quantity);extracted.notes.push(`${l.description}: 이번 발주 ${p.quantity}${l.unit}, 남은 ${remainingQuantity(available,p.quantity)}${l.unit}는 다음에 준비해요.`);return {...l,quantity:`${n/1000000n}.${(n%1000000n).toString().padStart(6,'0')}`};});
  }
 }
 if(overrides.margin_bps!==undefined)policy.marginBps=overrides.margin_bps;if(overrides.tax_mode!==undefined)policy.taxMode=overrides.tax_mode;if(overrides.tax_bps!==undefined)policy.taxBps=overrides.tax_bps;if(policy.taxMode==='not_applicable')policy.taxBps=0;
 const inputLines=lines.map(l=>({id:l.id,description:l.description,spec:l.spec,unit:l.unit,quantity:l.quantity,unit_price:l.purchaseRate}));
 // Only raw purchase prices from preparation sources may include VAT. Verified quote/outcome costs are already net.
 if((extracted.selected||overrides.lines!==undefined)&&!usedOutcome&&b.type==='estimate'&&policy.taxMode==='inclusive'&&policy.taxBps!==null){const denominator=10000n+BigInt(policy.taxBps);lines=lines.map(l=>({...l,purchaseRate:l.purchaseRate===null?null:((BigInt(l.purchaseRate)*10000n+denominator/2n)/denominator).toString()}));}
 let result=calculateDocument(b.type,lines,policy);missing.push(...result.missing);
 if(!overrides.recipient&&!extracted.recipient)missing.push('받는 곳');
 const agreements=b.agreements.filter(a=>a.bundle_id===billingScope);
 if(b.type==='invoice'){
  const receiptConfirmed=extracted.receiptSubjects.length>0&&extracted.receiptSubjects.every(subject=>b.receiptApprovals.some(a=>a.proposal.semantic_subject===subject&&a.proposal.semantic_basis.every((f:any)=>b.semanticFacts.some(current=>current.id===f.id&&current.version===f.version))&&extracted.receiptAmounts.filter(r=>r.subject===subject).every(r=>r.factIds.every(id=>a.proposal.semantic_basis.some((f:any)=>f.id===id))&&a.effects.some((e:any)=>e.kind==='acceptance'&&decimalMicros(e.quantity)===decimalMicros(r.quantity)&&e.unit===r.unit))));
  if(agreements.length!==1||(!agreements[0]!.completed&&!receiptConfirmed))missing.push('현재 청구 가능한 작업과 금액');
  else{const a=agreements[0]!;if(BigInt(a.invoiced)+BigInt(a.reserved)>BigInt(a.approved_gross_minor))missing.push('이미 청구한 금액 확인');else{const available=remainingBillable(String(a.approved_gross_minor),String(a.invoiced),String(a.reserved));if(result.totals.total!==null){if(extracted.selected&&!extracted.isPrepared){const earned=BigInt(result.totals.total),limit=earned<BigInt(a.approved_gross_minor)?earned:BigInt(a.approved_gross_minor),remaining=limit-BigInt(a.invoiced)-BigInt(a.reserved);if(remaining<=0n)missing.push('추가 청구할 금액');else if(remaining<earned){result=partialDocument(result,remaining.toString(),policy.taxMode);extracted.notes.push('이미 청구한 금액과 예약을 뺀 남은 청구 금액이에요.');}}else if(BigInt(result.totals.total)>BigInt(available))missing.push('이미 청구한 금액을 뺀 이번 청구 범위');}}}
 }
 return {result,lines,inputLines,orderQuantities,scope,policy,usedOutcome,references:extracted.references,notes:extracted.notes,selected:extracted.selected,agreement:agreements.length===1?agreements[0]:null,recipient:overrides.recipient??extracted.recipient,missing:[...new Set(missing)],source_candidate:extracted.selected!==null||extracted.lines.length>0||overrides.lines!==undefined||!!overrides.local_source_id};
}
function basisDigest(b:Basis,c:ReturnType<typeof calculate>,overrides:Answers){
 const {sources,as_of,...state}=b;
 return hash({state,inventory:sources.map(s=>({id:s.id,sha256:s.sha256,created_at:s.created_at,context_id:s.context_id,work_label:s.work_label,source_kind:s.source_kind,local_revision:s.local_revision,local_version:s.local_version})),overrides,result:c.result,missing:c.missing,policy:c.policy});
}
export async function prepareDocument(tx:Tx,tenant:string,user:string,project:string,type:DocumentType,id:string,overrides:Answers={},previous?:{id:string;version:number;number:string}){
 if(await membership(tx,tenant,user)!=='owner')throw new ApiFault('NOT_FOUND');
 await tx`select pg_advisory_xact_lock(hashtextextended(${`${tenant}:document:${project}`},0))`;
 const requestHash=hash({project,type,overrides,previous:previous?.id??null});
 const [old]=await tx`select id,request_hash from app.document_drafts where tenant_id=${tenant}::uuid and id=${id}::uuid`;if(old){if(old.request_hash!==requestHash)throw new ApiFault('IDEMPOTENCY_CONFLICT');return {id:String(old.id),type};}
 if(previous&&(await tx`select id from app.document_drafts where tenant_id=${tenant}::uuid and supersedes_id=${previous.id}::uuid`).length)throw new ApiFault('VERSION_CONFLICT');
 const b=await basis(tx,tenant,project,type,overrides.context_id,overrides.local_source_id);if(overrides.lines!==undefined&&!overrides.lines_basis)overrides={...overrides,lines_basis:lineBasis(b)};
 const c=calculate(b,overrides),basisHash=basisDigest(b,c,overrides),publicSnapshot={document_number:previous?.number??`DRAFT-${id.slice(0,8)}`,revision:(previous?.version??0)+1,template_version:'kr-business-v2',form:overrides.form??{},issuer:{name:overrides.form?.issuer?.name??b.company},recipient:{name:c.recipient},project:{id:project,name:b.site.display_name},date:b.as_of,type,...c.result,terms:[],disclosure_scope:'recipient',basis_hash:basisHash};
 const missing=c.missing,ready=missing.length===0;
 const allReferences=[...new Set([...c.references,...(overrides.context_id?b.sources.map(s=>String(s.id)):[]),...(c.selected?[c.selected.id]:[]),...(overrides.local_source_id?[overrides.local_source_id]:[]),...c.lines.map(l=>l.sourceRevision).filter(Boolean),...(type==='invoice'&&c.agreement?[String(c.agreement.revision_id)]:[]),...(c.usedOutcome?(c.usedOutcome.refs as string[]):[])])];
 const localSources=b.sources.filter(s=>s.source_kind==='local'&&allReferences.includes(String(s.id))).map(s=>({id:String(s.id),sha256:String(s.sha256),local_revision:Number(s.local_revision),version:Number(s.local_version),project_id:project}));
 const references=allReferences.filter(id=>!localSources.some(s=>s.id===id));
 let quoteRevision:string|null=null,invoiceId:string|null=null;
 // A sourced quote template stays in the existing versioned quote model. Candidate tables stay drafts.
 if(type==='estimate'&&!c.source_candidate&&b.quote&&ready){
  const q=b.quote,quoteId=randomUUID();quoteRevision=randomUUID();
  await tx`insert into app.quotes(tenant_id,id,actor_id,bundle_id,trade_pack_id,trade_pack_version,trade_pack_hash,kind,target_order_id,expected_order_version) values(${tenant}::uuid,${quoteId}::uuid,${user}::uuid,${q.bundle_id}::uuid,${q.trade_pack_id},${q.trade_pack_version},${q.trade_pack_hash},${q.kind},${q.target_order_id}::uuid,${q.expected_order_version})`;
  await tx`insert into app.quote_revisions(tenant_id,id,quote_id,version,actor_id,state,margin_bps,vat_mode,condition_tags,cost_coverage,missing,basis_sha256,base_cost_minor,supply_minor,vat_minor,total_minor) values(${tenant}::uuid,${quoteRevision}::uuid,${quoteId}::uuid,1,${user}::uuid,'needs_inputs',${c.policy.marginBps},${c.policy.taxMode},${q.condition_tags},${tx.json(q.cost_coverage)},${tx.json(['document_draft_pending_issuance'])},${basisHash},null,null,null,null)`;
  for(const l of b.quoteLines)await tx`insert into app.quote_lines(tenant_id,id,revision_id,position,category,quantity_value,unit_code,included,exclusion_reason,source_rate_id,source_revision_id,source_blob_sha256,rate_minor,cost_minor,operation,target_contract_line_id,expected_line_version) values(${tenant}::uuid,${randomUUID()}::uuid,${quoteRevision}::uuid,${l.position},${l.category},${l.quantity_value},${l.unit_code},${l.included},${l.exclusion_reason},${l.current_rate_id}::uuid,${l.current_source_revision}::uuid,${l.current_source_hash},${l.current_rate},null,${l.operation},${l.target_contract_line_id}::uuid,${l.expected_line_version})`;
  await tx`update app.quotes set current_revision_id=${quoteRevision}::uuid where tenant_id=${tenant}::uuid and id=${quoteId}::uuid`;
 }
 // Source candidates remain document drafts. Canonical invoice creation/reservation belongs to D15.
 await tx`insert into app.document_drafts(tenant_id,id,actor_id,project_id,document_type,version,supersedes_id,request_hash,as_of,state,basis_hash,basis_snapshot,public_snapshot,internal_snapshot,quote_revision_id,invoice_id) values(${tenant}::uuid,${id}::uuid,${user}::uuid,${project}::uuid,${type},${(previous?.version??0)+1},${previous?.id??null}::uuid,${requestHash},${b.as_of}::date,${ready?'draft_ready':'needs_inputs'},${basisHash},${tx.json({references,local_sources:localSources,sources:allReferences.map(id=>({id,sha256:b.sources.find(s=>s.id===id)?.sha256??null,locators:c.lines.filter(l=>l.sourceRevision===id).map(l=>l.locator)})),agreement:c.agreement?{id:c.agreement.id,approved:c.agreement.approved_gross_minor,invoiced:c.agreement.invoiced,reserved:c.agreement.reserved,completed:c.agreement.completed}:null,outcome:c.usedOutcome?{id:c.usedOutcome.id,fingerprint:c.usedOutcome.source_state_sha256}:null})},${tx.json(publicSnapshot)},${tx.json({missing,notes:c.notes,policy:c.policy,source_candidate:c.source_candidate,scope:c.scope,overrides})},${quoteRevision}::uuid,${invoiceId}::uuid)`;
 if(type==='purchase_order'){
  await tx`insert into app.purchase_orders(tenant_id,id,project_id,draft_id) values(${tenant}::uuid,${id}::uuid,${project}::uuid,${id}::uuid)`;
  if(ready)for(const l of c.result.lines)await tx`insert into app.purchase_order_lines(tenant_id,id,order_id,item_key,quantity) values(${tenant}::uuid,${randomUUID()}::uuid,${id}::uuid,${itemKey(c.scope,c.lines.find(x=>x.id===l.id)!)},${l.quantity}::numeric)`;
 }
 return {id,type,state:ready?'draft_ready':'needs_inputs',question:missing.length?`${missing[0]}: 확인하면 이어서 준비할 수 있어요.`:null};
}
export async function readDraft(tx:Tx,tenant:string,id:string){
 const [row]=await tx`select * from app.document_drafts where tenant_id=${tenant}::uuid and id=${id}::uuid`;if(!row)throw new ApiFault('NOT_FOUND');
 const refs=row.basis_snapshot.references as string[];await assertDocumentSources(tx,tenant,row.basis_snapshot);
 const current=await basis(tx,tenant,String(row.project_id),row.document_type as DocumentType,row.internal_snapshot.overrides?.context_id,row.internal_snapshot.overrides?.local_source_id);
 const [latest]=await tx`with recursive revisions as (select id,version from app.document_drafts where tenant_id=${tenant}::uuid and id=${id}::uuid union all select d.id,d.version from app.document_drafts d join revisions r on d.supersedes_id=r.id where d.tenant_id=${tenant}::uuid) select id from revisions order by version desc limit 1`;const overrides=row.internal_snapshot.overrides??{};
 const calculated=calculate(current,overrides);const agreement=current.agreements.find(a=>a.id===row.basis_snapshot.agreement?.id);const billing=agreement?{approved:String(agreement.approved_gross_minor),invoiced:String(agreement.invoiced),reserved:String(agreement.reserved),available:(BigInt(agreement.approved_gross_minor)-BigInt(agreement.invoiced)-BigInt(agreement.reserved)).toString()}:null;
 return {id:row.id,billing,input_lines:calculated.inputLines,order_quantities:calculated.orderQuantities,notes:row.internal_snapshot.notes??[],latest_id:latest?.id??row.id,state:row.state,document:row.public_snapshot,missing:row.internal_snapshot.missing,source_candidate:row.internal_snapshot.source_candidate,source_refs:[...refs,...(row.basis_snapshot.local_sources??[]).map((s:any)=>s.id)],stale:basisDigest(current,calculated,overrides)!==row.basis_hash,external_share_allowed:false};
}
export async function assertDocumentSources(tx:Tx,tenant:string,snapshot:{references:string[];local_sources?:{id:string}[]}){
 const refs=snapshot.references??[],allowed=await tx`select id from unnest(${refs}::uuid[]) id where app.revision_accessible(${tenant}::uuid,id)`;if(allowed.length!==refs.length)throw new ApiFault('NOT_FOUND');
 const locals=(snapshot.local_sources??[]).map(s=>s.id);const localAllowed=await tx`select id from unnest(${locals}::uuid[]) id where app.local_document_source_readable(${tenant}::uuid,id)`;if(localAllowed.length!==locals.length)throw new ApiFault('NOT_FOUND');
}
export function registerDocumentDraftRoutes(app:FastifyInstance,services:Services){
 app.post('/v1/document-drafts',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),p=z.strictObject({project_id:z.uuid(),type:z.literal('estimate'),client_command_id:z.uuid()}).safeParse(req.body);if(!p.success)throw new ApiFault('INVALID_CONTRACT');
  return inAuthorizedTransaction(services.db,actor,async tx=>once(tx,tenant,actor.userId,'documents.prepare',p.data.client_command_id,hash(p.data),async()=>({status:200,body:await prepareDocument(tx,tenant,actor.userId,p.data.project_id,p.data.type,p.data.client_command_id)})));
 }));
 app.post<{Params:{id:string}}>('/v1/document-drafts/:id/complete',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),id=z.uuid().safeParse(req.params.id),p=answers.extend({client_command_id:z.uuid()}).safeParse(req.body);if(!id.success||!p.success)throw new ApiFault('INVALID_CONTRACT');
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   return once(tx,tenant,actor.userId,'documents.complete',p.data.client_command_id,hash({id:id.data,...p.data}),async()=>{
   const view=await readDraft(tx,tenant,id.data);await tx`select pg_advisory_xact_lock(hashtextextended(${`${tenant}:document:${view.document.project.id}`},0))`;const latest=await readDraft(tx,tenant,id.data);const [old]=await tx`select * from app.document_drafts where tenant_id=${tenant}::uuid and id=${latest.latest_id}::uuid`;if(!old)throw new ApiFault('NOT_FOUND');
   const {client_command_id,...changes}=p.data;
   const overrides:Answers={...(old.internal_snapshot.overrides??{}),...changes};if(changes.lines!==undefined)delete overrides.lines_basis;
   const result=await prepareDocument(tx,tenant,actor.userId,String(old.project_id),old.document_type as DocumentType,client_command_id,overrides,{id:String(old.id),version:Number(old.version),number:old.public_snapshot.document_number});return {status:200,body:result};});
  });
 }));
 app.get<{Params:{id:string}}>('/v1/document-drafts/:id',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),id=z.uuid().safeParse(req.params.id);if(!id.success)throw new ApiFault('INVALID_CONTRACT');return inAuthorizedTransaction(services.db,actor,async tx=>({status:200,body:await readDraft(tx,tenant,id.data)}));
 }));
}
