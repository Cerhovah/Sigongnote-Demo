import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {partialDocument} from '@sigongnote/domain';
import {inAuthorizedTransaction,type Tx} from './auth.js';
import {readDraft,assertDocumentSources} from './document-drafts.js';
import {approveInvoice} from './invoices.js';
import {ApiFault,execute,membership,once,principal,tenantHeader,type Services} from './routes.js';

export const jsonHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const item=z.strictObject({id:z.uuid(),basis_hash:z.string().regex(/^[a-f0-9]{64}$/),amount_minor:z.string().regex(/^[1-9][0-9]{0,14}$/).optional()});
const issueBody=z.strictObject({client_command_id:z.uuid(),drafts:z.array(item).min(1).max(20),recipient_confirmation:z.string().trim().min(1).max(120)});
type Issue=z.infer<typeof issueBody>;
async function decision(tx:Tx,tenant:string,user:string,scope:string,choice:string,targets:string[],versions:number[],evidence:string[],payload:unknown,draftId:string|null=null){
 const id=randomUUID();await tx`insert into app.decisions(tenant_id,id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,document_draft_id,reason,payload_hash) values(${tenant}::uuid,${id}::uuid,${user}::uuid,${scope},${choice},${tx.array(targets,2950)},${tx.array(versions,20)},${tx.array(evidence,2950)},${draftId}::uuid,'화면에 표시된 문서와 금액을 확인한 요청',${jsonHash(payload)})`;return id;
}
async function lockBilling(tx:Tx,tenant:string,ids:string[]){
 const rows=await tx`select a.id,b.work_order_id from app.billing_agreements a join app.work_bundles b on b.tenant_id=a.tenant_id and b.id=a.bundle_id where a.tenant_id=${tenant}::uuid and a.id=any(${ids}::uuid[]) order by b.work_order_id,a.id`;
 for(const order of [...new Set(rows.map(r=>String(r.work_order_id)))])await tx`select pg_advisory_xact_lock(hashtextextended(${`${tenant}:contract-order:${order}`},0))`;
 for(const id of rows.map(r=>String(r.id)).sort())await tx`select pg_advisory_xact_lock(hashtextextended(${`${tenant}:billing-agreement:${id}`},0))`;
}
export async function issueDocuments(tx:Tx,tenant:string,user:string,input:Issue,reconciledDrafts=new Set<string>()){
 if(new Set(input.drafts.map(d=>d.id)).size!==input.drafts.length)throw new ApiFault('INVALID_CONTRACT');
 const drafts=await tx`select * from app.document_drafts where tenant_id=${tenant}::uuid and id=any(${input.drafts.map(d=>d.id)}::uuid[]) order by id`;
 if(drafts.length!==input.drafts.length)throw new ApiFault('NOT_FOUND');
 await lockBilling(tx,tenant,drafts.filter(d=>d.document_type==='invoice').map(d=>String(d.basis_snapshot.agreement?.id??'')).filter(Boolean));
 // Number assignment and duplicate-draft checks are serialized per company; no number reuse after commit.
 await tx`select pg_advisory_xact_lock(hashtextextended(${tenant+':document-number'},0))`;
 const checked=new Map<string,Awaited<ReturnType<typeof readDraft>>>();
 for(const d of drafts){const view=await readDraft(tx,tenant,String(d.id));if(view.stale&&!reconciledDrafts.has(String(d.id)))throw new ApiFault('VERSION_CONFLICT');checked.set(String(d.id),view);}
 const documents=[];
 for(const d of drafts){
  if(d.document_type==='purchase_order'&&(await readDraft(tx,tenant,String(d.id))).stale)throw new ApiFault('VERSION_CONFLICT');
  const requested=input.drafts.find(x=>x.id===d.id)!;const current=checked.get(String(d.id))!;
  if(current.latest_id!==d.id||requested.basis_hash!==d.basis_hash)throw new ApiFault('VERSION_CONFLICT');
  const remainingOnly='이미 청구한 금액을 뺀 이번 청구 범위';
  if((current.missing as string[]).some(m=>!(d.document_type==='invoice'&&requested.amount_minor&&m===remainingOnly)))throw new ApiFault('DOMAIN_INVARIANT');
  if(d.public_snapshot.recipient.name!==input.recipient_confirmation)throw new ApiFault('DOMAIN_INVARIANT');
  if(requested.amount_minor&&d.document_type!=='invoice')throw new ApiFault('INVALID_CONTRACT');
  const [existing]=await tx`select id from app.business_document_revisions where tenant_id=${tenant}::uuid and draft_id=${d.id}::uuid`;if(existing)throw new ApiFault('VERSION_CONFLICT');
  const id=randomUUID(),revision=randomUUID();
  const [sequence]=await tx`select count(*)::int+1 n from app.business_documents where tenant_id=${tenant}::uuid and document_type=${d.document_type}`;
  const prefix=({estimate:'Q',purchase_order:'P',invoice:'I',delivery_statement:'S'} as Record<string,string>)[d.document_type]!;
  const number=`${prefix}-${String(sequence!.n).padStart(7,'0')}`;
  let snapshot=structuredClone(d.public_snapshot);
  if(d.document_type==='invoice')try{snapshot=partialDocument(snapshot,requested.amount_minor,d.internal_snapshot.policy.taxMode);}catch{throw new ApiFault('DOMAIN_INVARIANT');}
  const [clock]=await tx`select to_char(timezone('Asia/Seoul',transaction_timestamp()),'YYYY-MM-DD') issued_date`;snapshot.date=String(clock!.issued_date);
  snapshot.document_number=number;snapshot.revision=1;snapshot.state='approved';snapshot.missing=[];
  if(d.document_type==='invoice'&&((requested.amount_minor&&requested.amount_minor!==d.public_snapshot.totals.total)||snapshot.lines.some((l:any)=>l.quantity===null)))snapshot.terms=[...snapshot.terms,'이번 청구 금액 기준 · 수량은 전체 납품 수량을 뜻하지 않습니다.'];
  if(d.document_type==='purchase_order'&&d.internal_snapshot.overrides?.quantities&&JSON.parse(d.internal_snapshot.overrides.quantities).length)snapshot.terms=[...snapshot.terms,'이번에 선택한 수량의 발주분입니다.'];
  const refs=[...new Set(d.basis_snapshot.references as string[])];
  const evidence=await tx`select id from app.evidence_index where tenant_id=${tenant}::uuid and revision_id=any(${refs}::uuid[]) order by id limit 100`;
  const approval=await decision(tx,tenant,user,'document_issue','issue',[id],[1],evidence.map(e=>String(e.id)),{command:input.client_command_id,draft:d.id,basis:d.basis_hash,recipient:input.recipient_confirmation,snapshot},String(d.id));
  await tx`insert into app.business_documents(tenant_id,id,actor_id,command_id,document_type,document_number) values(${tenant}::uuid,${id}::uuid,${user}::uuid,${input.client_command_id}::uuid,${d.document_type},${number})`;
  await tx`insert into app.business_document_revisions(tenant_id,id,document_id,draft_id,version,snapshot,snapshot_hash,basis_hash,approval_decision_id) values(${tenant}::uuid,${revision}::uuid,${id}::uuid,${d.id}::uuid,1,${tx.json(snapshot)},${jsonHash(snapshot)},${d.basis_hash},${approval}::uuid)`;
  if(d.document_type==='invoice'){
   const basisId=d.basis_snapshot.agreement?.id;if(!basisId)throw new ApiFault('DOMAIN_INVARIANT');
   const [a]=await tx`select * from app.billing_agreements where tenant_id=${tenant}::uuid and id=${basisId}::uuid`;if(!a)throw new ApiFault('NOT_FOUND');
   const [bound]=await tx`select * from app.billing_recipients where tenant_id=${tenant}::uuid and billing_basis_id=${basisId}::uuid order by version desc limit 1`;
   const rebind=bound&&bound.display_name!==input.recipient_confirmation;
   if(rebind){const [active]=await tx`select count(*)::int n from app.invoices where tenant_id=${tenant}::uuid and agreement_id=${basisId}::uuid and status='approved'`;const [held]=await tx`select count(*)::int n from app.billing_reservations where tenant_id=${tenant}::uuid and billing_basis_id=${basisId}::uuid and state='held'`;if(active!.n||held!.n)throw new ApiFault('DOMAIN_INVARIANT');}
   const prior=await tx`select distinct counterparty_id from app.invoices where tenant_id=${tenant}::uuid and agreement_id=${basisId}::uuid and counterparty_id is not null`;
   // Never merge an older opaque party ID by a guessed display name.
   if(!bound&&prior.length)throw new ApiFault('DOMAIN_INVARIANT');
   const party=rebind?randomUUID():bound?.counterparty_id??randomUUID();
   if(!bound||rebind)await tx`insert into app.billing_recipients(tenant_id,billing_basis_id,counterparty_id,display_name,decision_id,version) values(${tenant}::uuid,${basisId}::uuid,${party}::uuid,${input.recipient_confirmation},${approval}::uuid,${Number(bound?.version??0)+1})`;
   const invoice=randomUUID();const [seq]=await tx`select coalesce(max(sequence),0)+1 n from app.invoices where tenant_id=${tenant}::uuid and agreement_id=${basisId}::uuid and stage='progress'`;
   await tx`insert into app.invoices(tenant_id,id,direction,counterparty_id,status,stage,tax_mode,source_evidence_id,bundle_id,agreement_id,sequence) values(${tenant}::uuid,${invoice}::uuid,'receivable',${party}::uuid,'draft','progress',${d.internal_snapshot.policy.taxMode},${a.source_evidence_id}::uuid,${a.bundle_id}::uuid,${basisId}::uuid,${seq!.n})`;
   for(const line of snapshot.lines)await tx`insert into app.invoice_lines(tenant_id,id,invoice_id,supply_minor,vat_minor,gross_minor) values(${tenant}::uuid,${randomUUID()}::uuid,${invoice}::uuid,${line.supply}::numeric,${d.internal_snapshot.policy.taxMode==='not_applicable'?null:line.tax}::numeric,${(BigInt(line.supply)+BigInt(line.tax)).toString()}::numeric)`;
   const reservation=randomUUID();await tx`insert into app.billing_reservations(tenant_id,id,command_id,billing_basis_id,invoice_id,document_revision_id,approval_decision_id,amount_minor,supply_minor,state) values(${tenant}::uuid,${reservation}::uuid,${input.client_command_id}::uuid,${basisId}::uuid,${invoice}::uuid,${revision}::uuid,${approval}::uuid,${snapshot.totals.total}::numeric,${snapshot.totals.supply}::numeric,'held')`;
   for(const [index,ref] of refs.entries())await tx`insert into app.receivable_basis_links(tenant_id,invoice_id,billing_basis_id,document_revision_id,evidence_revision_id,amount_minor) values(${tenant}::uuid,${invoice}::uuid,${basisId}::uuid,${revision}::uuid,${ref}::uuid,${index===0?snapshot.totals.total:null}::numeric)`;
   await approveInvoice(tx,tenant,user,invoice,1,'화면에서 이번 청구서와 금액을 확인하여 승인');
   await tx`update app.billing_reservations set state='consumed' where tenant_id=${tenant}::uuid and id=${reservation}::uuid and state='held'`;
  }
  documents.push({id,revision_id:revision,number});
 }
 return {documents,delivery_state:'unknown',payment_confirmed:false};
}

