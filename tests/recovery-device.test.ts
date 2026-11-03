import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {CopyProtection} from '../services/local-agent/src/protection.js';
import {archiveNativeSnapshot,verifyNativeSnapshot,restoreNativeSnapshot} from '../scripts/recovery-device.js';
import {recoveryAssets} from '../scripts/recovery-assets.js';
import {recoveryDrill,syntheticRecoveryProtectionAllowed} from '../scripts/recovery-drill.js';
import {attachRecoveryDiagnostic,collectRecoveryDiagnostics,recoveryDiagnosticLine,recoveryDiagnosticPrefix,classifyRecoveryToolError,readCurrentRecoveryToolDiagnostic} from '../scripts/recovery-diagnostics.mjs';

test('D19 failure diagnostics retain stage and allowlisted SQLSTATE without changing the rejection or publishing its content',()=>{
 const privateValue='synthetic-private-query-path-token';
 const sql=Object.assign(new Error('select '+privateValue),{code:'23503',detail:privateValue});
 const diagnostic=attachRecoveryDiagnostic(sql,'SEED_CORE');
 assert.deepEqual(diagnostic,{stage:'SEED_CORE',code:'POSTGRES_ERROR',sqlstate:'23503'});assert.equal(sql.message,'select '+privateValue);assert.equal(sql.code,'23503');assert.equal(Object.keys(sql).includes('recovery_diagnostic'),false);
 const tool=new Error('RECOVERY_TOOL_FAILED'),toolDiagnostic=attachRecoveryDiagnostic(tool,'RESTORE_SCHEMA');assert.equal(tool.message,'RECOVERY_TOOL_FAILED');
 const missing=new Error('RECOVERY_ORIGINALS_MISSING');attachRecoveryDiagnostic(missing,'RECOVERY_DRILL');assert.throws(()=>{throw missing;},error=>error instanceof Error&&error===missing&&/RECOVERY_ORIGINALS_MISSING/.test(error.message));
 const frozen=Object.freeze(new Error('POSTGRES_ERROR'));assert.deepEqual(attachRecoveryDiagnostic(frozen,'SCHEMA_DUMP'),{stage:'SCHEMA_DUMP',code:'RECOVERY_ERROR',sqlstate:null});
 const unknown=attachRecoveryDiagnostic({code:privateValue,message:privateValue},privateValue);assert.deepEqual(unknown,{stage:'UNKNOWN_STAGE',code:'RECOVERY_ERROR',sqlstate:null});
 const stdout='# '+recoveryDiagnosticLine(diagnostic)+'\n# '+recoveryDiagnosticLine(diagnostic)+'\n'+privateValue;
 const stderr=[recoveryDiagnosticLine(toolDiagnostic),
  recoveryDiagnosticPrefix+JSON.stringify({...diagnostic,sql:privateValue}),
  recoveryDiagnosticPrefix+JSON.stringify({...diagnostic,stage:privateValue}),
  recoveryDiagnosticPrefix+JSON.stringify({...diagnostic,sqlstate:privateValue}),
  recoveryDiagnosticPrefix+'{not-json}',
  'error: '+privateValue].join('\n');
 const collected=collectRecoveryDiagnostics(stdout,stderr);assert.deepEqual(collected,[diagnostic,toolDiagnostic]);assert.doesNotMatch(JSON.stringify(collected),new RegExp(privateValue));
 assert.deepEqual(collectRecoveryDiagnostics(recoveryDiagnosticPrefix+JSON.stringify({stage:'SEED_CORE',code:'POSTGRES_ERROR',sqlstate:'S1234'})),[]);
 assert.throws(()=>recoveryDiagnosticLine({...diagnostic,extra:privateValue}),/INVALID_RECOVERY_DIAGNOSTIC/);
});

