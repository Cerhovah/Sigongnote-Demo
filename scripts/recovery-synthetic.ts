import postgres from 'postgres';import {readFile} from 'node:fs/promises';import {randomUUID,createHash,randomBytes} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';import {parseStrictLocalEnv} from './local-env-values.mjs';import {verifyLocalDevelopmentDb} from './db-gate.mjs';import {recoveryCommand,recoveryDrill,syntheticRecoveryProtectionAllowed} from './recovery-drill.js';
import {CopyProtection} from '../services/local-agent/src/protection.js';
import {attachRecoveryDiagnostic,recoveryDiagnosticLine} from './recovery-diagnostics.mjs';
export async function syntheticRecovery(options:{missingOriginal?:boolean;deviceOriginal?:boolean}={}){
 let stage='LOCAL_GATE',failedStage:string|undefined;
 try{
 if((await verifyLocalDevelopmentDb()).status!=='READY')throw Error('LOCAL_REQUIRED');
 stage='READ_LOCAL_CONFIG';
 const e=parseStrictLocalEnv(await readFile('services/api/.env','utf8')),admin=postgres(e.MIGRATION_DATABASE_URL!,{max:1});
 const project=/^project_id\s*=\s*"([a-z0-9-]+)"/m.exec(await readFile('supabase/config.toml','utf8'))?.[1];if(!project)throw Error('LOCAL_REQUIRED');
 const name='sigongnote_drill_seed_'+randomUUID().replaceAll('-',''),container='supabase_db_'+project;
 const url=new URL(e.MIGRATION_DATABASE_URL!);url.pathname='/'+name;
 const storage=createClient(e.SUPABASE_URL!,e.SUPABASE_SECRET_KEY!,{auth:{persistSession:false,autoRefreshToken:false}}).storage.from('sigongnote-originals');
 let seeded:postgres.Sql|undefined,created=false;const tenant=randomUUID(),user=randomUUID(),otherTenant=randomUUID(),otherUser=randomUUID(),key=tenant+'/'+randomUUID(),bytes=Buffer.from('D19 합성 복원 자료 300000원');
 try{
  stage='SCHEMA_DUMP';
  const schema=await recoveryCommand(['exec',container,'pg_dump','-U','postgres','-d','postgres','-Fc','--schema-only']);
  stage='CREATE_DATABASE';
  await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE template0`);created=true;
  stage='RESTORE_SCHEMA';
  await recoveryCommand(['exec','-i',container,'pg_restore','-U','supabase_admin','-d',name,'--exit-on-error','--no-publications','--no-subscriptions'],schema);
  seeded=postgres(url.toString(),{max:1});
  stage='SEED_MIGRATIONS';
  const migrations=await admin`select * from supabase_migrations.schema_migrations order by version`;for(const row of migrations)await seeded`insert into supabase_migrations.schema_migrations ${seeded(row)}`;
  stage='SEED_IDENTITY';
  await seeded`insert into auth.users(id) values(${user}::uuid),(${otherUser}::uuid)`;
  await seeded`insert into auth.sessions(id,user_id) values(${randomUUID()}::uuid,${user}::uuid)`;
  await seeded`insert into app.tenants(id,display_name) values(${tenant}::uuid,'합성 복원'),(${otherTenant}::uuid,'다른 회사')`;
  await seeded`insert into app.memberships(tenant_id,user_id,role) values(${tenant}::uuid,${user}::uuid,'owner'),(${otherTenant}::uuid,${otherUser}::uuid,'owner')`;
  stage='SEED_CORE';
  await seeded`insert into app.documents(tenant_id) values(${tenant}::uuid),(${otherTenant}::uuid)`;
  await seeded`insert into app.cash_records(tenant_id,account_token,direction,amount_minor,occurred_at) values(${tenant}::uuid,'synthetic-account','incoming',300000,now())`;
  await seeded`insert into app.command_receipts(tenant_id,actor_id,route,idempotency_key,request_hash,status_code,response) values(${tenant}::uuid,${user}::uuid,'D19 fixture',${randomUUID()}::uuid,${'0'.repeat(64)},200,'{"restored":true}')`;
  await seeded`insert into app.sync_heads(tenant_id,position) values(${tenant}::uuid,1)`;
  await seeded`insert into app.sync_changes(tenant_id,position,kind,target_id,removed) values(${tenant}::uuid,1,'material',${randomUUID()}::uuid,true)`;
  stage='SEED_STORAGE';
  const result=await storage.upload(key,bytes,{contentType:'text/plain'});if(result.error)throw Error('SYNTHETIC_STORAGE_FAILED');
  const [bucket]=await admin`select * from storage.buckets where id='sigongnote-originals'`;await seeded`insert into storage.buckets ${seeded(bucket!)}`;
  const [object]=await admin`select id,bucket_id,name,owner,created_at,updated_at,last_accessed_at,metadata,version,owner_id,user_metadata from storage.objects where bucket_id='sigongnote-originals' and name=${key}`;if(!options.missingOriginal)await seeded`insert into storage.objects ${seeded(object!)}`;
  await seeded`insert into app.evidence_blobs(tenant_id,sha256,byte_length,sniffed_mime,storage_key) values(${tenant}::uuid,${createHash('sha256').update(bytes).digest('hex')},${bytes.length},'text/plain',${key})`;
  if(options.deviceOriginal)await seeded`insert into app.evidence_blobs(tenant_id,sha256,byte_length,sniffed_mime,storage_key,storage_location) values(${tenant}::uuid,${'d'.repeat(64)},10,'text/plain',${tenant+'/device-only'},'device')`;
  // N27: the all-column inventory must restore purpose consent and protected cases too.
  stage='SEED_LEARNING';
  const [doc]=await seeded`select id from app.documents where tenant_id=${tenant}::uuid limit 1`,[blob]=await seeded`select id from app.evidence_blobs where tenant_id=${tenant}::uuid and storage_location='server' limit 1`;
  const revision=randomUUID(),decision=randomUUID(),evidence=randomUUID();
  await seeded`insert into app.document_revisions(tenant_id,id,document_id,revision_number,blob_id,declared_mime) values(${tenant}::uuid,${revision}::uuid,${doc!.id}::uuid,1,${blob!.id}::uuid,'text/plain')`;
  await seeded`insert into app.evidence_index(tenant_id,id,revision_id,scope,category,display_title,locator,source_kind) values(${tenant}::uuid,${evidence}::uuid,${revision}::uuid,'company_common','inspection_defect','synthetic learning source','{"kind":"text","position":{"span":0}}','original')`;
  await seeded`insert into app.activity_consents(tenant_id,user_id,allowed,learning_allowed) values(${tenant}::uuid,${user}::uuid,false,true)`;
  await seeded`insert into app.decisions(tenant_id,id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash) values(${tenant}::uuid,${decision}::uuid,${user}::uuid,'exception_resolution','apply_work_answer',${[randomUUID()]}::uuid[],array[1]::bigint[],${[evidence]}::uuid[],'synthetic learning restore',${'c'.repeat(64)})`;
  await seeded`insert into app.decision_examples(tenant_id,decision_id,scope_type,proposal,answer,result,learning_actor_id,learning_consent_id,learning_state,learning_reason,learning_version,learning_snapshot,learning_history) select tenant_id,${decision}::uuid,'once','{"synthetic":true}','{"synthetic":true}','{"synthetic":true}',user_id,learning_consent_id,'confirmed','synthetic owner verified',2,${seeded.json({source_refs:[{revision,span:0}],rule_version:'work-command-v1',period:'synthetic',transaction_group:decision})},'[{"state":"unreviewed","version":1}]' from app.activity_consents where tenant_id=${tenant}::uuid and user_id=${user}::uuid`;
  // N28: dataset, immutable criteria/rules, version pointer and unknown local attempt survive restore.
  stage='SEED_IMPROVEMENT';
  const [example]=await seeded`select id from app.decision_examples where tenant_id=${tenant}::uuid and decision_id=${decision}::uuid`;
  const second=randomUUID(),secondDecision=randomUUID(),dataset=randomUUID(),version=randomUUID();
  await seeded`insert into app.decisions(tenant_id,id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash) select tenant_id,${secondDecision}::uuid,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash from app.decisions where tenant_id=${tenant}::uuid and id=${decision}::uuid`;
  await seeded`insert into app.decision_examples(tenant_id,id,decision_id,scope_type,proposal,answer,result,learning_actor_id,learning_consent_id,learning_state,learning_version,learning_snapshot) select tenant_id,${second}::uuid,${secondDecision}::uuid,'once',proposal,answer,result,learning_actor_id,learning_consent_id,'confirmed',2,learning_snapshot from app.decision_examples where tenant_id=${tenant}::uuid and id=${example!.id}::uuid`;
  const members=[{id:example!.id,version:2,group:decision,split:'train'},{id:second,version:2,group:decision,split:'train'}];
  await seeded`insert into app.improvement_datasets(tenant_id,id,owner_id,members,criteria,fingerprint) values(${tenant}::uuid,${dataset}::uuid,${user}::uuid,${seeded.json(members)},'{"version":"work-eval-v1","min_test_groups":1,"min_shadow_groups":1,"max_errors":0,"max_protected_changes":0,"max_high_confidence_errors":0,"min_improvement":1}',${'d'.repeat(64)})`;
  await seeded`insert into app.improvement_versions(tenant_id,id,dataset_id,spec,state,fingerprint) values(${tenant}::uuid,${version}::uuid,${dataset}::uuid,'{"scope":"quality_interpretation","prompt_version":"evidence-quality-v1","rules":[]}','rejected',${'e'.repeat(64)})`;
  await seeded`insert into app.improvement_heads(tenant_id,owner_id,previous_id,budget_hold_day) values(${tenant}::uuid,${user}::uuid,${version}::uuid,(now() at time zone 'Asia/Seoul')::date::text)`;
  await seeded`insert into app.improvement_experiments(tenant_id,version_id,case_id,case_version,phase,adapter,state) values(${tenant}::uuid,${version}::uuid,${example!.id}::uuid,2,'local_shadow','synthetic-local','unknown')`;
  // N29: deletion state and unknown outbound attempts remain exactly as recorded.
  stage='SEED_DELIVERY';
  const erasedDecision=randomUUID(),projectId=randomUUID(),delivery=randomUUID(),attempt=randomUUID();
  await seeded`insert into app.decisions(tenant_id,id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash) select tenant_id,${erasedDecision}::uuid,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash from app.decisions where tenant_id=${tenant}::uuid and id=${decision}::uuid`;
  await seeded`insert into app.decision_examples(tenant_id,decision_id,scope_type,proposal,answer,result,learning_actor_id,learning_consent_id,learning_state,learning_version,learning_snapshot) select tenant_id,${erasedDecision}::uuid,'once','{}','{}','{}',learning_actor_id,learning_consent_id,'deleted',2,'{}' from app.decision_examples where tenant_id=${tenant}::uuid and id=${example!.id}::uuid`;
  await seeded`insert into app.activity_consents(tenant_id,user_id,allowed,learning_allowed) values(${otherTenant}::uuid,${otherUser}::uuid,false,false)`;
  await seeded`insert into app.projects(tenant_id,id,display_name) values(${tenant}::uuid,${projectId}::uuid,'합성 복원 현장')`;
  await seeded`insert into app.deliveries(tenant_id,id,actor_id,project_id,source_kind,source_id,revision_id,document_hash,title,pages,recipient_name,recipient_number,scope_hash,state) values(${tenant}::uuid,${delivery}::uuid,${user}::uuid,${projectId}::uuid,'document',${doc!.id}::uuid,${revision}::uuid,${'1'.repeat(64)},'합성 복원 전달',1,'합성 수신처','0200000000',${'2'.repeat(64)},'unknown')`;
  await seeded`insert into app.delivery_attempts(tenant_id,delivery_id,id,actor_id,state,approved_hash,expires_at,provider_account_hash,price,reserved_krw,submitted_at) values(${tenant}::uuid,${delivery}::uuid,${attempt}::uuid,${user}::uuid,'unknown',${'2'.repeat(64)},now()+interval '1 hour',${'3'.repeat(64)},'{"synthetic":true}',100,now())`;
  await seeded`update app.deliveries set current_attempt=${attempt}::uuid where tenant_id=${tenant}::uuid and id=${delivery}::uuid`;
  await seeded`insert into app.outbox(tenant_id,topic,delivery_id,delivery_attempt_id,operation_key) values(${tenant}::uuid,'delivery_ready',${delivery}::uuid,${attempt}::uuid,${'synthetic-delivery:'+attempt})`;
  // N31g/h: parked continuation, pinned read strategy, labels and comparison counters restore exactly.
  stage='SEED_STRATEGY';
  const run=randomUUID(),child=randomUUID(),context=randomUUID(),strategy=randomUUID(),cases=[randomUUID(),randomUUID()];
  const [session]=await seeded`select id from auth.sessions where user_id=${user}::uuid limit 1`;
  await seeded`insert into app.work_contexts(tenant_id,id,project_id,label) values(${tenant}::uuid,${context}::uuid,${projectId}::uuid,'합성 복원 업무')`;
  for(const [i,id] of [run,child].entries())await seeded`insert into app.agent_runs(tenant_id,id,user_id,session_id,client_turn_id,project_id,instruction,input_kind,request_hash,status,error_code,parent_run_id,root_run_id,chain_depth,strategy_versions) values(${tenant}::uuid,${id}::uuid,${user}::uuid,${session!.id}::uuid,${randomUUID()}::uuid,${projectId}::uuid,'합성 복원 조회','text',${'4'.repeat(64)},'needs_answer',${i?'awaiting_continuation':'loop_limit'},${i?run:null}::uuid,${i?run:null}::uuid,${i},${seeded.json({search:strategy})})`;
  for(const id of cases)await seeded`insert into app.strategy_cases(tenant_id,id,owner_id,consent_id,scope,run_id,sequence,context_id,project_id,instruction,input,baseline,expected,relevant,source_refs) select tenant_id,${id}::uuid,user_id,learning_consent_id,'search',${run}::uuid,1,${context}::uuid,${projectId}::uuid,'합성 복원 조회','{"query":"별칭"}','{"tool":"search_evidence","query":"별칭"}','{"tool":"search_evidence","query":"문틀"}',${[revision]}::uuid[],${seeded.json([{revision,sha256:createHash('sha256').update(bytes).digest('hex')}])} from app.activity_consents where tenant_id=${tenant}::uuid and user_id=${user}::uuid`;
  await seeded`insert into app.strategy_versions(tenant_id,id,scope,members,spec,fingerprint,state) values(${tenant}::uuid,${strategy}::uuid,'search',${seeded.json(cases.map(id=>({id,split:'train',group:context})))},'{"scope":"search","version":"search-query-v1","rules":[{"from":"별칭","to":"문틀"}]}',${'5'.repeat(64)},'rejected')`;
  await seeded`insert into app.strategy_heads(tenant_id,scope,owner_id,previous_id) values(${tenant}::uuid,'search',${user}::uuid,${strategy}::uuid)`;
  await seeded`insert into app.strategy_evaluations(tenant_id,version_id,case_id,phase,prediction,passed,attempts) values(${tenant}::uuid,${strategy}::uuid,${cases[0]!}::uuid,'test','{"synthetic":true}',false,3)`;
  stage='RECOVERY_DRILL';
  const syntheticProtection=syntheticRecoveryProtectionAllowed(name,process.env,process.platform)?new CopyProtection(randomBytes(32)):undefined;
  const report=await recoveryDrill(name,syntheticProtection?{syntheticProtection}:{});return {...report,synthetic:true,learning_cases_seeded:3,improvement_tables_seeded:4,strategy_tables_seeded:4,parked_continuations_seeded:1,unknown_delivery_attempts_seeded:1};
 }catch(error){failedStage=stage;throw error;}
 finally{try{stage='CLEANUP_STORAGE';await storage.remove([key]);stage='CLEANUP_CONNECTION';if(seeded)await seeded.end();stage='CLEANUP_DATABASE';if(created)await admin.unsafe(`DROP DATABASE ${name}`);stage='CLEANUP_ADMIN';await admin.end();}catch(error){failedStage=stage;throw error;}}
 }catch(error){const diagnostic=attachRecoveryDiagnostic(error,failedStage??stage);if(process.env.SIGONGNOTE_RECOVERY_DIAGNOSTICS==='1')try{process.stderr.write(recoveryDiagnosticLine(diagnostic)+'\n');}catch{/* Diagnostic output must not replace the original rejection. */}throw error;}
}
if(process.argv[1]?.endsWith('recovery-synthetic.ts'))syntheticRecovery().then(v=>console.log(JSON.stringify(v)),()=>{console.error('FAIL: synthetic recovery incomplete; live database unchanged');process.exitCode=1;});
