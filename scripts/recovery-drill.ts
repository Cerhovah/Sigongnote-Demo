/** Local-only encrypted recovery rehearsal. Never overwrites the running database or objects. */
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import postgres from 'postgres';
import {createClient} from '@supabase/supabase-js';
import {verifyLocalDevelopmentDb} from './db-gate.mjs';
import {parseStrictLocalEnv} from './local-env-values.mjs';
import {CopyProtection,loadCopyProtection} from '../services/local-agent/src/protection.js';
import {foreignKeyGapDetails,originalLocationCounts} from './recovery-audit.js';
import {recoveryCommand} from './recovery-io.js';
import {isolatedDatabaseRestore} from './recovery-isolation.js';
import {recoveryAssets} from './recovery-assets.js';
export {recoveryCommand} from './recovery-io.js';
const hash=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
async function inventory(db:postgres.Sql|postgres.TransactionSql){
 const tables=await db`select schemaname,tablename from pg_tables where schemaname in ('app','auth','storage','supabase_migrations') order by schemaname,tablename`;
 const result:Record<string,{count:number;hash:string}>={};
 for(const row of tables){const h=createHash('sha256');let count=0;
  // Ordered row JSON also checks money, tombstones, receipts and all tenant data, not a sample.
  for await(const rows of db`select to_jsonb(t)::text value from ${db(row.schemaname+'.'+row.tablename)} t order by to_jsonb(t)::text collate "C"`.cursor(100)){for(const r of rows){h.update(r.value);h.update('\n');count++;}}
  result[row.schemaname+'.'+row.tablename]={count,hash:h.digest('hex')};
 }
 return result;
}
/** This is a synthetic hosted-VM boundary, never an alternative production key provider. */
export function syntheticRecoveryProtectionAllowed(sourceDatabase:string,env:Readonly<Record<string,string|undefined>>,platform:string){
 return /^sigongnote_drill_seed_[a-f0-9]{32}(?![\s\S])/.test(sourceDatabase)&&platform==='linux'&&env.GITHUB_ACTIONS==='true'&&
  env.RUNNER_ENVIRONMENT==='github-hosted'&&env.RUNNER_OS==='Linux'&&env.SIGONGNOTE_RECOVERY_TEST==='1'&&
  env.SIGONGNOTE_RECOVERY_DISPOSABLE_VM==='1'&&env.SIGONGNOTE_E2E_DB==='0';
}
export async function recoveryDrill(sourceDatabase='postgres',options:{syntheticProtection?:CopyProtection}={}){
 const injected=options.syntheticProtection;
 if(injected!==undefined&&(!(injected instanceof CopyProtection)||!syntheticRecoveryProtectionAllowed(sourceDatabase,process.env,process.platform)))throw Error('SYNTHETIC_RECOVERY_PROTECTION_FORBIDDEN');
 if(sourceDatabase!=='postgres'&&!/^sigongnote_drill_seed_[a-f0-9]{32}$/.test(sourceDatabase))throw Error('INVALID_RECOVERY_SOURCE');
 if((await verifyLocalDevelopmentDb()).status!=='READY')throw Error('LOCAL_DB_REQUIRED');
 const env=parseStrictLocalEnv(await readFile('services/api/.env','utf8'));
 const url=new URL(env.MIGRATION_DATABASE_URL!);if(url.hostname!=='127.0.0.1'||url.pathname!=='/postgres')throw Error('LOCAL_DB_REQUIRED');
 const config=await readFile('supabase/config.toml','utf8');const project=/^project_id\s*=\s*"([a-z0-9-]+)"/m.exec(config)?.[1];if(!project)throw Error('LOCAL_PROJECT_REQUIRED');
 const container='supabase_db_'+project;
 const id=randomUUID(),target='sigongnote_restore_'+id.replaceAll('-',''),folder=resolve('.work/recovery',id);
 const latestReport=resolve(sourceDatabase==='postgres'?'.work/recovery-latest.json':'.work/recovery-synthetic-latest.json');
 await mkdir(folder,{recursive:true});
 // Default remains same-account DPAPI. A qualified synthetic VM key does not prove new-host custody.
 let selectedProtection=injected;
 if(!selectedProtection){const keyFolder=resolve('.work/recovery-keys');await mkdir(keyFolder,{recursive:true});selectedProtection=await loadCopyProtection(resolve('.'),keyFolder);}
 const protection=selectedProtection;
 const sourceUrl=new URL(env.MIGRATION_DATABASE_URL!);sourceUrl.pathname='/'+sourceDatabase;
 const admin=postgres(sourceUrl.toString(),{max:2,onnotice:()=>{}}),storage=createClient(env.SUPABASE_URL!,env.SUPABASE_SECRET_KEY!,{auth:{persistSession:false,autoRefreshToken:false}}).storage;
 let created=false,restored:postgres.Sql|undefined;const started=Date.now();
 try {
  const snapshot=await admin.begin('isolation level repeatable read read only',async tx=>{
   const [snapshotRow]=await tx`select pg_export_snapshot() snapshot,now() at_time`;if(!snapshotRow)throw Error('RECOVERY_SNAPSHOT_FAILED');const snapshot=String(snapshotRow.snapshot);
   const migrations=(await tx`select version from supabase_migrations.schema_migrations order by version`).map(r=>String(r.version));
   const roles=(await tx`select rolname from pg_roles where rolname !~ '^pg_' order by rolname`).map(r=>String(r.rolname));
   const before=await inventory(tx),gapDetails=await foreignKeyGapDetails(tx),gaps=Object.fromEntries(Object.entries(gapDetails).map(([key,value])=>[key,value.rows]));const broken=Object.values(gaps).reduce((a,b)=>a+b,0);
   const objects=await tx`select bucket_id,name from storage.objects where bucket_id in ('sigongnote-originals','sigongnote-documents') order by bucket_id,name`;
   const locations=await originalLocationCounts(tx);
   const blobs=await tx`select storage_key,sha256,byte_length from app.evidence_blobs where storage_location='server'`;
   const dump=await recoveryCommand(['exec',container,'pg_dump','-U','postgres','-d',sourceDatabase,'-Fc','--snapshot='+snapshot]);
   await writeFile(resolve(folder,'database.sealed'),protection.encrypt(dump),{flag:'wx',mode:0o600});
   const entries:{bucket:string;name:string;file:string;sha256:string;bytes:number}[]=[];
   for(const [index,o] of objects.entries()){
    const {data,error}=await storage.from(o.bucket_id).download(o.name);if(error||!data)throw Error('RECOVERY_OBJECT_MISSING');
    if(data.size>209715200)throw Error('RECOVERY_OBJECT_TOO_LARGE');
    const bytes=Buffer.from(await data.arrayBuffer()),sha=hash(bytes);const expected=blobs.find(b=>b.storage_key===o.name);
    if(expected&&(expected.sha256!==sha||Number(expected.byte_length)!==bytes.length))throw Error('RECOVERY_OBJECT_CHANGED');
    const file=index+'.sealed';await writeFile(resolve(folder,file),protection.encrypt(bytes),{flag:'wx',mode:0o600});entries.push({bucket:o.bucket_id,name:o.name,file,sha256:sha,bytes:bytes.length});
   }
   // Fail closed if a referenced original is missing from the object inventory.
   const missingOriginals=blobs.filter(b=>!entries.some(e=>e.bucket==='sigongnote-originals'&&e.name===b.storage_key)).length;
   return {assets:recoveryAssets(migrations,roles),roles,before,entries,missingOriginals,broken,gaps,gapDetails,serverOriginalReferences:locations.server_original_references,deviceOriginalsNotChecked:locations.device_originals_not_checked,dumpHash:hash(dump),snapshot_at:new Date(snapshotRow.at_time).toISOString()};
  });
  await writeFile(resolve(folder,'manifest.sealed'),protection.encrypt(Buffer.from(JSON.stringify(snapshot))),{flag:'wx',mode:0o600});
  if(snapshot.broken>0||snapshot.missingOriginals>0){await writeFile(resolve(folder,'source-check.json'),JSON.stringify({foreign_key_gaps:snapshot.gaps,foreign_key_gap_details:snapshot.gapDetails,broken_reference_rows:snapshot.broken,missing_originals:snapshot.missingOriginals,server_original_references:snapshot.serverOriginalReferences,device_originals_not_checked:snapshot.deviceOriginalsNotChecked}));throw Error(snapshot.broken?'RECOVERY_SOURCE_REFERENCES_INVALID':'RECOVERY_ORIGINALS_MISSING');}
  const manifest=JSON.parse(protection.decrypt(await readFile(resolve(folder,'manifest.sealed'))).toString()) as typeof snapshot;
  const dump=protection.decrypt(await readFile(resolve(folder,'database.sealed')));if(hash(dump)!==manifest.dumpHash)throw Error('RECOVERY_DUMP_CHANGED');
  await admin.unsafe(`CREATE DATABASE ${target} TEMPLATE template0`);created=true;
  await recoveryCommand(['exec','-i',container,'pg_restore','-U','supabase_admin','-d',target,'--exit-on-error','--no-publications','--no-subscriptions'],dump);
  const restoredUrl=new URL(env.MIGRATION_DATABASE_URL!);restoredUrl.pathname='/'+target;restored=postgres(restoredUrl.toString(),{max:1});
  const after=await inventory(restored);if(JSON.stringify(after)!==JSON.stringify(manifest.before))throw Error('RECOVERY_ROWS_DIFFER');
  const restoredFolder=resolve(folder,'restored-objects');await mkdir(restoredFolder);
  for(const [i,e] of manifest.entries.entries()){const bytes=protection.decrypt(await readFile(resolve(folder,e.file)));if(hash(bytes)!==e.sha256||bytes.length!==e.bytes)throw Error('RECOVERY_OBJECT_CHANGED');const targetFile=resolve(restoredFolder,i+'.sealed');await writeFile(targetFile,protection.encrypt(bytes),{flag:'wx',mode:0o600});if(hash(protection.decrypt(await readFile(targetFile)))!==e.sha256)throw Error('RECOVERY_RESTORED_OBJECT_CHANGED');}
  // Check every tenant table readable by the API role, and report non-empty coverage separately.
  const readable=await restored`select distinct p.tablename from pg_tables p join information_schema.columns c on c.table_schema=p.schemaname and c.table_name=p.tablename where p.schemaname='app' and c.column_name='tenant_id' and has_table_privilege('sigongnote_api',quote_ident(p.schemaname)||'.'||quote_ident(p.tablename),'SELECT') order by p.tablename`;
  await restored.begin(async tx=>{await tx`set local role sigongnote_api`;await tx`select set_config('request.jwt.claim.sub',${randomUUID()},true)`;for(const row of readable){const [r]=await tx`select count(*)::int n from ${tx('app.'+row.tablename)}`;if(r?.n!==0)throw Error('RECOVERY_TENANT_LEAK');}});
  let positiveChecks=0;
  if(sourceDatabase!=='postgres'){
   const owners=await restored`select tenant_id,user_id from app.memberships where role='owner' and active and revoked_at is null`;
   if(owners.length<2)throw Error('RECOVERY_POSITIVE_FIXTURE_MISSING');
   for(const owner of owners){
    const expected=new Map<string,number>();for(const row of readable){const [r]=await restored`select count(*)::int n from ${restored('app.'+row.tablename)} where tenant_id=${owner.tenant_id}::uuid`;expected.set(row.tablename,Number(r?.n??0));}
    await restored.begin(async tx=>{await tx`set local role sigongnote_api`;await tx`select set_config('request.jwt.claim.sub',${owner.user_id},true)`;const [deleted]=await tx`select count(*)::int n from app.decision_examples where learning_state='deleted' and (proposal<>'{}'::jsonb or answer<>'{}'::jsonb or result<>'{}'::jsonb or learning_snapshot<>'{}'::jsonb or learning_history<>'[]'::jsonb or learning_reason is not null)`;if(deleted?.n!==0)throw Error('RECOVERY_DELETED_LEARNING_CONTENT');for(const row of readable){const [r]=await tx`select count(*)::int n,count(*) filter(where tenant_id<>${owner.tenant_id}::uuid)::int other from ${tx('app.'+row.tablename)}`;if(Number(r?.other)>0||Number(r?.n)>Number(expected.get(row.tablename)))throw Error('RECOVERY_OWNER_VISIBILITY_DIFFERS');if(['documents','cash_records'].includes(row.tablename)&&r?.n!==expected.get(row.tablename))throw Error('RECOVERY_OWNER_POSITIVE_MISSING');if(Number(r?.n)>0)positiveChecks++;}});
   }
  }
  const isolated=await isolatedDatabaseRestore(container,dump,manifest.roles,manifest.before,await readFile('supabase/tests/tenant_boundary.sql','utf8'));
  const report={schema:3,recovery_asset_contract:true,key_dependencies_verified:false,native_queue_manifest_included:false,full_product_restore_accepted:false,isolated,isolated_cluster_roles_verified:true,synthetic:sourceDatabase!=='postgres',status:'verified_server_scope',scope:'local_server_database_and_storage',verified_at:new Date().toISOString(),checked_at:new Date().toISOString(),snapshot_at:manifest.snapshot_at,tables:Object.keys(after).length,app_tables:Object.keys(after).filter(k=>k.startsWith('app.')).length,metadata_tables:Object.keys(after).filter(k=>!k.startsWith('app.')).length,rows:Object.values(after).reduce((n,r)=>n+r.count,0),objects:manifest.entries.length,missing_originals:0,all_rows_equal:true,all_available_object_hashes_equal:true,auth_storage_metadata_equal:true,tenant_isolation:true,rls_tables_checked:readable.length,rls_nonempty_tables:readable.filter(r=>(after['app.'+r.tablename]?.count??0)>0).length,synthetic_owner_positive_checks:positiveChecks,elapsed_seconds:Math.ceil((Date.now()-started)/1000),production_backup:false,native_keys_and_queues_verified:false,new_host_roles_verified:false,external_effects_replayed:false};
  const scopedReport={...report,device_originals_not_checked:manifest.deviceOriginalsNotChecked,key_protection_scope:injected?'synthetic_disposable_ram_only':'same_windows_account_dpapi'};
  await writeFile(resolve(folder,'report.json'),JSON.stringify(scopedReport,null,2),{flag:'wx'});await writeFile(latestReport,JSON.stringify(scopedReport,null,2));return scopedReport;
 }catch(error){
  const reason=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'RECOVERY_INCOMPLETE';
  const report={schema:1,status:'incomplete',synthetic:sourceDatabase!=='postgres',reason,verified_at:null,checked_at:new Date().toISOString(),production_backup:false};
  await writeFile(resolve(folder,'report.json'),JSON.stringify(report,null,2));await writeFile(latestReport,JSON.stringify(report,null,2));throw error;
 }finally {if(restored)await restored.end();if(created)await admin.unsafe(`DROP DATABASE ${target}`);await admin.end();}
}
if(process.argv[1]?.endsWith('recovery-drill.ts'))recoveryDrill().then(v=>console.log(JSON.stringify(v)),e=>{console.error('FAIL: '+(/^[A-Z_]+$/.test(e.message)?e.message:'RECOVERY_INCOMPLETE')+'; live data preserved; no success recorded.');process.exitCode=1;});
