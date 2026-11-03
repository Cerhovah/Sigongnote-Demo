import {randomUUID,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {inAuthorizedTransaction,type Tx} from './auth.js';
import {ApiFault,execute,membership,once,principal,tenantHeader,type Services} from './routes.js';
import {jsonHash} from './document-issuance.js';
import {deliverySource} from './delivery-source.js';
import {faxAccountHash,type FaxRuntime} from './fax-provider.js';
import type {AgentScope} from './agent-tools.js';
const kind=z.enum(['document','photo_sheet']),hash=z.string().regex(/^[a-f0-9]{64}$/);
const source=z.strictObject({source_kind:kind,source_id:z.uuid()});
const prepare=source.extend({recipient_id:z.uuid().optional(),recipient_name:z.string().trim().min(1).max(30).optional(),recipient_number:z.string().regex(/^0[0-9]{8,11}$/).optional()});
function parse<T>(s:z.ZodType<T>,v:unknown){const p=s.safeParse(v);if(!p.success)throw new ApiFault('INVALID_CONTRACT');return p.data;}
export async function readDelivery(tx:Tx,tenant:string,id:string){
 const [d]=await tx`select d.*,a.reserved_krw,a.actual_krw,a.expires_at,a.receipt,a.cancel_reason,(select count(*)::int from app.delivery_attempts n where n.tenant_id=d.tenant_id and n.delivery_id=d.id) attempts,(select count(*)::int from app.delivery_attempts n where n.tenant_id=d.tenant_id and n.delivery_id=d.id and n.submitted_at is not null) submitted_attempts,(select coalesce(sum(reserved_krw) filter(where actual_krw is null),0)::int from app.delivery_attempts n where n.tenant_id=d.tenant_id and n.delivery_id=d.id) pending_cost_krw,(select coalesce(sum(actual_krw),0)::int from app.delivery_attempts n where n.tenant_id=d.tenant_id and n.delivery_id=d.id) known_cost_krw from app.deliveries d left join app.delivery_attempts a on a.tenant_id=d.tenant_id and a.id=d.current_attempt where d.tenant_id=${tenant}::uuid and d.id=${id}::uuid`;if(!d)throw new ApiFault('NOT_FOUND');
 let available=true;try{const f=await deliverySource(tx,tenant,d.source_kind,d.source_id,false,false);available=f.sha256===d.document_hash&&f.revision===d.revision_id;}catch{available=false;}
 return {id:String(d.id),project_id:String(d.project_id),source_kind:d.source_kind as 'document'|'photo_sheet',source_id:String(d.source_id),title:available?String(d.title):'접근할 수 없는 문서',pages:Number(d.pages),recipient_name:String(d.recipient_name),recipient_number:String(d.recipient_number),scope_hash:String(d.scope_hash),state:String(d.state),cancel_reason:d.cancel_reason as string|null,available,attempts:Number(d.attempts),submitted_attempts:Number(d.submitted_attempts),pending_cost_krw:Number(d.pending_cost_krw),known_cost_krw:Number(d.known_cost_krw),reserved_krw:d.reserved_krw as number|null,actual_krw:d.actual_krw as number|null,delivery_confirmed:d.state==='delivered',read_confirmed:false};
}
export async function prepareDelivery(tx:Tx,scope:Pick<AgentScope,'tenant'|'user'|'project'>,input:unknown){
 const b=parse(prepare,input),{tenant,user,project}=scope;if(await membership(tx,tenant,user)!=='owner')throw new ApiFault('NOT_FOUND');const file=await deliverySource(tx,tenant,b.source_kind,b.source_id,true,false);if(!project||file.project!==project)throw new ApiFault('NOT_FOUND');
 let name=b.recipient_name,number=b.recipient_number;
 if(b.recipient_id){const [r]=await tx`select name,number from app.delivery_recipients where tenant_id=${tenant}::uuid and id=${b.recipient_id}::uuid and project_id=${project}::uuid`;if(!r)throw new ApiFault('NOT_FOUND');name=String(r.name);number=String(r.number);}else if(!name||!number){return {delivery_choices:true};}
 await tx`insert into app.delivery_recipients(tenant_id,id,project_id,name,number,actor_id) values(${tenant}::uuid,${randomUUID()}::uuid,${project}::uuid,${name},${number},${user}::uuid) on conflict(tenant_id,project_id,name,number) do nothing`;
 const scopeHash=jsonHash({source_kind:b.source_kind,source_id:b.source_id,revision:file.revision,document_hash:file.sha256,recipient_name:name,recipient_number:number,channel:'fax',pages:file.pages});
 await tx`select pg_advisory_xact_lock(hashtextextended(${tenant+':delivery:'+user+scopeHash},0))`;
 const [old]=await tx`select id from app.deliveries where tenant_id=${tenant}::uuid and actor_id=${user}::uuid and scope_hash=${scopeHash}`;const id=old?.id as string??randomUUID();
 if(!old)await tx`insert into app.deliveries(tenant_id,id,actor_id,project_id,source_kind,source_id,revision_id,document_hash,title,pages,recipient_name,recipient_number,scope_hash) values(${tenant}::uuid,${id}::uuid,${user}::uuid,${project}::uuid,${b.source_kind},${b.source_id}::uuid,${file.revision}::uuid,${file.sha256},${file.title},${file.pages},${name},${number},${scopeHash})`;
 return {delivery:await readDelivery(tx,tenant,id)};
}
export async function requestAgentDelivery(tx:Tx,scope:AgentScope,input:unknown){
 const b=parse(z.strictObject({delivery_id:z.uuid().optional(),source_kind:kind.optional(),source_id:z.uuid().optional(),recipient_id:z.uuid().optional()}),input);
 if(b.delivery_id){const d=await readDelivery(tx,scope.tenant,b.delivery_id);if(scope.project&&d.project_id!==scope.project)throw new ApiFault('NOT_FOUND');return {delivery:d};}
 if(!b.source_kind||!b.source_id)return {delivery_choices:true};
 // The model may select a remembered recipient; it can never authorize sending or invent a number.
 return prepareDelivery(tx,scope,{source_kind:b.source_kind,source_id:b.source_id,...(b.recipient_id?{recipient_id:b.recipient_id}:{})});
}
export async function authorizeDelivery(tx:Tx,tenant:string,user:string,input:unknown,fax?:FaxRuntime){
 const b=parse(z.strictObject({id:z.uuid(),client_command_id:z.uuid(),scope_hash:hash,max_cost_krw:z.number().int().positive(),retry:z.boolean().default(false),duplicate_risk_ack:z.boolean().default(false)}),input);
 if(await membership(tx,tenant,user)!=='owner')throw new ApiFault('NOT_FOUND');
 return once(tx,tenant,user,'delivery.authorize',b.client_command_id,jsonHash(b),async()=>{
  const [d]=await tx`select * from app.deliveries where tenant_id=${tenant}::uuid and id=${b.id}::uuid and actor_id=${user}::uuid for update`;if(!d)throw new ApiFault('NOT_FOUND');const account=fax?.accounts.find(a=>a.tenant===tenant);
  if(!account||Date.parse(account.valid_until)<=Date.now())throw new ApiFault('TEMPORARILY_UNAVAILABLE');
  if(d.scope_hash!==b.scope_hash)throw new ApiFault('VERSION_CONFLICT');const file=await deliverySource(tx,tenant,d.source_kind,d.source_id,false,false);if(file.sha256!==d.document_hash||file.revision!==d.revision_id)throw new ApiFault('VERSION_CONFLICT');
  const [tries]=await tx`select count(*) filter(where submitted_at is not null)::int n from app.delivery_attempts where tenant_id=${tenant}::uuid and delivery_id=${d.id}::uuid`;
  if(d.state!=='prepared'&&!(b.retry&&['delivered','failed','unknown','cancelled'].includes(d.state)&&(tries!.n===0||b.duplicate_risk_ack)))throw new ApiFault('DOMAIN_INVARIANT');
  const cost=Number(d.pages)*account.max_page_krw;if(b.max_cost_krw!==cost)throw new ApiFault('VERSION_CONFLICT');
  await tx`select pg_advisory_xact_lock(hashtextextended(${tenant+':fax-budget:'+user},0))`;
  const [usage]=await tx`select coalesce(sum(coalesce(actual_krw,reserved_krw)) filter(where created_at>=date_trunc('day',now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul'),0)::int daily,coalesce(sum(coalesce(actual_krw,reserved_krw)),0)::int monthly from app.delivery_attempts where tenant_id=${tenant}::uuid and actor_id=${user}::uuid and created_at>=date_trunc('month',now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul'`;
  if(Number(usage!.daily)+cost>account.day_krw||Number(usage!.monthly)+cost>account.month_krw)throw new ApiFault('DOMAIN_INVARIANT');
  if(tries!.n>=3)throw new ApiFault('DOMAIN_INVARIANT');
  const attempt=randomUUID();await tx`insert into app.delivery_attempts(tenant_id,delivery_id,id,actor_id,state,approved_hash,expires_at,provider_account_hash,price,reserved_krw) values(${tenant}::uuid,${d.id}::uuid,${attempt}::uuid,${user}::uuid,'authorized',${d.scope_hash},least(now()+interval '15 minutes',${account.valid_until}::timestamptz),${faxAccountHash(account,fax!.binding)},${tx.json({max_page_krw:account.max_page_krw,unit_krw:null})},${cost})`;
  await tx`update app.deliveries set state='authorized',current_attempt=${attempt}::uuid where tenant_id=${tenant}::uuid and id=${d.id}::uuid`;
  await tx`insert into app.outbox(tenant_id,topic,operation_key,delivery_id,delivery_attempt_id) values(${tenant}::uuid,'delivery_ready',${'delivery:'+attempt},${d.id}::uuid,${attempt}::uuid)`;
  return {status:200,body:{delivery:await readDelivery(tx,tenant,d.id)}};
 });
}
export function registerDeliveries(app:FastifyInstance,services:Services){
 app.get('/v1/deliveries',async(req,reply)=>execute(reply,async()=>{const actor=await principal(req,services),tenant=tenantHeader(req),b=parse(source,req.query);return inAuthorizedTransaction(services.db,actor,async tx=>{const f=await deliverySource(tx,tenant,b.source_kind,b.source_id,true,false),account=services.fax?.accounts.find(a=>a.tenant===tenant),ready=!!account&&Date.parse(account.valid_until)>Date.now();const rows=await tx`select id from app.deliveries where tenant_id=${tenant}::uuid and source_kind=${b.source_kind} and source_id=${b.source_id}::uuid order by created_at desc limit 20`;const receipts=[];for(const r of rows)receipts.push(await readDelivery(tx,tenant,r.id));return {status:200,body:{deliveries:receipts,recipients:await tx`select id,name,number from app.delivery_recipients where tenant_id=${tenant}::uuid and project_id=${f.project}::uuid order by created_at desc limit 20`,project_id:f.project,ready,max_cost_krw:ready?f.pages!*account!.max_page_krw:null,gate:ready?null:'팩스 연결을 준비 중이에요. PDF 공유는 바로 사용할 수 있어요.'}};});}));
 app.get<{Params:{id:string}}>('/v1/deliveries/:id',async(req,reply)=>execute(reply,async()=>{const actor=await principal(req,services),tenant=tenantHeader(req),id=parse(z.uuid(),req.params.id);return inAuthorizedTransaction(services.db,actor,async tx=>({status:200,body:await readDelivery(tx,tenant,id)}));}));
 app.post('/v1/deliveries/prepare',async(req,reply)=>execute(reply,async()=>{const actor=await principal(req,services),tenant=tenantHeader(req),b=parse(prepare.extend({project_id:z.uuid()}),req.body),{project_id,...input}=b;return inAuthorizedTransaction(services.db,actor,async tx=>({status:200,body:await prepareDelivery(tx,{tenant,user:actor.userId,project:project_id},input)}));}));
 app.post('/v1/deliveries/authorize',async(req,reply)=>execute(reply,async()=>{const actor=await principal(req,services),tenant=tenantHeader(req);return inAuthorizedTransaction(services.db,actor,tx=>authorizeDelivery(tx,tenant,actor.userId,req.body,services.fax));}));
 app.post('/v1/deliveries/cancel',async(req,reply)=>execute(reply,async()=>{const actor=await principal(req,services),tenant=tenantHeader(req),b=parse(z.strictObject({id:z.uuid(),scope_hash:hash}),req.body);return inAuthorizedTransaction(services.db,actor,async tx=>{const [d]=await tx`select * from app.deliveries where tenant_id=${tenant}::uuid and id=${b.id}::uuid and actor_id=${actor.userId}::uuid for update`;if(!d)throw new ApiFault('NOT_FOUND');if(d.scope_hash!==b.scope_hash)throw new ApiFault('VERSION_CONFLICT');if(!['prepared','authorized','cancelled'].includes(d.state))return {status:200,body:{cancelled:false,message:'이미 접수되었거나 접수 여부를 확인 중이에요. 전송 취소로 표시하지 않았어요.'}};await tx`update app.deliveries set state='cancelled' where tenant_id=${tenant}::uuid and id=${d.id}::uuid`;await tx`update app.delivery_attempts set state='cancelled',cancel_reason='user_cancelled',actual_krw=0,finished_at=now() where tenant_id=${tenant}::uuid and id=${d.current_attempt}::uuid and state='authorized' and submitted_at is null`;return {status:200,body:{cancelled:true}};});}));
 app.post('/v1/fax/webhook',async(req,reply)=>{
  const runtime=services.fax,key=req.headers['x-api-key'];if(!runtime?.webhookKey||typeof key!=='string'||Buffer.byteLength(key)!==Buffer.byteLength(runtime.webhookKey)||!timingSafeEqual(Buffer.from(key),Buffer.from(runtime.webhookKey))||Date.parse(runtime.webhookUntil??'')<=Date.now()||!Number.isFinite(Date.parse(runtime.webhookUntil??'')))return reply.code(401).send({result:'DENIED'});
  const b=z.object({corpNum:z.string().regex(/^\d{10}$/),requestNum:z.uuid()}).safeParse(req.body),event=req.headers['pb-webhook-mid'];if(!b.success||typeof event!=='string'||event.length<1||event.length>120||req.headers['pb-webhook-type']!=='FAX.STATE'||req.headers['pb-webhook-corpnum']!==b.data.corpNum)return reply.code(400).send({result:'INVALID'});
  const a=runtime.accounts.find(a=>a.corp===b.data.corpNum);if(a)await services.db`select app.wake_delivery(${a.tenant}::uuid,${b.data.requestNum}::uuid,${event})`;
  // A webhook only wakes polling: forged, duplicate or late body states never change delivery or money.
  return {result:'OK'};
 });
}
