/** Local development repair only: preserve derived orphan rows, reconstruct exact known fixture bytes. */
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import postgres from 'postgres';
import {createClient} from '@supabase/supabase-js';
import {verifyLocalDevelopmentDb} from './db-gate.mjs';
import {parseStrictLocalEnv} from './local-env-values.mjs';
import {foreignKeyGapDetails,originalLocationCounts} from './recovery-audit.js';
import {loadCopyProtection} from '../services/local-agent/src/protection.js';
import {syntheticAudio} from './work-preview-audio.js';
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
type Missing={tenant_id:string;storage_key:string;sha256:string;byte_length:string;display_name:string};
export function knownFixtureBytes(row:Pick<Missing,'display_name'|'sha256'|'byte_length'>){
 const catalog:[string,Buffer,string][]=[
  ['D07 synthetic',Buffer.from('합성 햇살현장 납품확인\n석고보드 12개\n지급 여부 미확인'),'text/plain'],
  ['D11 synthetic',syntheticAudio(),'audio/wav'],
  ['N03 synthetic',Buffer.from('석고보드 12개 요청, 인수 여부 미확인'),'text/plain'],
  ['N03 queue synthetic',Buffer.from('합성 석고보드 요청. 인수 미확인.'),'text/plain'],
 ];
 const item=catalog.find(([label,bytes])=>row.display_name===label&&hash(bytes)===row.sha256&&String(bytes.length)===String(row.byte_length));
 return item?{bytes:item[1],mime:item[2]}:null;
}
export async function inspectRepair(tx:postgres.TransactionSql){
 const gaps=await foreignKeyGapDetails(tx);
 if(Object.keys(gaps).some(k=>!['sync_changes.sync_changes_tenant_id_fkey','sync_heads.sync_heads_tenant_id_fkey'].includes(k)))throw Error('REPAIR_UNSUPPORTED_REFERENCE');
 const changes=await tx`select c.* from app.sync_changes c where not exists(select 1 from app.tenants t where t.id=c.tenant_id) order by c.tenant_id,c.position`;
 const heads=await tx`select h.* from app.sync_heads h where not exists(select 1 from app.tenants t where t.id=h.tenant_id) order by h.tenant_id`;
 const missing=await tx<Missing[]>`select b.tenant_id,b.storage_key,b.sha256,b.byte_length::text,t.display_name from app.evidence_blobs b join app.tenants t on t.id=b.tenant_id where b.storage_location='server' and not exists(select 1 from storage.objects o where o.bucket_id='sigongnote-originals' and o.name=b.storage_key) order by b.tenant_id,b.storage_key`;
 const unknown=missing.filter(r=>!knownFixtureBytes(r)).length;
 const content={changes:[...changes],heads:[...heads],missing:[...missing]};
 return {content,plan_hash:hash(JSON.stringify(content)),orphan_rows:changes.length+heads.length,missing_objects:missing.length,unsupported_objects:unknown};
}
export async function quarantineSyncOrphans(tx:postgres.TransactionSql,expected:string,preserve:(bytes:Buffer)=>Promise<void>){
 // Lock the parent and derived tables together; new tenant/queue changes cannot race the preimage.
 await tx`lock table app.tenants,app.sync_heads,app.sync_changes in share row exclusive mode`;
 const plan=await inspectRepair(tx);if(plan.plan_hash!==expected)throw Error('REPAIR_PLAN_CHANGED');
 if(plan.orphan_rows>10000)throw Error('REPAIR_ROW_LIMIT');
 // The caller must seal, persist and decrypt-verify this exact preimage before deletion.
 await preserve(Buffer.from(JSON.stringify(plan.content)));
 const changes=await tx`delete from app.sync_changes c where not exists(select 1 from app.tenants t where t.id=c.tenant_id) returning c.tenant_id`;
 const heads=await tx`delete from app.sync_heads h where not exists(select 1 from app.tenants t where t.id=h.tenant_id) returning h.tenant_id`;
 if(changes.length+heads.length!==plan.orphan_rows||Object.keys(await foreignKeyGapDetails(tx)).length)throw Error('REPAIR_REFERENCE_MISMATCH');
 return changes.length+heads.length;
}
export async function restoreFixtureObject(row:Missing,storage:ReturnType<ReturnType<typeof createClient>['storage']['from']>){
 if(!row.storage_key.startsWith(row.tenant_id+'/'))throw Error('REPAIR_OBJECT_SCOPE');
 const item=knownFixtureBytes(row);if(!item)throw Error('REPAIR_UNKNOWN_ORIGINAL');
 const uploaded=await storage.upload(row.storage_key,item.bytes,{contentType:item.mime,upsert:false});if(uploaded.error)throw Error('REPAIR_UPLOAD_FAILED');
 const downloaded=await storage.download(row.storage_key);if(downloaded.error||!downloaded.data||hash(Buffer.from(await downloaded.data.arrayBuffer()))!==row.sha256)throw Error('REPAIR_OBJECT_VERIFY');
}
export async function repairLocalRecovery(expected?:string){
 if((await verifyLocalDevelopmentDb()).status!=='READY')throw Error('LOCAL_DB_REQUIRED');
 const env=parseStrictLocalEnv(await readFile('services/api/.env','utf8'));
 const url=new URL(env.MIGRATION_DATABASE_URL!),origin=new URL(env.SUPABASE_URL!);
 if(url.hostname!=='127.0.0.1'||url.pathname!=='/postgres'||origin.hostname!=='127.0.0.1')throw Error('LOCAL_DB_REQUIRED');
 const db=postgres(url.href,{max:1,onnotice:()=>{}});
 try{
  const before=await db.begin('isolation level repeatable read read only',inspectRepair);
  const summary={plan_hash:before.plan_hash,orphan_rows:before.orphan_rows,missing_objects:before.missing_objects,unsupported_objects:before.unsupported_objects};
  if(!expected)return {...summary,applied:false};
  if(!/^[a-f0-9]{64}$/.test(expected)||expected!==before.plan_hash)throw Error('REPAIR_PLAN_CHANGED');
  if(before.unsupported_objects)throw Error('REPAIR_UNKNOWN_ORIGINAL');
  const folder=resolve('.work/recovery-repair',randomUUID()),keys=resolve('.work/recovery-keys');await mkdir(folder,{recursive:true});await mkdir(keys,{recursive:true});
  const protection=await loadCopyProtection(resolve('.'),keys);
  const preserve=async(name:string,bytes:Buffer)=>{const target=resolve(folder,name);await writeFile(target,protection.encrypt(bytes),{flag:'wx',mode:0o600});if(!protection.decrypt(await readFile(target)).equals(bytes))throw Error('REPAIR_BACKUP_INVALID');};
  await preserve('plan.sealed',Buffer.from(JSON.stringify(before.content)));
  // Missing objects are reconstructed only from a committed synthetic generator with exact hash/length.
  // upsert:false never replaces an existing object, including a concurrent recovery.
  const storage=createClient(env.SUPABASE_URL!,env.SUPABASE_SECRET_KEY!,{auth:{persistSession:false,autoRefreshToken:false}}).storage.from('sigongnote-originals');
  let restored=0,step='restore_fixture_objects';
  try{
  for(const row of before.content.missing){
   await restoreFixtureObject(row,storage);restored++;
  }
  // Recompute only the expected object disappearance; orphan preimages must remain byte-for-byte identical.
  const expectedAfterObjects=hash(JSON.stringify({...before.content,missing:[]}));
  step='quarantine_sync_orphans';
  const quarantined=await db.begin(async tx=>quarantineSyncOrphans(tx,expectedAfterObjects,bytes=>preserve('sync-orphans.sealed',bytes)));
  step='final_audit';
  const locations=await originalLocationCounts(db);
  const report={...summary,applied:true,restored_fixture_objects:restored,quarantined_derived_rows:quarantined,...locations,originals_deleted:0,originals_overwritten:0,backup_verified:true,full_restore_verified:false};
  await writeFile(resolve(folder,'receipt.json'),JSON.stringify(report,null,2),{flag:'wx'});return report;
  }catch(error){
   const reason=error instanceof Error&&/^REPAIR_[A-Z_]+$/.test(error.message)?error.message:'REPAIR_INCOMPLETE';
   await writeFile(resolve(folder,'failure-receipt.json'),JSON.stringify({plan_hash:before.plan_hash,step,verified_restored_objects:restored,reason,audit_before_retry:true}),{flag:'wx',mode:0o600});throw error;
  }
 }finally{await db.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const args=process.argv.slice(2);if(args.length&&!(args.length===2&&args[0]==='--apply'&&/^[a-f0-9]{64}$/.test(args[1]!)))throw Error('REPAIR_ARGUMENTS');
 repairLocalRecovery(args[1]).then(r=>console.log(JSON.stringify(r)),()=>{console.error('RECOVERY_REPAIR_INCOMPLETE; preserved preimages remain private; run audit before retry');process.exitCode=1;});
}
