import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {inAuthorizedTransaction} from './auth.js';
import {ApiFault,execute,membership,principal,tenantHeader,type Services} from './routes.js';
import {readOperations} from './operations.js';
const event=z.strictObject({id:z.uuid(),session_id:z.uuid(),happened_at:z.iso.datetime(),kind:z.enum(['click','request','result','error','session','gap']),screen:z.string().max(80),label:z.string().max(160),platform:z.enum(['web','windows','android']),content:z.string().max(40000),truncated:z.boolean()});
const batch=z.strictObject({consent_id:z.uuid(),events:z.array(event).min(1).max(20)});
/** Server configuration only; a company owner is not automatically a product observer. */
export function configuredActivityObservers(raw=process.env.ACTIVITY_OBSERVER_USER_IDS):string[]{
 return z.array(z.uuid()).parse((raw??'').split(',').map(v=>v.trim()).filter(Boolean));
}
export function registerActivity(app:FastifyInstance,services:Services,operationsReader=readOperations){
 const canObserve=(role:string,userId:string)=>role==='owner'&&services.activityObserverUserIds?.includes(userId)===true;
 const purge=()=>services.db`select app.purge_expired_activity(),app.purge_learning_cases()`;
 const retentionTimer=setInterval(()=>{void purge().catch(()=>{});},3600000);retentionTimer.unref();app.addHook('onClose',async()=>{clearInterval(retentionTimer);});
 app.post('/v1/work/activity/delete',async(req,reply)=>execute(reply.header('Cache-Control','no-store'),async()=>{const actor=await principal(req,services),tenant=tenantHeader(req);if(!z.strictObject({}).safeParse(req.body).success)throw new ApiFault('INVALID_CONTRACT');return inAuthorizedTransaction(services.db,actor,async tx=>{
  await membership(tx,tenant,actor.userId);await tx`update app.activity_consents set consent_id=gen_random_uuid(),updated_at=now() where tenant_id=${tenant}::uuid and user_id=${actor.userId}::uuid`;
  await tx`delete from app.activity_events where tenant_id=${tenant}::uuid and user_id=${actor.userId}::uuid`;return {status:200,body:{deleted:true}};
 });}));
 app.get('/v1/work/activity/status',async(req,reply)=>execute(reply.header('Cache-Control','no-store'),async()=>{const actor=await principal(req,services),tenant=tenantHeader(req);return inAuthorizedTransaction(services.db,actor,async tx=>{
  const role=await membership(tx,tenant,actor.userId);const [c]=await tx`select allowed,consent_id from app.activity_consents where tenant_id=${tenant}::uuid and user_id=${actor.userId}::uuid`;
  return {status:200,body:{allowed:c?.allowed??null,consent_id:c?.consent_id??null,can_view_activity:canObserve(role,actor.userId)}};
 });}));
 app.post('/v1/work/activity/consent',async(req,reply)=>execute(reply.header('Cache-Control','no-store'),async()=>{const actor=await principal(req,services),tenant=tenantHeader(req),p=z.strictObject({allowed:z.boolean()}).safeParse(req.body);if(!p.success)throw new ApiFault('INVALID_CONTRACT');return inAuthorizedTransaction(services.db,actor,async tx=>{
  const role=await membership(tx,tenant,actor.userId);const [c]=await tx`insert into app.activity_consents(tenant_id,user_id,allowed) values(${tenant}::uuid,${actor.userId}::uuid,${p.data.allowed}) on conflict(tenant_id,user_id) do update set allowed=excluded.allowed,consent_id=case when app.activity_consents.allowed=excluded.allowed then app.activity_consents.consent_id else gen_random_uuid() end,updated_at=now() returning allowed,consent_id`;
  return {status:200,body:{...c,can_view_activity:canObserve(role,actor.userId)}};
 });}));
 app.post('/v1/work/activity/events',{bodyLimit:500000},async(req,reply)=>execute(reply.header('Cache-Control','no-store'),async()=>{const actor=await principal(req,services),tenant=tenantHeader(req),p=batch.safeParse(req.body);if(!p.success||JSON.stringify(req.body).length>120000)throw new ApiFault('INVALID_CONTRACT');return inAuthorizedTransaction(services.db,actor,async tx=>{
  await membership(tx,tenant,actor.userId);const [c]=await tx`select allowed,consent_id from app.activity_consents where tenant_id=${tenant}::uuid and user_id=${actor.userId}::uuid for share`;
  if(!c?.allowed||c.consent_id!==p.data.consent_id)return {status:200,body:{accepted:[],consent_expired:true}};
  for(const e of p.data.events)await tx`insert into app.activity_events(tenant_id,user_id,consent_id,id,session_id,happened_at,kind,screen,label,platform,content,truncated) values(${tenant}::uuid,${actor.userId}::uuid,${p.data.consent_id}::uuid,${e.id}::uuid,${e.session_id}::uuid,${e.happened_at}::timestamptz,${e.kind},${e.screen},${e.label},${e.platform},${e.content},${e.truncated}) on conflict(tenant_id,user_id,id) do nothing`;
  return {status:200,body:{accepted:p.data.events.map(e=>e.id),consent_expired:false}};
 });}));
 app.get('/v1/work/activity',async(req,reply)=>execute(reply.header('Cache-Control','no-store'),async()=>{const actor=await principal(req,services),tenant=tenantHeader(req),p=z.strictObject({cursor:z.uuid().optional(),q:z.string().max(80).optional()}).safeParse(req.query);if(!p.success)throw new ApiFault('INVALID_CONTRACT');return inAuthorizedTransaction(services.db,actor,async tx=>{
  if(!canObserve(await membership(tx,tenant,actor.userId),actor.userId))throw new ApiFault('NOT_FOUND');
  const [cursor]=p.data.cursor?await tx`select seq from app.activity_events where tenant_id=${tenant}::uuid and id=${p.data.cursor}::uuid limit 1`:[];if(p.data.cursor&&!cursor)throw new ApiFault('NOT_FOUND');
  await tx`select app.purge_expired_activity()`;
  const rows=await tx`select e.id,('사용자 '||c.participant_no::text) as user_label,e.session_id,happened_at,received_at,kind,screen,label,platform,content,truncated from app.activity_events e join app.activity_consents c on c.tenant_id=e.tenant_id and c.user_id=e.user_id where e.tenant_id=${tenant}::uuid and (${cursor?.seq??null}::bigint is null or seq<${cursor?.seq??null}::bigint) and (${p.data.q??''}='' or position(lower(${p.data.q??''}) in lower(label||' '||content))>0) order by seq desc limit 31`;
  const [summary]=await tx`select count(*) filter(where kind='click')::int clicks,count(*) filter(where kind='request')::int requests,count(*) filter(where kind='result')::int results,count(*) filter(where kind='error')::int errors,count(distinct session_id)::int sessions,count(distinct user_id)::int participants,min(received_at) first_at,max(received_at) last_at from app.activity_events where tenant_id=${tenant}::uuid and received_at>=now()-interval '30 days'`;
  const days=await tx`select (received_at at time zone 'Asia/Seoul')::date::text as "day",count(*) filter(where kind='click')::int clicks,count(*) filter(where kind='request')::int requests,count(*) filter(where kind='error')::int errors from app.activity_events where tenant_id=${tenant}::uuid and received_at>=now()-interval '7 days' group by 1 order by 1`;
  // A failed optional query must roll back to a savepoint: catching a PostgreSQL
  // error alone leaves the whole activity transaction aborted.
  const operations=await tx.savepoint(nested=>operationsReader(nested,tenant)).catch(()=>null);
  return {status:200,body:{summary,days,events:rows.slice(0,30),next_cursor:rows.length>30?rows[29]?.id:null,period_days:30,operations}};
 });}));
}