export async function readIssuedDocument(tx:Tx,tenant:string,id:string){
 const [row]=await tx`select d.*,r.id revision_id,r.snapshot,r.snapshot_hash,r.draft_id,e.kind lifecycle,e.replacement_document_id from app.business_documents d join app.business_document_revisions r on r.tenant_id=d.tenant_id and r.document_id=d.id left join app.document_lifecycle_events e on e.tenant_id=d.tenant_id and e.document_id=d.id where d.tenant_id=${tenant}::uuid and d.id=${id}::uuid order by r.version desc limit 1`;
 if(!row)throw new ApiFault('NOT_FOUND');
 // Frozen issuance survives new prices, while source permission remains required.
 const [draft]=await tx`select basis_snapshot from app.document_drafts where tenant_id=${tenant}::uuid and id=${row.draft_id}::uuid`;
 await assertDocumentSources(tx,tenant,draft!.basis_snapshot);
 const files=await tx`select format,sha256,octet_length(bytes) byte_length from app.document_artifacts where tenant_id=${tenant}::uuid and revision_id=${row.revision_id}::uuid`;const [job]=await tx`select state,last_error_code from app.jobs where tenant_id=${tenant}::uuid and generated_revision_id=${row.revision_id}::uuid and job_type='render_document'`;
 const shares=await tx`select i.id,i.actor_id=nullif(current_setting('request.jwt.claim.sub',true),'')::uuid own,i.format,coalesce((select o.outcome from app.document_share_outcomes o where o.tenant_id=i.tenant_id and o.intent_id=i.id order by (o.outcome='user_confirmed') desc,o.created_at desc,o.id desc limit 1),'prepared') state from app.document_share_intents i where i.tenant_id=${tenant}::uuid and i.document_id=${id}::uuid order by i.created_at desc,i.id desc limit 10`;
 return {shares,files,render_error:['INVALID_PUBLIC_DOCUMENT','INVALID_RENDER','RENDER_LIMIT'].includes(job?.last_error_code)?String(job!.last_error_code):null,render_state:job?.state??'queued',id:row.id,revision_id:row.revision_id,document:row.snapshot,snapshot_hash:row.snapshot_hash,state:row.lifecycle??'approved',replacement_id:row.replacement_document_id,delivery_state:'unknown',payment_confirmed:false};
}

