import {createHash} from 'node:crypto';
import {lstat,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {copyFileSync,mkdtempSync,rmSync,mkdirSync,lstatSync} from 'node:fs';
import {resolve,relative,sep,dirname,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {CopyProtection,loadCopyProtection} from '../services/local-agent/src/protection.js';
type Platform='windows'|'android';
type Entry={path:string;sha256:string;bytes:number;file:string};
const hash=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
const within=(root:string,target:string)=>target.startsWith(root+sep);
const safe=(path:string)=>!!path&&!path.includes('\\')&&!path.startsWith('/')&&!path.includes(':')&&path.split('/').every(p=>p!=='.'&&p!=='..'&&p.length>0);
// These states precede a completed managed copy. Missing bytes here are work still to collect.
// Unknown states remain fail-closed; suspended upload states still require their existing copy.
const uncopiedStates=new Set(['discovered','backfill_approval_needed','staging','source_changed','source_unavailable','storage_full','copy_error','too_large','local_key_lost']);
async function noLinks(path:string){for(let part=resolve(path);;part=dirname(part)){const stat=await lstat(part).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(stat?.isSymbolicLink())throw Error('RECOVERY_DEVICE_LINK');if(dirname(part)===part)break;}}
async function list(root:string,folder=root):Promise<string[]>{const out:string[]=[];for(const e of await readdir(folder,{withFileTypes:true})){const target=resolve(folder,e.name),s=await lstat(target);if(s.isSymbolicLink()||!within(root,target))throw Error('RECOVERY_DEVICE_LINK');if(s.isDirectory())out.push(...await list(root,target));else if(s.isFile())out.push(relative(root,target).split(sep).join('/'));else throw Error('RECOVERY_DEVICE_FILE');if(out.length>50000)throw Error('RECOVERY_DEVICE_LIMIT');}return out.sort();}
function pending(db:DatabaseSync,platform:Platform){
 const rows=db.prepare('select * from capture_queue order by '+(platform==='windows'?'capture_key':'captureId')).all();
 return rows.filter(r=>!['acknowledged','revoked_purged','ack_purged'].includes(String(r.state)));
}
function queueSnapshot(path:string,platform:Platform,files:Set<string>){
 // SQLite can rewrite a WAL shared-memory sidecar even on a read-only connection.
 // Inspect a private copy of the already-checkpointed database, never the source snapshot.
 const size=lstatSync(path);if(!size.isFile()||size.size>256*1024*1024)throw Error('RECOVERY_DEVICE_LIMIT');
 const base=resolve('.work/recovery-scratch');mkdirSync(base,{recursive:true,mode:0o700});
 const scratch=mkdtempSync(join(base,'queue-'));let db:DatabaseSync|undefined;
 try{const copy=join(scratch,'queue.db');copyFileSync(path,copy);db=new DatabaseSync(copy,{readOnly:true});
  if(db.prepare('pragma integrity_check').get()?.integrity_check!=='ok'||db.prepare('pragma foreign_key_check').all().length)throw Error('RECOVERY_QUEUE_INVALID');
  const version=Number(db.prepare('pragma user_version').get()?.user_version);if(version<1||version>(platform==='windows'?11:10))throw Error('RECOVERY_QUEUE_VERSION');
  const rows=pending(db,platform),unbound:Record<string,unknown>[]=[];let missing=0,inline=0,uncopied=0,keyLost=0;
  if(platform==='android')for(const [table,id] of [['share_inbox','shareId'],['folder_observations','observationId']] as const){
   if(db.prepare("select name from sqlite_master where type='table' and name=?").get(table))unbound.push(...db.prepare(`select * from ${table} where state not in ('acknowledged','revoked_purged','ack_purged') and ${id} not in(select captureId from capture_queue) order by ${id}`).all());
  }
  const hasNotifications=!!db.prepare("select name from sqlite_master where type='table' and name='notification_snapshots'").get();
  for(const row of [...rows,...unbound]){
   if(row.state==='local_key_lost')keyLost++;
   if(platform==='windows'){if(!files.has('copies/'+String(row.capture_key)+'.sgn')){if(uncopiedStates.has(String(row.state)))uncopied++;else missing++;}}
   else if(row.encryptedCopyName){const name=String(row.encryptedCopyName);if(!safe(name)||name.includes('/')||!['files/folder-copies/','files/share-inbox/'].some(prefix=>files.has(prefix+name)))missing++;}
   else if(hasNotifications&&db.prepare('select 1 from notification_snapshots where snapshotId=? and encryptedPayload is not null').get(String(row.captureId)))inline++;
   else if(uncopiedStates.has(String(row.state)))uncopied++;
   else missing++;
  }
  return {schema_version:version,pending_count:rows.length,unbound_count:unbound.length,pending_hash:hash(JSON.stringify({rows,unbound})),missing_pending_copies:missing,uncopied_pending:uncopied,local_key_lost_count:keyLost,inline_pending:inline};
 }finally{db?.close();rmSync(scratch,{recursive:true,force:true});}
}
/** Archive a closed-app snapshot supplied by the operator, never the running app directory. */
export async function archiveNativeSnapshot(source:string,destination:string,platform:Platform,protection:CopyProtection){
 const root=resolve(source),target=resolve(destination);if(root===target||within(root,target)||within(target,root))throw Error('RECOVERY_DEVICE_SCOPE');await noLinks(root);await noLinks(target);
 const names=await list(root),database=platform==='windows'?'capture-state.db':'databases/capture-queue.db';if(!names.includes(database)||names.some(n=>!safe(n)))throw Error('RECOVERY_DEVICE_DATABASE');
 for(const name of names.filter(n=>n.endsWith('-wal')||n.endsWith('-journal')))if((await lstat(resolve(root,name))).size>0)throw Error('RECOVERY_SNAPSHOT_NOT_CHECKPOINTED');
 const queue=queueSnapshot(resolve(root,database),platform,new Set(names));await mkdir(target);const entries:Entry[]=[];
 for(const [i,path] of names.entries()){
  const location=resolve(root,path),before=await lstat(location);if(before.isSymbolicLink()||before.size>256*1024*1024)throw Error('RECOVERY_DEVICE_LIMIT');const bytes=await readFile(location),after=await lstat(location);if(before.mtimeMs!==after.mtimeMs||before.size!==after.size||bytes.length!==before.size)throw Error('RECOVERY_DEVICE_CHANGED');
  const file=i+'.sealed';await writeFile(resolve(target,file),protection.encrypt(bytes),{flag:'wx',mode:0o600});entries.push({path,sha256:hash(bytes),bytes:bytes.length,file});
 }
 if(JSON.stringify(await list(root))!==JSON.stringify(names))throw Error('RECOVERY_DEVICE_CHANGED');
 for(const e of entries)if(hash(await readFile(resolve(root,e.path)))!==e.sha256)throw Error('RECOVERY_DEVICE_CHANGED');
 const queueKey=platform==='windows'?names.includes('queue-key.protected'):'device_keystore_required';
 const manifest={schema:1,platform,queue,entries,status:queue.missing_pending_copies||queueKey===false?'incomplete':'verified_encrypted_snapshot',key_binding:platform==='windows'?'same_windows_account_dpapi':'same_android_keystore_and_app_signature',queue_key_present:queueKey,decryption_on_new_device_verified:false,signing_material_in_snapshot:names.some(n=>n.startsWith('signing/')||/\.(p12|jks|keystore)$/.test(n)),automatic_replay_allowed:false};
 await writeFile(resolve(target,'manifest.sealed'),protection.encrypt(Buffer.from(JSON.stringify(manifest))),{flag:'wx',mode:0o600});return {status:manifest.status,platform,files:entries.length,pending:queue.pending_count,missing_pending_copies:queue.missing_pending_copies,uncopied_pending:queue.uncopied_pending,local_key_lost_count:queue.local_key_lost_count,cross_device_restorable:false};
}
async function manifest(archive:string,protection:CopyProtection){
 const root=resolve(archive);await noLinks(resolve(root,'manifest.sealed'));const m=JSON.parse(protection.decrypt(await readFile(resolve(root,'manifest.sealed'))).toString());
 if(m.schema!==1||!['windows','android'].includes(m.platform)||!Array.isArray(m.entries)||m.entries.length>50000||!['incomplete','verified_encrypted_snapshot'].includes(m.status)||m.automatic_replay_allowed!==false||!m.queue||!Number.isSafeInteger(m.queue.pending_count)||m.queue.pending_count<0||!Number.isSafeInteger(m.queue.missing_pending_copies)||m.queue.missing_pending_copies<0)throw Error('RECOVERY_DEVICE_MANIFEST');const names=new Set<string>(),sealed=new Set<string>();
 for(const e of m.entries){if(typeof e.path!=='string'||!safe(e.path)||names.has(e.path.toLowerCase())||!/^[0-9]+\.sealed$/.test(e.file)||sealed.has(e.file)||!/^[a-f0-9]{64}$/.test(e.sha256)||!Number.isSafeInteger(e.bytes)||e.bytes<0||e.bytes>256*1024*1024)throw Error('RECOVERY_DEVICE_MANIFEST');names.add(e.path.toLowerCase());sealed.add(e.file);const path=resolve(root,e.file);await noLinks(path);if((await lstat(path)).size>256*1024*1024+64)throw Error('RECOVERY_DEVICE_LIMIT');const bytes=protection.decrypt(await readFile(path));if(bytes.length!==e.bytes||hash(bytes)!==e.sha256)throw Error('RECOVERY_DEVICE_HASH');}
 return m;
}
export async function verifyNativeSnapshot(archive:string,protection:CopyProtection){
 const m=await manifest(archive,protection);
 return {status:m.status,platform:m.platform,files:m.entries.length,pending:m.queue.pending_count,missing_pending_copies:m.queue.missing_pending_copies,uncopied_pending:m.queue.uncopied_pending,local_key_lost_count:m.queue.local_key_lost_count,key_binding:m.key_binding,cross_device_restorable:false,automatic_replay_allowed:false};
}
/** Materialize only into a newly created folder. Never activate an account, app or upload worker. */
export async function restoreNativeSnapshot(archive:string,destination:string,protection:CopyProtection){
 const root=resolve(archive),target=resolve(destination);if(root===target||within(root,target)||within(target,root))throw Error('RECOVERY_DEVICE_SCOPE');await noLinks(target);
 const m=await manifest(root,protection);if(m.status!=='verified_encrypted_snapshot')throw Error('RECOVERY_DEVICE_INCOMPLETE');
 await mkdir(target);for(const e of m.entries as Entry[]){const output=resolve(target,e.path);if(!within(target,output))throw Error('RECOVERY_DEVICE_SCOPE');await mkdir(dirname(output),{recursive:true});await noLinks(output);const bytes=protection.decrypt(await readFile(resolve(root,e.file)));if(hash(bytes)!==e.sha256)throw Error('RECOVERY_DEVICE_HASH');await writeFile(output,bytes,{flag:'wx',mode:0o600});}
 const database=m.platform==='windows'?'capture-state.db':'databases/capture-queue.db',queue=queueSnapshot(resolve(target,database),m.platform,new Set(await list(target)));
 if(JSON.stringify(queue)!==JSON.stringify(m.queue)||queue.missing_pending_copies)throw Error('RECOVERY_QUEUE_DIFFERS');
 return {status:'verified_isolated_files',files:m.entries.length,queue,cross_device_restorable:false,automatic_replay_allowed:false,app_activated:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 (async()=>{const [action,platform,source,target]=process.argv.slice(2);if(action!=='archive')await lstat('.work/recovery-keys/copy-key.protected');await mkdir('.work/recovery-keys',{recursive:true});const protection=await loadCopyProtection(resolve('.'),resolve('.work/recovery-keys'));
  if(action==='archive'&&(platform==='windows'||platform==='android')&&source&&target)return archiveNativeSnapshot(source,target,platform,protection);
  if(action==='verify'&&platform&&!source)return verifyNativeSnapshot(platform,protection);if(action==='restore'&&platform&&source&&!target)return restoreNativeSnapshot(platform,source,protection);throw Error('RECOVERY_DEVICE_ARGUMENTS');
 })().then(r=>console.log(JSON.stringify(r)),()=>{console.error('RECOVERY_DEVICE_INCOMPLETE; original snapshot preserved');process.exitCode=1;});
}
