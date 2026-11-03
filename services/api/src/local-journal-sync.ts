import {z} from 'zod';
import {CapturePolicySchema,capturePolicyEqual} from '@sigongnote/contracts';
import type {FastifyInstance} from 'fastify';
import {inAuthorizedTransaction,type Tx} from './auth.js';
import {ApiFault,execute,membership,once,principal,tenantHeader,type Services} from './routes.js';
import {createHash} from 'node:crypto';
import type {CapturePolicy} from './capture-scope.js';

const categories=z.array(z.enum(['agreement','drawing_material','delivery_work','billing_payment','inspection_defect'])).max(5);
const entry=z.strictObject({id:z.uuid(),received_at:z.iso.datetime(),file_name:z.string().trim().min(1).max(255),project_name:z.string().trim().max(100).nullable().optional(),project_id:z.uuid().nullable().optional(),categories,excerpt:z.string().max(12000),sha256:z.string().regex(/^[a-f0-9]{64}$/),mime:z.string().min(3).max(127),source_kind:z.string().max(60).default('local_file'),revision:z.number().int().positive().default(1),native_capture_id:z.uuid().optional()});
const push=z.strictObject({device_id:z.uuid(),items:z.array(entry).min(1).max(25)});
export function localJournalRow(r:Record<string,unknown>):Record<string,any>{return {...r,id:r.id,local_id:r.local_id,document_id:r.id,revision_number:Number(r.local_revision),declared_mime:r.mime,received_at:new Date(String(r.received_at)).toISOString(),parse_status:r.excerpt?'complete':'pending',reading_state:r.excerpt?'readable':'waiting',source_kind:'local_file',context_id:null,organization_state:r.project_id?'linked':'unassigned',organization_version:Number(r.version),readable_spans:r.excerpt?1:0,observations:[],audio:null,local_metadata:true};}
export async function readLocalJournal(tx:Tx,tenant:string,id:string){const [row]=await tx`select l.*,p.display_name project_name from app.local_journal_entries l left join app.projects p on p.tenant_id=l.tenant_id and p.id=l.project_id where l.tenant_id=${tenant}::uuid and l.id=${id}::uuid`;return row?localJournalRow(row):null;}
export async function readLocalAiConsent(tx:Tx,tenant:string,user:string,policy:CapturePolicy|undefined){
 const [row]=await tx`select allowed,generation,processing_policy from app.local_context_consents where tenant_id=${tenant}::uuid and user_id=${user}::uuid`;
 const current=!!policy&&!!row&&capturePolicyEqual(row.processing_policy,policy);
 return {allowed:!!row?.allowed&&current,version:Number(row?.generation??0),policy_current:current,processing_policy:policy??null};
}
export function registerLocalJournalSync(app:FastifyInstance,services:Services){
 app.post('/v1/local-journal/native-links',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),p=z.strictObject({device_id:z.uuid(),items:z.array(z.strictObject({id:z.uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/),native_capture_id:z.uuid()})).min(1).max(25)}).safeParse(req.body);if(!p.success)throw new ApiFault('INVALID_CONTRACT');
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   if(!['owner','operator'].includes(await membership(tx,tenant,actor.userId)))throw new ApiFault('NOT_FOUND');
   const [device]=await tx`select id from app.devices where tenant_id=${tenant}::uuid and id=${p.data.device_id}::uuid and user_id=${actor.userId}::uuid and active for share`;if(!device)throw new ApiFault('NOT_FOUND');
   const items=[];for(const item of p.data.items){
    const [row]=await tx`update app.local_journal_entries set native_capture_id=${item.native_capture_id}::uuid,updated_at=now() where tenant_id=${tenant}::uuid and device_id=${p.data.device_id}::uuid and actor_id=${actor.userId}::uuid and local_id=${item.id}::uuid and sha256=${item.sha256} returning id`;
    const [canonical]=row?await tx`select app.local_native_revision_for_read(${tenant}::uuid,${row.id}::uuid) id`:[];
    items.push({local_id:item.id,revision_id:canonical?.id??null,state:!row?'unshared':canonical?.id?'linked':'waiting'});
   }return {status:200,body:{items}};
  });
 }));
 app.post('/v1/local-journal/ai-consent',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),p=z.strictObject({allowed:z.boolean(),expected_version:z.number().int().nonnegative(),client_command_id:z.uuid(),processing_policy:CapturePolicySchema.optional()}).safeParse(req.body);
  if(!p.success)throw new ApiFault('INVALID_CONTRACT');const policy=services.capturePolicy;
  if(p.data.allowed&&(!policy||!policy.external_processing||policy.provider!=='anthropic'))throw new ApiFault('TEMPORARILY_UNAVAILABLE');
  if(p.data.allowed&&((p.data.processing_policy&&!capturePolicyEqual(p.data.processing_policy,policy))||
      (policy?.processors?.length&&!p.data.processing_policy)))throw new ApiFault('SOURCE_EXPIRED');
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   if(!['owner','operator'].includes(await membership(tx,tenant,actor.userId)))throw new ApiFault('NOT_FOUND');
   return once(tx,tenant,actor.userId,'local-context.consent',p.data.client_command_id,createHash('sha256').update(JSON.stringify(p.data)).digest('hex'),async()=>{
    const [row]=await tx`select app.set_local_context_consent(${tenant}::uuid,${p.data.expected_version}::bigint,${p.data.allowed},${tx.json(policy??{})}) value`;
    if(!row?.value)throw new ApiFault('NOT_FOUND');if(row.value.conflict)throw new ApiFault('VERSION_CONFLICT',Number(row.value.version));
    return {status:200,body:row.value};
   });
  });
 }));
 app.post('/v1/local-journal/push',{bodyLimit:400000},async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),p=push.safeParse(req.body);if(!p.success)throw new ApiFault('INVALID_CONTRACT');
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   if(!['owner','operator'].includes(await membership(tx,tenant,actor.userId)))throw new ApiFault('NOT_FOUND');
   const [device]=await tx`select id from app.devices where tenant_id=${tenant}::uuid and id=${p.data.device_id}::uuid and user_id=${actor.userId}::uuid and active for share`;if(!device)throw new ApiFault('NOT_FOUND');
   await tx`select pg_advisory_xact_lock(hashtextextended(${tenant+':local-journal'},0))`;
   const items=[];
   for(const e of p.data.items){
    let project=e.project_id??null;
    if(project){const [found]=await tx`select id from app.projects where tenant_id=${tenant}::uuid and id=${project}::uuid`;if(!found)throw new ApiFault('NOT_FOUND');}
    else if(e.project_name){let [found]=await tx`select id from app.projects where tenant_id=${tenant}::uuid and display_name=${e.project_name} order by id limit 1`;if(!found)[found]=await tx`insert into app.projects(tenant_id,display_name) values(${tenant}::uuid,${e.project_name}) returning id`;project=String(found?.id);}
    const [old]=await tx`select * from app.local_journal_entries where tenant_id=${tenant}::uuid and device_id=${p.data.device_id}::uuid and local_id=${e.id}::uuid for update`;
    if(old&&Number(old.local_revision)>e.revision)throw new ApiFault('VERSION_CONFLICT',Number(old.local_revision));
    if(old&&Number(old.local_revision)===e.revision&&old.sha256!==e.sha256)throw new ApiFault('VERSION_CONFLICT',Number(old.local_revision));
    let saved=old;
    if(!old){[saved]=await tx`insert into app.local_journal_entries(tenant_id,device_id,local_id,actor_id,local_revision,file_name,sha256,mime,received_at,project_id,categories,excerpt,source_kind) values(${tenant}::uuid,${p.data.device_id}::uuid,${e.id}::uuid,${actor.userId}::uuid,${e.revision},${e.file_name},${e.sha256},${e.mime},${e.received_at}::timestamptz,${project}::uuid,${e.categories}::text[],${e.excerpt},${e.source_kind}) returning *`;}
    else if(Number(old.local_revision)<e.revision||(!old.excerpt&&e.excerpt)){[saved]=await tx`update app.local_journal_entries set local_revision=${e.revision},file_name=${e.file_name},sha256=${e.sha256},mime=${e.mime},excerpt=${e.excerpt},
     project_id=case when project_origin='context' and ${e.revision}>local_revision then null else project_id end,
     project_origin=case when project_origin='context' and ${e.revision}>local_revision then 'client' else project_origin end,
     version=version+1,updated_at=now() where tenant_id=${tenant}::uuid and id=${old.id}::uuid returning *`;}
    if(e.native_capture_id)await tx`update app.local_journal_entries set native_capture_id=${e.native_capture_id}::uuid where tenant_id=${tenant}::uuid and id=${saved!.id}::uuid`;
    const [native]=await tx`select app.local_native_revision_for_read(${tenant}::uuid,${saved!.id}::uuid) id`;
    items.push({local_id:e.id,revision_id:native?.id??saved!.id,project_id:saved!.project_id,organization_version:Number(saved!.version)});
   }
   return {status:200,body:{items}};
  });
 }));
 app.get('/v1/local-journal/changes',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req);return inAuthorizedTransaction(services.db,actor,async tx=>{if(await membership(tx,tenant,actor.userId)==='viewer')throw new ApiFault('NOT_FOUND');const rows=await tx`select l.*,p.display_name project_name from app.local_journal_entries l left join app.projects p on p.tenant_id=l.tenant_id and p.id=l.project_id where l.tenant_id=${tenant}::uuid order by l.updated_at desc,l.id limit 1000`;return {status:200,body:{items:rows.map(localJournalRow),server_time:new Date().toISOString()}};});
 }));
 app.post('/v1/local-journal/assign',async(req,reply)=>execute(reply,async()=>{const actor=await principal(req,services),tenant=tenantHeader(req),p=z.strictObject({id:z.uuid(),expected_version:z.number().int().positive(),project_id:z.uuid().nullable(),categories}).safeParse(req.body);if(!p.success)throw new ApiFault('INVALID_CONTRACT');return inAuthorizedTransaction(services.db,actor,async tx=>{if(!['owner','operator'].includes(await membership(tx,tenant,actor.userId)))throw new ApiFault('NOT_FOUND');if(p.data.project_id){const [project]=await tx`select id from app.projects where tenant_id=${tenant}::uuid and id=${p.data.project_id}::uuid`;if(!project)throw new ApiFault('NOT_FOUND');}const [row]=await tx`update app.local_journal_entries set project_id=${p.data.project_id}::uuid,project_origin='manual',categories=${p.data.categories}::text[],version=version+1,updated_at=now() where tenant_id=${tenant}::uuid and id=${p.data.id}::uuid and version=${p.data.expected_version} returning *`;if(!row)throw new ApiFault('VERSION_CONFLICT');return {status:200,body:localJournalRow(row)};});}));
}
