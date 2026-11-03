import {createHash} from "node:crypto";
import {z} from "zod";
import type {FastifyInstance} from "fastify";
import {inAuthorizedTransaction,type Principal,type Tx} from "./auth.js";
import {ApiFault,execute,membership,principal,tenantHeader,type Services} from "./routes.js";
import {VOICE_VERSION,shortAudio,ShortSttNotAccepted} from "./short-stt.js";
import {reserveProductAi,submitProductAi,finishProductAi,type ProductReservation} from './product-ai.js';
import {audioCostKrw} from './product-ai-config.js';
async function voiceTx<T>(services:Services,actor:Principal,work:(tx:Tx)=>Promise<T>):Promise<T>{const result=await inAuthorizedTransaction(services.db,actor,async tx=>({status:200,body:await work(tx)}));if(!result)throw new ApiFault("UNAUTHENTICATED");return result.body as T;}
const input=z.strictObject({id:z.uuid(),mime:z.enum(["audio/webm","audio/ogg","audio/wav"]),audio:z.string().min(24).max(1048576).regex(/^[A-Za-z0-9+/]+={0,2}$/),consent_version:z.literal(VOICE_VERSION)});
export function registerVoiceRoutes(app:FastifyInstance,services:Services){
 const active=new Map<string,AbortController>();
 app.addHook("onClose",async()=>{for(const c of active.values())c.abort();});
 app.get("/v1/voice/status",async(req,reply)=>execute(reply,async()=>{const actor=await principal(req,services),tenant=tenantHeader(req);return inAuthorizedTransaction(services.db,actor,async tx=>{
  if(await membership(tx,tenant,actor.userId)==="viewer")throw new ApiFault("NOT_FOUND");
  const [row]=await tx`select allowed from app.voice_consents where tenant_id=${tenant}::uuid and user_id=${actor.userId}::uuid and provider_version=${VOICE_VERSION}`;
  return {status:200,body:{enabled:Boolean(services.shortStt),consented:row?.allowed===true,provider:services.shortStt?.label??null,consent_version:VOICE_VERSION,max_seconds:30}};
 });}));
 app.post("/v1/voice/consent",async(req,reply)=>execute(reply,async()=>{const actor=await principal(req,services),tenant=tenantHeader(req),p=z.strictObject({allowed:z.boolean(),consent_version:z.literal(VOICE_VERSION)}).safeParse(req.body);if(!p.success)throw new ApiFault("INVALID_CONTRACT");return inAuthorizedTransaction(services.db,actor,async tx=>{
  if(await membership(tx,tenant,actor.userId)==="viewer")throw new ApiFault("NOT_FOUND");
  await tx`insert into app.voice_consents(tenant_id,user_id,provider_version,allowed) values(${tenant}::uuid,${actor.userId}::uuid,${VOICE_VERSION},${p.data.allowed}) on conflict(tenant_id,user_id,provider_version) do update set allowed=excluded.allowed,updated_at=now()`;
  if(!p.data.allowed){for(const [key,c] of active)if(key.startsWith(`${tenant}:${actor.userId}:`))c.abort();await tx`update app.voice_requests set state='cancelled',transcript=null where tenant_id=${tenant}::uuid and user_id=${actor.userId}::uuid and state='working'`;}
  return {status:200,body:{saved:true}};
 });}));
 app.get<{Params:{id:string}}>("/v1/voice/:id",async(req,reply)=>execute(reply,async()=>{const actor=await principal(req,services),tenant=tenantHeader(req),id=z.uuid().parse(req.params.id);return inAuthorizedTransaction(services.db,actor,async tx=>{
  await membership(tx,tenant,actor.userId);await tx`update app.voice_requests set state='failed' where tenant_id=${tenant}::uuid and user_id=${actor.userId}::uuid and id=${id}::uuid and state='working' and created_at<now()-interval '90 seconds'`;
  const [row]=await tx`select id,state,transcript from app.voice_requests where tenant_id=${tenant}::uuid and user_id=${actor.userId}::uuid and id=${id}::uuid`;if(!row)throw new ApiFault("NOT_FOUND");return {status:200,body:row};
 });}));
 app.post<{Params:{id:string}}>("/v1/voice/:id/cancel",async(req,reply)=>execute(reply,async()=>{const actor=await principal(req,services),tenant=tenantHeader(req),id=z.uuid().parse(req.params.id);return inAuthorizedTransaction(services.db,actor,async tx=>{
  await membership(tx,tenant,actor.userId);active.get(`${tenant}:${actor.userId}:${id}`)?.abort();await tx`update app.voice_requests set state='cancelled',transcript=null where tenant_id=${tenant}::uuid and user_id=${actor.userId}::uuid and id=${id}::uuid`;return {status:200,body:{cancelled:true}};
 });}));
 app.post("/v1/voice/transcribe",{bodyLimit:1100000},async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),p=input.safeParse(req.body);if(!p.success)throw new ApiFault("INVALID_CONTRACT");
  const b=p.data,engine=services.shortStt;if(!engine)return inAuthorizedTransaction(services.db,actor,async tx=>{if(await membership(tx,tenant,actor.userId)==="viewer")throw new ApiFault("NOT_FOUND");return {status:200,body:{id:b.id,state:"unavailable",transcript:null}};});
  const bytes=Buffer.from(b.audio,"base64");if(bytes.toString("base64")!==b.audio)throw new ApiFault("INVALID_CONTRACT");try{shortAudio(bytes,b.mime);}catch{throw new ApiFault("INVALID_CONTRACT");}
  const hash=createHash("sha256").update(bytes).update(b.mime).digest("hex"),key=`${tenant}:${actor.userId}:${b.id}`;
  const reservation=await voiceTx(services,actor,async tx=>{
   if(await membership(tx,tenant,actor.userId)==="viewer")throw new ApiFault("NOT_FOUND");
   await tx`select pg_advisory_xact_lock(hashtextextended(${tenant+":voice-budget"},0))`;
   const [consent]=await tx`select allowed,(extract(epoch from updated_at)*1000000)::bigint::text generation from app.voice_consents where tenant_id=${tenant}::uuid and user_id=${actor.userId}::uuid and provider_version=${VOICE_VERSION}`;if(!consent?.allowed)throw new ApiFault("DOMAIN_INVARIANT");
   const [old]=await tx`select id,state,transcript,request_hash from app.voice_requests where tenant_id=${tenant}::uuid and user_id=${actor.userId}::uuid and id=${b.id}::uuid`;
   if(old){if(old.request_hash!==hash)throw new ApiFault("IDEMPOTENCY_CONFLICT");return {old};}
   const [budget]=await tx`select app.voice_used_seconds(${tenant}::uuid) used`;
   if(active.size>=4)return {old:{id:b.id,state:"busy",transcript:null}};
   if(Number(budget?.used)+31>engine.dailySeconds)return {old:{id:b.id,state:"limited",transcript:null}};
   await tx`insert into app.voice_requests(tenant_id,user_id,id,request_hash,state,model_version,provider_version,reserved_seconds) values(${tenant}::uuid,${actor.userId}::uuid,${b.id}::uuid,${hash},'working',${engine.model},${engine.version},31)`;return {old:null,generation:String(consent.generation)};
  });if(reservation.old)return {status:200,body:reservation.old};
  const control=new AbortController(),timer=setTimeout(()=>control.abort(),25000);active.set(key,control);
  let paid:ProductReservation|undefined,settled=false;
  try{
   const duration=await engine.probe(bytes,b.mime);if(duration<=0||duration>31||control.signal.aborted)throw new Error("VOICE_DURATION");
   const permitted=await voiceTx(services,actor,async tx=>{const [row]=await tx`select r.state,c.allowed,(extract(epoch from c.updated_at)*1000000)::bigint::text generation from app.voice_requests r join app.voice_consents c on c.tenant_id=r.tenant_id and c.user_id=r.user_id and c.provider_version=${VOICE_VERSION} where r.tenant_id=${tenant}::uuid and r.user_id=${actor.userId}::uuid and r.id=${b.id}::uuid`;return row?.state==="working"&&row.allowed&&row.generation===reservation.generation;});if(!permitted)throw new Error("VOICE_CANCELLED");
   if(engine.model!=='fixture'){
    if(!engine.billing||Date.parse(engine.billing.valid_until)<=Date.now())throw new Error('VOICE_PRICE_REQUIRED');
    const r:ProductReservation={tenant,user:actor.userId,id:b.id,source:null,generation:null,revision:null,channel:'short_stt',hash,krw:audioCostKrw(engine.billing,duration),config:{model:engine.model,provider:'openai',price:engine.billing,consent_generation:reservation.generation!,seconds:duration}};
    const accepted=await voiceTx(services,actor,async tx=>{const v=await reserveProductAi(tx,r);return v.state==='reserved'&&await submitProductAi(tx,r);});
    if(!accepted){await voiceTx(services,actor,async tx=>await tx`update app.voice_requests set state='failed' where tenant_id=${tenant}::uuid and user_id=${actor.userId}::uuid and id=${b.id}::uuid and state='working'`);return {status:200,body:{id:b.id,state:'limited',transcript:null}};}paid=r;
   }
   const transcript=await engine.transcribe(bytes,b.mime,control.signal);
   // Cancellation fences the transcript, but cannot undo an already completed provider call.
   if(paid){await voiceTx(services,actor,tx=>finishProductAi(tx,paid!,paid!.krw,null,null,{measured_seconds:duration,pricing:'duration_estimate'}));settled=true;}
   if(!transcript.trim()||transcript.length>2000||control.signal.aborted)throw new Error("VOICE_EMPTY");
   return await inAuthorizedTransaction(services.db,actor,async tx=>{const rows=await tx`update app.voice_requests set state='completed',transcript=${transcript},duration_seconds=${duration} where tenant_id=${tenant}::uuid and user_id=${actor.userId}::uuid and id=${b.id}::uuid and state='working' and exists(select 1 from app.voice_consents where tenant_id=${tenant}::uuid and user_id=${actor.userId}::uuid and provider_version=${VOICE_VERSION} and allowed and (extract(epoch from updated_at)*1000000)::bigint::text=${reservation.generation!}) returning id,state,transcript`;return {status:200,body:rows[0]??{id:b.id,state:"cancelled",transcript:null}};});
  }catch(error){if(paid&&!settled){const rejected=error instanceof ShortSttNotAccepted;await voiceTx(services,actor,tx=>finishProductAi(tx,paid!,rejected?0:null,null,null,rejected?{error_code:'PROVIDER_NOT_ACCEPTED',http_status:error.status}:{error_code:'VOICE_OUTCOME_UNKNOWN'})).catch(()=>{});}await voiceTx(services,actor,async tx=>await tx`update app.voice_requests set state='failed' where tenant_id=${tenant}::uuid and user_id=${actor.userId}::uuid and id=${b.id}::uuid and state='working'`);return {status:200,body:{id:b.id,state:"failed",transcript:null}};}
  finally{clearTimeout(timer);active.delete(key);bytes.fill(0);}
 }));
}