test('D19 tool diagnosis classifies only known error headers and refuses stale, future or oversized files',async()=>{
 const examples=[
  ['pg_restore: error: could not execute query: ERROR:  permission denied for schema "synthetic_private"','PERMISSION_DENIED'],
  ['pg_restore: error: could not execute query: ERROR:  role "synthetic_private" does not exist','ROLE_MISSING'],
  ['pg_restore: error: could not execute query: ERROR:  extension "synthetic_private" is not available','EXTENSION_UNAVAILABLE'],
  ['pg_restore: error: could not execute query: ERROR:  unrecognized configuration parameter "synthetic_private"','CONFIG_UNSUPPORTED'],
  ['pg_restore: error: unsupported version (1.99) in file header','ARCHIVE_VERSION'],
  ['pg_restore: error: could not execute query: ERROR:  can only create extension in database synthetic_private','CRON_DATABASE_ONLY'],
  ['pg_restore: error: could not execute query: ERROR:  relation "permission denied" already exists','OBJECT_EXISTS']
 ] as const;
 for(const [input,expected] of examples)assert.deepEqual(classifyRecoveryToolError(input),[expected]);
 assert.deepEqual(classifyRecoveryToolError('pg_dump: error: query failed: ERROR:  permission denied for table "synthetic_private"'),['PERMISSION_DENIED']);
 assert.deepEqual(classifyRecoveryToolError('Command was: SELECT \'permission denied\';\nCONTEXT: role "synthetic_private" does not exist\nDETAIL: unrecognized configuration parameter "private"'),[]);
 assert.deepEqual(classifyRecoveryToolError('pg_restore: error: could not execute query: ERROR:  synthetic_private permission denied'),[]);
 assert.deepEqual(classifyRecoveryToolError('x'.repeat(65537)),[]);
 assert.doesNotMatch(JSON.stringify(examples.flatMap(([input])=>classifyRecoveryToolError(input))),/synthetic_private|SELECT|schema|role/);
 const root=await mkdtemp(join(tmpdir(),'sigongnote-tool-diagnostic-')),file=join(root,'recovery-tool-error.log'),start=Date.now()-4000,end=start+2000;
 try{
  await writeFile(file,examples[0][0]);await utimes(file,new Date(start),new Date(start));
  assert.deepEqual(readCurrentRecoveryToolDiagnostic(file,start,end),{status:'CLASSIFIED',types:['PERMISSION_DENIED']});
  await utimes(file,new Date(start-1000),new Date(start-1000));assert.deepEqual(readCurrentRecoveryToolDiagnostic(file,start,end),{status:'NOT_CURRENT',types:[]});
  await utimes(file,new Date(end+1000),new Date(end+1000));assert.deepEqual(readCurrentRecoveryToolDiagnostic(file,start,end),{status:'NOT_CURRENT',types:[]});
  await writeFile(file,'x'.repeat(65537));await utimes(file,new Date(start),new Date(start));assert.deepEqual(readCurrentRecoveryToolDiagnostic(file,start,end),{status:'TOO_LARGE',types:[]});
  await writeFile(file,'');await utimes(file,new Date(start),new Date(start));assert.deepEqual(readCurrentRecoveryToolDiagnostic(file,start,end),{status:'EMPTY',types:[]});
  assert.deepEqual(readCurrentRecoveryToolDiagnostic(root,start,end),{status:'NOT_REGULAR',types:[]});
  assert.deepEqual(readCurrentRecoveryToolDiagnostic(file,end,start),{status:'INVALID_WINDOW',types:[]});
 }finally{await rm(root,{recursive:true,force:true});}
});
test('D19 finite stderr marker survives an actual Node TAP child without a nested test context',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sigongnote-diagnostic-pipe-')),file=join(root,'finite.test.mjs');
 try{
  const diagnostic={stage:'RESTORE_SCHEMA',code:'RECOVERY_TOOL_FAILED',sqlstate:null};
  await writeFile(file,"import {test} from 'node:test';\ntest('finite recovery diagnostic',()=>{process.stderr.write("+JSON.stringify(recoveryDiagnosticLine(diagnostic)+'\n')+");});\n");
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const child=spawnSync(process.execPath,['--test','--test-reporter=tap',file],{encoding:'utf8',env,windowsHide:true,timeout:10000,maxBuffer:65536});
  assert.equal(child.status,0,'finite diagnostic fixture must complete');assert.equal(child.signal,null);
  assert.equal(/^# tests 1\r?$/m.test(child.stdout),true);assert.equal(/^# pass 1\r?$/m.test(child.stdout),true);
  assert.deepEqual(collectRecoveryDiagnostics(child.stdout,child.stderr),[diagnostic]);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('D19 RAM protection requires the exact synthetic database and every hosted-Linux opt-in',()=>{
 const seed='sigongnote_drill_seed_'+'a'.repeat(32),env={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux',SIGONGNOTE_RECOVERY_TEST:'1',SIGONGNOTE_RECOVERY_DISPOSABLE_VM:'1',SIGONGNOTE_E2E_DB:'0'};
 assert.equal(syntheticRecoveryProtectionAllowed(seed,env,'linux'),true);
 for(const database of ['postgres','production','postgresql://127.0.0.1/postgres','sigongnote_drill_seed_'+'A'.repeat(32),seed+';drop database postgres',seed+'\n',seed+'\r\n','sigongnote_restore_'+'a'.repeat(32)])assert.equal(syntheticRecoveryProtectionAllowed(database,env,'linux'),false);
 for(const platform of ['win32','darwin','Linux',''])assert.equal(syntheticRecoveryProtectionAllowed(seed,env,platform),false);
 for(const key of Object.keys(env)){
  const missing:{[key:string]:string|undefined}={...env};delete missing[key];assert.equal(syntheticRecoveryProtectionAllowed(seed,missing,'linux'),false,key+' missing');
  for(const wrong of ['', 'false','1','0','self-hosted','Windows'])if(wrong!==env[key as keyof typeof env])assert.equal(syntheticRecoveryProtectionAllowed(seed,{...env,[key]:wrong},'linux'),false,key+' changed');
 }
 for(const code of ['WINDOWS_KEY_PROTECTION_REQUIRED','LOCAL_KEY_PROTECTION_FAILED','INVALID_LOCAL_KEY','COPY_CORRUPT','SYNTHETIC_RECOVERY_PROTECTION_FORBIDDEN']){
  const error=new Error(code);assert.deepEqual(attachRecoveryDiagnostic(error,'RECOVERY_DRILL'),{stage:'RECOVERY_DRILL',code,sqlstate:null});assert.equal(error.message,code);
 }
});
test('D19 rejects protection injection before any DB gate and keeps the default invalid-source error',async()=>{
 const protection=new CopyProtection(randomBytes(32));
 for(const source of ['postgres','production','postgresql://127.0.0.1/postgres'])await assert.rejects(()=>recoveryDrill(source,{syntheticProtection:protection}),/SYNTHETIC_RECOVERY_PROTECTION_FORBIDDEN/);
 const previous=process.env.SIGONGNOTE_RECOVERY_TEST;process.env.SIGONGNOTE_RECOVERY_TEST='0';
 try{await assert.rejects(()=>recoveryDrill('sigongnote_drill_seed_'+'a'.repeat(32),{syntheticProtection:protection}),/SYNTHETIC_RECOVERY_PROTECTION_FORBIDDEN/);}
 finally{if(previous===undefined)delete process.env.SIGONGNOTE_RECOVERY_TEST;else process.env.SIGONGNOTE_RECOVERY_TEST=previous;}
 await assert.rejects(()=>recoveryDrill('production'),/INVALID_RECOVERY_SOURCE/);
});
test('N29 Windows snapshot preserves queue/key/copy bytes and marks missing pending data, never new-host decryption',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sigongnote-native-recovery-')),source=join(root,'source'),target=join(root,'archive'),protection=new CopyProtection(randomBytes(32));await mkdir(join(source,'copies'),{recursive:true});
 try{const db=new DatabaseSync(join(source,'capture-state.db'));db.exec("pragma user_version=11;create table capture_queue(capture_key text primary key,state text);insert into capture_queue values('synthetic-pending','paused_logout'),('old-ack','acknowledged'),('synthetic-too-large','too_large'),('synthetic-lost-key','local_key_lost');");db.close();
  const key=randomBytes(64),copy=Buffer.from('synthetic already encrypted copy');await writeFile(join(source,'queue-key.protected'),key);await writeFile(join(source,'session.protected'),Buffer.from('synthetic protected account'));await writeFile(join(source,'copies/synthetic-pending.sgn'),copy);
  const before=await readFile(join(source,'capture-state.db')),saved=await archiveNativeSnapshot(source,target,'windows',protection);assert.equal(saved.status,'verified_encrypted_snapshot');assert.equal(saved.pending,3);assert.equal(saved.uncopied_pending,2);assert.equal(saved.local_key_lost_count,1);assert.equal(saved.cross_device_restorable,false);assert.deepEqual(await readFile(join(source,'capture-state.db')),before);assert.deepEqual(await readFile(join(source,'queue-key.protected')),key);
  const m=JSON.parse(protection.decrypt(await readFile(join(target,'manifest.sealed'))).toString());for(const e of m.entries)assert.deepEqual(protection.decrypt(await readFile(join(target,e.file))),await readFile(join(source,e.path)));
  assert.equal((await verifyNativeSnapshot(target,protection)).automatic_replay_allowed,false);await assert.rejects(()=>verifyNativeSnapshot(target,new CopyProtection(randomBytes(32))));
  const restored=join(root,'restored'),restoredReport=await restoreNativeSnapshot(target,restored,protection);assert.equal(restoredReport.app_activated,false);assert.equal(restoredReport.queue.pending_count,3);assert.equal(restoredReport.queue.uncopied_pending,2);assert.equal(restoredReport.queue.local_key_lost_count,1);assert.deepEqual(await readFile(join(restored,'queue-key.protected')),key);assert.deepEqual(await readFile(join(restored,'copies/synthetic-pending.sgn')),copy);assert.deepEqual(await readFile(join(restored,'capture-state.db')),before);await assert.rejects(()=>restoreNativeSnapshot(target,restored,protection),/EEXIST/);await assert.rejects(()=>restoreNativeSnapshot(target,source,protection),/EEXIST/);
  await writeFile(join(target,m.entries[0].file),Buffer.from('tampered'));await assert.rejects(()=>verifyNativeSnapshot(target,protection));
  await rm(join(source,'copies/synthetic-pending.sgn'));const missing=await archiveNativeSnapshot(source,join(root,'incomplete'),'windows',protection);assert.equal(missing.status,'incomplete');assert.equal(missing.missing_pending_copies,1);
  await assert.rejects(()=>restoreNativeSnapshot(join(root,'incomplete'),join(root,'refused'),protection),/INCOMPLETE/);
  await writeFile(join(source,'capture-state.db-wal'),'not checkpointed');await assert.rejects(()=>archiveNativeSnapshot(source,join(root,'wal'),'windows',protection),/NOT_CHECKPOINTED/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('N29 Android snapshot includes unbound shares and inline notifications without exporting device Keystore',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sigongnote-native-recovery-')),source=join(root,'source'),target=join(root,'archive'),protection=new CopyProtection(randomBytes(32));await mkdir(join(source,'databases'),{recursive:true});await mkdir(join(source,'files/share-inbox'),{recursive:true});
 try{const db=new DatabaseSync(join(source,'databases/capture-queue.db'));db.exec("pragma user_version=10;create table capture_queue(captureId text primary key,state text,encryptedCopyName text);create table notification_snapshots(snapshotId text primary key,encryptedPayload text);create table share_inbox(shareId text primary key,state text,encryptedCopyName text);insert into capture_queue values('synthetic-inline','paused_logout',null),('synthetic-discovered','discovered',null);insert into notification_snapshots values('synthetic-inline','protected notification');insert into share_inbox values('synthetic-unbound','staged_unbound','share.sealed');");db.close();await writeFile(join(source,'files/share-inbox/share.sealed'),'synthetic encrypted share');
  const r=await archiveNativeSnapshot(source,target,'android',protection);assert.equal(r.status,'verified_encrypted_snapshot');const m=JSON.parse(protection.decrypt(await readFile(join(target,'manifest.sealed'))).toString());assert.equal(m.queue.unbound_count,1);assert.equal(m.queue.uncopied_pending,1);assert.equal(m.queue.inline_pending,1);assert.equal(m.queue_key_present,'device_keystore_required');assert.equal(m.decryption_on_new_device_verified,false);
  const restored=await restoreNativeSnapshot(target,join(root,'restored'),protection);assert.equal(restored.queue.unbound_count,1);assert.equal(restored.queue.uncopied_pending,1);assert.equal(restored.queue.inline_pending,1);assert.equal(restored.automatic_replay_allowed,false);
  m.entries[0].path='../escape';await writeFile(join(target,'manifest.sealed'),protection.encrypt(Buffer.from(JSON.stringify(m))));await assert.rejects(()=>verifyNativeSnapshot(target,protection),/MANIFEST/);
  const assets=recoveryAssets(['synthetic-version'],['sigongnote_api']);assert.equal(assets.full_product_restore_accepted,false);
  assert.deepEqual(assets.work_events.tables,['app.work_events','app.work_followups','app.work_event_sources','app.work_event_corrections','app.local_context_consents']);assert.equal(assets.work_events.included_in_all_app_tables,true);
  assert.deepEqual(assets.context_learning.tables,['app.context_learning_cases','app.context_reading_procedures','app.context_reading_shadows','app.context_reading_evaluations']);assert.equal(assets.context_learning.included_in_all_app_tables,true);
  assert.equal(assets.key_dependencies.every(k=>k.included===false),true);assert.equal(assets.native_queues.new_device_decryption_verified,false);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('N31b inspecting a checkpointed WAL snapshot never changes its source sidecars',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sigongnote-wal-recovery-')),source=join(root,'source');await mkdir(join(source,'databases'),{recursive:true});const path=join(source,'databases/capture-queue.db'),db=new DatabaseSync(path),protection=new CopyProtection(randomBytes(32));
 try{db.exec("pragma journal_mode=WAL;pragma user_version=10;create table capture_queue(captureId text primary key,state text,encryptedCopyName text);insert into capture_queue values('pending','discovered',null);pragma wal_checkpoint(TRUNCATE);");
  // Keep this local synthetic connection open so zero-length WAL and SHM remain present.
  const before=await Promise.all([path,path+'-wal',path+'-shm'].map(p=>readFile(p)));
  const result=await archiveNativeSnapshot(source,join(root,'archive'),'android',protection);assert.equal(result.status,'verified_encrypted_snapshot');
  for(const [i,p] of [path,path+'-wal',path+'-shm'].entries())assert.deepEqual(await readFile(p),before[i]);
  const restored=await restoreNativeSnapshot(join(root,'archive'),join(root,'restored'),protection);assert.equal(restored.queue.pending_count,1);
 }finally{db.close();await rm(root,{recursive:true,force:true});}
});
