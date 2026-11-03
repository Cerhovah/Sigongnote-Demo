import type {FastifyInstance} from 'fastify';
import type {Tx} from './auth.js';
import type {Services} from './routes.js';
import {deliverySource} from './delivery-source.js';
import {faxAccountHash,type FaxResult} from './fax-provider.js';

export async function runDeliveryOnce(services:Services,tenant:string){
 const runtime=services.fax,account=runtime?.accounts.find(a=>a.tenant===tenant);if(!runtime||!account)return 'disabled';
 const [row]=await services.db`select app.claim_delivery(${tenant}::uuid) value`;const lease=row?.value;if(!lease)return 'idle';
 const scoped=async<T>(fn:(tx:Tx)=>Promise<T>)=>services.db.begin(async tx=>{await tx`select set_config('request.jwt.claim.sub',${lease.actor},true)`;return fn(tx);});
 const context=()=>scoped(async tx=>{
  const [o]=await tx`select id from app.outbox where tenant_id=${tenant}::uuid and id=${lease.outbox}::uuid and business_lease=${lease.token}::uuid and business_lease_until>now()`;if(!o)return null;
  const [d]=await tx`select * from app.deliveries where tenant_id=${tenant}::uuid and id=${lease.id}::uuid for update`;if(!d)return null;
  const [a]=await tx`select * from app.delivery_attempts where tenant_id=${tenant}::uuid and id=${lease.attempt}::uuid and delivery_id=${d.id}::uuid for update`;return a?{d,a}:null;
 });
 const finalState=(state:string)=>['delivered','failed','cancelled'].includes(state);
 const settle=async(result:FaxResult,unit:number|null)=>scoped(async tx=>{
  const [d]=await tx`select * from app.deliveries where tenant_id=${tenant}::uuid and id=${lease.id}::uuid for update`;if(!d)return false;
  const [a]=await tx`select * from app.delivery_attempts where tenant_id=${tenant}::uuid and id=${lease.attempt}::uuid for update`;
  if(!a)return false;
  if(finalState(a.state)&&(a.actual_krw!==null||result.state!==a.state))return a.actual_krw!==null;
  if(!a.submitted_at)return false;
  const charge=result.chargePages!==null&&unit!==null?Math.ceil(result.chargePages*unit):null;
  // Never turn a previously observed amount into zero on an incomplete status response.
  await tx`update app.delivery_attempts set state=${result.state},receipt=coalesce(${result.receipt},receipt),actual_krw=coalesce(${charge},actual_krw),finished_at=case when ${['delivered','failed','cancelled'].includes(result.state)} then now() else null end where tenant_id=${tenant}::uuid and id=${a.id}::uuid`;
  await tx`update app.deliveries set state=${result.state} where tenant_id=${tenant}::uuid and id=${d.id}::uuid and current_attempt=${a.id}::uuid`;return finalState(result.state)&&(charge!==null||a.actual_krw!==null);
 });
 let terminal=false;
 try{
  const c=await context();if(!c)return 'stale';const {d,a}=c;
  if(finalState(a.state)&&a.actual_krw!==null){terminal=true;return 'finished';}
  const bindingChanged=a.provider_account_hash!==faxAccountHash(account,runtime.binding);
  const gateReason=bindingChanged?'account_changed':new Date(a.expires_at).getTime()<=Date.now()||Date.parse(account.valid_until)<=Date.now()?'expired':null;
  if(!a.submitted_at&&gateReason){
   terminal=await scoped(async tx=>{const [d]=await tx`select id from app.deliveries where tenant_id=${tenant}::uuid and id=${lease.id}::uuid for update`;if(!d)return false;const changed=await tx`update app.delivery_attempts set state='cancelled',cancel_reason=${gateReason},actual_krw=0,finished_at=now() where tenant_id=${tenant}::uuid and id=${a.id}::uuid and state='authorized' and submitted_at is null returning id`;if(!changed.length)return false;await tx`update app.deliveries set state='cancelled' where tenant_id=${tenant}::uuid and id=${d.id}::uuid and current_attempt=${a.id}::uuid`;return true;});
   return terminal?'cancelled':'stale';
  }
  if(bindingChanged)return 'account_changed';
  const provider=runtime.provider(account);
  if(a.submitted_at){
   let result:FaxResult;try{result=await provider.lookup(a.id,d.recipient_number);}catch{result={state:'unknown',receipt:null,chargePages:null};}
   terminal=await settle(result,typeof a.price.unit_krw==='number'?a.price.unit_krw:null);return result.state;
  }
  // Price discovery has no document payload. Consent and expiry are checked again after it.
  let unit:number;try{unit=await provider.price(d.recipient_number);}catch{return 'price_wait';}
  const input=await scoped(async tx=>{
   const [current]=await tx`select d.*,a.state attempt_state,a.expires_at,a.approved_hash from app.deliveries d join app.delivery_attempts a on a.tenant_id=d.tenant_id and a.id=${lease.attempt}::uuid where d.tenant_id=${tenant}::uuid and d.id=${d.id}::uuid for update of d,a`;
   const [o]=await tx`select id from app.outbox where tenant_id=${tenant}::uuid and id=${lease.outbox}::uuid and business_lease=${lease.token}::uuid and business_lease_until>now()`;
   if(!current||!o||current.attempt_state!=='authorized'||current.state!=='authorized'||current.current_attempt!==a.id)return null;
   const cancel=async(reason:'expired'|'price_over_cap'|'source_changed')=>{await tx`update app.delivery_attempts set state='cancelled',cancel_reason=${reason},actual_krw=0,finished_at=now() where tenant_id=${tenant}::uuid and id=${a.id}::uuid`;await tx`update app.deliveries set state='cancelled' where tenant_id=${tenant}::uuid and id=${d.id}::uuid`;terminal=true;return null;};
   if(new Date(current.expires_at).getTime()<=Date.now()||Date.parse(account.valid_until)<=Date.now())return cancel('expired');
   if(!Number.isFinite(unit)||unit<=0||unit>a.price.max_page_krw)return cancel('price_over_cap');
   if(current.approved_hash!==current.scope_hash)return cancel('source_changed');
   let file:Awaited<ReturnType<typeof deliverySource>>;try{file=await deliverySource(tx,tenant,d.source_kind,d.source_id);}catch{return cancel('source_changed');}
   if(file.sha256!==d.document_hash||file.revision!==d.revision_id)return cancel('source_changed');
   // Persist the request ID and submitted fence BEFORE crossing the external boundary.
   await tx`update app.delivery_attempts set state='submitted',submitted_at=now(),price=${tx.json({...a.price,unit_krw:unit})} where tenant_id=${tenant}::uuid and id=${a.id}::uuid`;
   await tx`update app.deliveries set state='submitted' where tenant_id=${tenant}::uuid and id=${d.id}::uuid`;return {request:String(a.id),number:String(d.recipient_number),name:String(d.recipient_name),bytes:file.bytes};
  });
  if(!input)return terminal?'cancelled':'stale';
  let result:FaxResult;try{result=await provider.send(input);}catch{result={state:'unknown',receipt:null,chargePages:null};}
  terminal=await settle(result,unit);return result.state;
 }finally{await scoped(tx=>tx`select app.finish_delivery_tick(${tenant}::uuid,${lease.outbox}::uuid,${lease.token}::uuid,${terminal})`);}
}
export function startDeliveryWorker(app:FastifyInstance,services:Services){
 if(!services.fax)return;let stop=false,timer:ReturnType<typeof setTimeout>|undefined,running:Promise<unknown>=Promise.resolve();
 const tick=()=>{running=(async()=>{for(const a of services.fax!.accounts){if(stop)break;try{await runDeliveryOnce(services,a.tenant);}catch{/* Private operational metric only; no provider/source payload logging. */}}})().finally(()=>{if(!stop){timer=setTimeout(tick,5000);timer.unref();}});};
 app.addHook('onReady',async()=>tick());app.addHook('onClose',async()=>{stop=true;if(timer)clearTimeout(timer);await running;});
}
