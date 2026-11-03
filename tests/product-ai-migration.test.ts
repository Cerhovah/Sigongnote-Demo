import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import postgres from 'postgres';
import {parseStrictLocalEnv} from '../scripts/local-env-values.mjs';
import {verifyLocalDevelopmentDb} from '../scripts/db-gate.mjs';
import {recoveryCommand} from '../scripts/recovery-drill.js';
import {LOCAL_CAPTURE_POLICY} from '../services/api/src/capture-scope.js';

test('agent continuation and product AI fresh migration rollback/replay and restored budget fence',async()=>{
 assert.equal((await verifyLocalDevelopmentDb()).status,'READY');
 const env=parseStrictLocalEnv(await readFile('services/api/.env','utf8'));
 const admin=postgres(env.MIGRATION_DATABASE_URL!,{max:1,onnotice:()=>{}});
 const project=/^project_id\s*=\s*"([a-z0-9-]+)"/m.exec(await readFile('supabase/config.toml','utf8'))?.[1];assert.ok(project);
 const container='supabase_db_'+project,name='sigongnote_drill_seed_'+randomUUID().replaceAll('-',''),restore='sigongnote_drill_seed_'+randomUUID().replaceAll('-','');
 const connect=(database:string)=>{const url=new URL(env.MIGRATION_DATABASE_URL!);url.pathname='/'+database;return postgres(url.toString(),{max:1,onnotice:()=>{}});};
 let fresh:postgres.Sql|undefined,restored:postgres.Sql|undefined,created=false,restoredCreated=false;
 try{
 const base=await recoveryCommand(['exec',container,'pg_dump','-U','postgres','-d','postgres','--schema-only','--exclude-schema=app','--no-publications','--no-subscriptions']);
 const foundation=base.toString('utf8').replace(/^CREATE POLICY [\s\S]*?;\r?\n/gm,s=>s.includes('app.')?'':s);
 await admin.unsafe('CREATE DATABASE '+name+' TEMPLATE template0');created=true;
 await recoveryCommand(['exec','-i',container,'psql','-X','-q','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d',name],Buffer.from(foundation));fresh=connect(name);
 // The tenant oracle pins the current private-function contract. Rehearse the
 // complete migration chain before checking it, rather than a frozen old prefix.
 const names=(await readdir('supabase/migrations')).filter(n=>n.endsWith('.sql')).sort();
 for(const file of names){const sql=await readFile('supabase/migrations/'+file,'utf8');
  if(/_n(?:0[23456789]|1[012345689]|2[023478]|31[ghi])_|_sms_ai_screening|_current_work_processing|_journal_followups|_first_site_setup|_semantic_table_windows|_capture_pdf_recovery_finish|_local_shared_journal|_work_events_context|_context_source_integrity|_context_correction_learning/.test(file)){const rollback=Error('intentional rollback');await assert.rejects(fresh.begin(async tx=>{await tx.unsafe(sql);throw rollback;}),e=>e===rollback);}
  await fresh.begin(async tx=>{await tx.unsafe(sql);});
 }
 await fresh.unsafe(await readFile('supabase/tests/tenant_boundary.sql','utf8'));
 const cleanup=await readFile('supabase/migrations/20261004034625_residual_audit_consistency.sql','utf8');
 await fresh.unsafe('alter table app.deliveries add constraint deliveries_tenant_id_current_attempt_fkey foreign key(tenant_id,current_attempt) references app.delivery_attempts(tenant_id,id); alter table app.outbox add constraint outbox_tenant_id_delivery_attempt_id_fkey foreign key(tenant_id,delivery_attempt_id) references app.delivery_attempts(tenant_id,id)');
 await fresh.begin(async tx=>{await tx.unsafe(cleanup);});await fresh.begin(async tx=>{await tx.unsafe(cleanup);});
 assert.equal((await fresh`select count(*)::int n from pg_constraint where conname in ('deliveries_tenant_id_current_attempt_fkey','outbox_tenant_id_delivery_attempt_id_fkey')`)[0]?.n,0);
 assert.equal((await fresh`select count(*)::int n from pg_constraint where conname in ('deliveries_tenant_id_id_current_attempt_fkey','outbox_tenant_id_delivery_id_delivery_attempt_id_fkey') and convalidated`)[0]?.n,2);
 const rollbackCleanup=Error('missing guard rollback');
 await assert.rejects(fresh.begin(async tx=>{await tx`alter table app.deliveries drop constraint deliveries_tenant_id_id_current_attempt_fkey`;await assert.rejects(tx.savepoint(async point=>{await point.unsafe(cleanup);}),/DELIVERY_SCOPE_CONSTRAINT_REQUIRED/);throw rollbackCleanup;}),e=>e===rollbackCleanup);
 await assert.rejects(fresh.begin(async tx=>{await tx`alter table app.outbox drop constraint outbox_business_scope`;await assert.rejects(tx.savepoint(async point=>{await point.unsafe(cleanup);}),/DELIVERY_SCOPE_CONSTRAINT_REQUIRED/);throw rollbackCleanup;}),e=>e===rollbackCleanup);
 assert.equal((await fresh`select has_function_privilege('sigongnote_worker','app.pdf_parse_progress(uuid,uuid,uuid,jsonb)','EXECUTE') ok`)[0]?.ok,true);
 assert.equal((await fresh`select has_function_privilege('sigongnote_api','app.pdf_parse_progress(uuid,uuid,uuid,jsonb)','EXECUTE') ok`)[0]?.ok,false);
 assert.equal((await fresh`select has_function_privilege('anon','app.read_pdf_parse_progress(uuid,uuid)','EXECUTE') ok`)[0]?.ok,false);
 const tenant=randomUUID(),user=randomUUID(),id=randomUUID();
 await fresh.unsafe("insert into auth.users(id) values($1);",[user]);
 await fresh.unsafe("insert into app.tenants(id,display_name) values($1,'N03 restore fixture');",[tenant]);
 await fresh.unsafe("insert into app.memberships(tenant_id,user_id,role) values($1,$2,'owner');",[tenant,user]);
 await fresh.unsafe("insert into app.voice_consents(tenant_id,user_id,provider_version,allowed) values($1,$2,'short-voice-v1',true);",[tenant,user]);
 const [consent]=await fresh.unsafe("select (extract(epoch from updated_at)*1000000)::bigint::text generation from app.voice_consents where tenant_id=$1",[tenant]);
 const config={consent_generation:consent!.generation} as never,digest='a'.repeat(64);
 const reserve=()=>fresh!.unsafe("select app.reserve_product_ai($1,$2,$3,'short_stt',null,null,null,$4,$5::jsonb,100) v",[tenant,user,id,digest,config]);
 assert.equal((await reserve())[0]?.v.state,'reserved');
 await fresh.unsafe('select app.submit_product_ai($1,$2,$3)',[tenant,user,id]);
 await fresh.unsafe("select app.finish_product_ai($1,$2,$3,null,null,null,'{}'::jsonb)",[tenant,user,id]);
 const snapshot=async(db:postgres.Sql)=>{const rows=await db.unsafe('select to_jsonb(t)::text value from app.product_ai_usage t order by to_jsonb(t)::text');return createHash('sha256').update(JSON.stringify(rows)).digest('hex');};
 const before=await snapshot(fresh),dump=await recoveryCommand(['exec',container,'pg_dump','-U','postgres','-d',name,'-Fc']);
 await admin.unsafe('CREATE DATABASE '+restore+' TEMPLATE template0');restoredCreated=true;
 await recoveryCommand(['exec','-i',container,'pg_restore','-U','supabase_admin','-d',restore,'--exit-on-error','--no-publications','--no-subscriptions'],dump);restored=connect(restore);
 assert.equal(await snapshot(restored),before);
 assert.equal((await restored.unsafe('select app.submit_product_ai($1,$2,$3) ok',[tenant,user,id]))[0]?.ok,false,'restore cannot repeat an unknown paid request');
 await restored.begin(async tx=>{await tx.unsafe('set local role sigongnote_api');await tx.unsafe("select set_config('request.jwt.claim.sub',$1,true)",[randomUUID()]);assert.equal((await tx.unsafe('select count(*)::int n from app.product_ai_usage'))[0]?.n,0);});
 await restored.begin(async tx=>{await tx.unsafe('set local role sigongnote_api');await tx.unsafe("select set_config('request.jwt.claim.sub',$1,true)",[user]);assert.equal((await tx.unsafe('select state from app.product_ai_usage'))[0]?.state,'unknown');});
 }finally{if(restored)await restored.end();if(fresh)await fresh.end();if(restoredCreated)await admin.unsafe('DROP DATABASE '+restore);if(created)await admin.unsafe('DROP DATABASE '+name);await admin.end();}
});