async function reverseInvoice(tx:Tx,tenant:string,user:string,id:string,command:string){
 const [invoice]=await tx`select * from app.invoices where tenant_id=${tenant}::uuid and id=${id}::uuid`;if(!invoice||invoice.status!=='approved')throw new ApiFault('VERSION_CONFLICT');
 await lockBilling(tx,tenant,[String(invoice.agreement_id)]);
 const cash=await tx`select a.*,c.account_token,c.version cash_version from app.cash_applications a join app.cash_records c on c.tenant_id=a.tenant_id and c.id=a.cash_record_id where a.tenant_id=${tenant}::uuid and a.invoice_id=${id}::uuid and a.kind='apply' order by c.account_token,a.id`;
 for(const account of [...new Set(cash.map(c=>String(c.account_token)))])await tx`select pg_advisory_xact_lock(hashtextextended(${tenant+':cash-account:'+account},0))`;
 await tx`select id from app.invoices where tenant_id=${tenant}::uuid and id=${id}::uuid for update`;
 for(const a of cash){
  const [prior]=await tx`select coalesce(sum(amount_minor),0)::text n from app.cash_applications where tenant_id=${tenant}::uuid and reverses_application_id=${a.id}::uuid`;
  const amount=BigInt(a.amount_minor)-BigInt(prior!.n);if(amount===0n)continue;
  const [e]=await tx`select evidence_ids from app.decisions where tenant_id=${tenant}::uuid and id=${a.decision_id}::uuid`;
  const dec=await decision(tx,tenant,user,'cash_application','reversal',[String(a.cash_record_id),id],[Number(a.cash_version),Number(invoice.version)],e!.evidence_ids,{command,original:a.id});
  await tx`insert into app.cash_applications(tenant_id,id,cash_record_id,invoice_id,amount_minor,kind,reverses_application_id,decision_id) values(${tenant}::uuid,${randomUUID()}::uuid,${a.cash_record_id}::uuid,${id}::uuid,${amount.toString()}::numeric,'reversal',${a.id}::uuid,${dec}::uuid)`;
  await tx`update app.cash_records set version=version+1 where tenant_id=${tenant}::uuid and id=${a.cash_record_id}::uuid`;
 }
 const offsets=await tx`select s.* from app.noncash_settlements s where s.tenant_id=${tenant}::uuid and s.receivable_invoice_id=${id}::uuid and s.kind<>'reversal' and not exists(select 1 from app.noncash_settlements n where n.tenant_id=s.tenant_id and n.reverses_settlement_id=s.id)`;
 for(const s of offsets){const dec=await decision(tx,tenant,user,'noncash_settlement','reversal',[id],[Number(invoice.version)],[String(s.evidence_id)],{command,original:s.id});await tx`insert into app.noncash_settlements(tenant_id,id,receivable_invoice_id,payable_invoice_id,amount_minor,decision_id,evidence_id,kind,basis_kind,reverses_settlement_id) values(${tenant}::uuid,${randomUUID()}::uuid,${s.receivable_invoice_id}::uuid,${s.payable_invoice_id}::uuid,${s.amount_minor}::numeric,${dec}::uuid,${s.evidence_id}::uuid,'reversal','reversal_basis',${s.id}::uuid)`;}
 const dec=await decision(tx,tenant,user,'invoice_reversal','reverse',[id],[Number(invoice.version)],[String(invoice.source_evidence_id)],{command});
 await tx`update app.invoices set status='reversed',version=version+1,reversal_decision_id=${dec}::uuid where tenant_id=${tenant}::uuid and id=${id}::uuid`;
}
export function registerDocumentIssuance(app:FastifyInstance,services:Services){
 app.post('/v1/documents/issue',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),p=issueBody.safeParse(req.body);if(!p.success)throw new ApiFault('INVALID_CONTRACT');
  return inAuthorizedTransaction(services.db,actor,async tx=>{if(await membership(tx,tenant,actor.userId)!=='owner')throw new ApiFault('NOT_FOUND');return once(tx,tenant,actor.userId,'documents.issue',p.data.client_command_id,jsonHash(p.data),async()=>({status:201,body:await issueDocuments(tx,tenant,actor.userId,p.data)}));});
 }));
 app.get<{Params:{id:string}}>('/v1/documents/:id',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),id=z.uuid().parse(req.params.id);return inAuthorizedTransaction(services.db,actor,async tx=>({status:200,body:await readIssuedDocument(tx,tenant,id)}));
 }));
 app.post<{Params:{id:string}}>('/v1/documents/:id/cancel',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),id=z.uuid().safeParse(req.params.id),p=z.strictObject({client_command_id:z.uuid(),expected_hash:z.string().regex(/^[a-f0-9]{64}$/),replacement:issueBody.optional()}).safeParse(req.body);if(!id.success||!p.success)throw new ApiFault('INVALID_CONTRACT');
  return inAuthorizedTransaction(services.db,actor,async tx=>{if(await membership(tx,tenant,actor.userId)!=='owner')throw new ApiFault('NOT_FOUND');return once(tx,tenant,actor.userId,'documents.cancel',p.data.client_command_id,jsonHash({id:id.data,...p.data}),async()=>{
   const doc=await readIssuedDocument(tx,tenant,id.data);if(doc.snapshot_hash!==p.data.expected_hash||doc.state!=='approved')throw new ApiFault('VERSION_CONFLICT');
   const reconciled=new Set<string>();
   if(p.data.replacement){if(p.data.replacement.drafts.length!==1||doc.document.type!=='invoice')throw new ApiFault('INVALID_CONTRACT');for(const target of p.data.replacement.drafts){const draft=await readDraft(tx,tenant,target.id);if(draft.stale||draft.document.type!=='invoice'||draft.document.project.id!==doc.document.project.id||draft.document.basis_hash!==target.basis_hash)throw new ApiFault('VERSION_CONFLICT');reconciled.add(target.id);}}
   const invoices=await tx`select invoice_id from app.billing_reservations where tenant_id=${tenant}::uuid and document_revision_id=${doc.revision_id}::uuid and state='consumed' order by invoice_id`;
   const replacementBasis=p.data.replacement?await tx`select basis_snapshot->'agreement'->>'id' agreement from app.document_drafts where tenant_id=${tenant}::uuid and id=any(${p.data.replacement.drafts.map(d=>d.id)}::uuid[])`:[];
   const priorBasis=await tx`select agreement_id from app.invoices where tenant_id=${tenant}::uuid and id=any(${invoices.map(i=>i.invoice_id)}::uuid[])`;await lockBilling(tx,tenant,[...priorBasis.map(a=>String(a.agreement_id)),...replacementBasis.map(a=>String(a.agreement))]);
   for(const i of invoices)await reverseInvoice(tx,tenant,actor.userId,String(i.invoice_id),p.data.client_command_id);
   let replacement:null|Awaited<ReturnType<typeof issueDocuments>>=null;
   if(p.data.replacement)replacement=await issueDocuments(tx,tenant,actor.userId,p.data.replacement,reconciled);
   const [priorApproval]=await tx`select d.evidence_ids,r.draft_id from app.decisions d join app.business_document_revisions r on r.tenant_id=d.tenant_id and r.approval_decision_id=d.id where r.tenant_id=${tenant}::uuid and r.id=${doc.revision_id}::uuid`;
   const dec=await decision(tx,tenant,actor.userId,'document_issue',replacement?'replace':'cancel',[id.data],[1],priorApproval!.evidence_ids,p.data,String(priorApproval!.draft_id));
   await tx`insert into app.document_lifecycle_events(tenant_id,id,document_id,command_id,kind,replacement_document_id,decision_id) values(${tenant}::uuid,${randomUUID()}::uuid,${id.data}::uuid,${p.data.client_command_id}::uuid,${replacement?'replaced':'cancelled'},${replacement?.documents[0]?.id??null}::uuid,${dec}::uuid)`;
   return {status:200,body:{id:id.data,state:replacement?'replaced':'cancelled',replacement,cash_preserved:true,cash_application_state:'unallocated_for_reconciliation'}};
  });});
 }));
}
