import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {workHttp,WorkRequestSchema} from '@sigongnote/contracts';
import type {LocalAgent,LocalDocument} from './agent.js';
import {sha256,inside} from './agent.js';
import {mimeFor,categoryLabels} from './journal.js';

export interface CloudSession {apiUrl:string;accessToken:string;tenantId:string;userId:string;deviceId:string;nativeSources?:{source_id:string;root:string;kind:'folder'|'photos'|'call_recording';active:boolean;setup_state:string;pending:number;error:string|null;managed_root:boolean;account?:string}[]}
type Entry={id:string;received_at:string;project_id:string|null;project_name:string|null;categories:string[];[key:string]:unknown};
type Project={id:string;display_name:string};
type Context={company:string;projects:Project[];[key:string]:unknown};
type PushItem={id:string;received_at:string;file_name:string;project_name:string|null;categories:string[];excerpt:string;sha256:string|null;mime:string;source_kind:string;revision:number};
const accountFor=(session:CloudSession|null)=>session?`${session.userId}:${session.tenantId}`:'';
/** Matches WindowsFileStabilizer's capture identity; content alone never joins two sources. */
export function windowsNativeCaptureId(sourceId:string,relativePath:string,hash:string){
 const relative=relativePath.replaceAll('/','\\'),upper=[...relative].map(char=>{const folded=char.toUpperCase();return folded.length===char.length?folded:char;}).join('');
 const token=sha256(sourceId+'\0'+upper).toUpperCase(),hex=sha256(sourceId+'\0'+token+'\0'+hash.toUpperCase());
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
}

export async function windowsCloudSession():Promise<CloudSession|null>{
 const helper=process.env.SIGONGNOTE_WINDOWS_HELPER;if(!helper)return null;
 const {stdout}=await promisify(execFile)(helper,['--local-cloud-session'],{windowsHide:true,timeout:20000,maxBuffer:1048576});
 const value=JSON.parse(stdout.trim()||'null') as CloudSession|null;
 if(!value?.accessToken||!value.tenantId||!value.userId)return null;
 const url=new URL(value.apiUrl);if(url.protocol!=='https:'||url.username||url.password)throw new Error('CLOUD_CONNECTION_INVALID');return value;
}

/** Account-bound delivery and the authenticated work bridge. Originals stay local. */
export class LocalCloudSync {
 private session:CloudSession|null=null;
 private active='';
 private running:Promise<void>|undefined;
 private failure:string|undefined;
 private context:Context|null=null;
 constructor(private readonly agent:LocalAgent,private readonly getSession:()=>Promise<CloudSession|null>=windowsCloudSession,private readonly request:typeof fetch=fetch){
  agent.db.exec(`CREATE TABLE IF NOT EXISTS cloud_owner(id TEXT PRIMARY KEY,account TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS cloud_delivery(id TEXT NOT NULL,account TEXT NOT NULL,fingerprint TEXT NOT NULL,revision_id TEXT NOT NULL,PRIMARY KEY(id,account));
   CREATE TABLE IF NOT EXISTS cloud_cache(account TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(account,id));
   CREATE TABLE IF NOT EXISTS cloud_project_owner(id TEXT PRIMARY KEY,account TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS cloud_context(account TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  agent.cloud=this;
 }
 info(){return {connected:!!this.session,pending:this.session?this.pending().length:0,status:this.session?(this.failure?'offline':'connected'):'local',...(this.failure?{error:this.failure}:{}),...(this.context?{company:this.context.company}:{}),native_sources:this.session?.nativeSources?.filter(source=>!source.account||source.account===this.active).map(({root:_root,...source})=>source)??[]};}
 /** No previous token fallback: a native logout immediately removes server access. */
 async currentSession(){return this.refreshSession();}
 private async refreshSession(){
  let session:CloudSession|null;
  try{session=await this.getSession();}catch{session=null;}
  const account=accountFor(session);
  const changed=account!==this.active;
  if(account!==this.active){
   this.context=null;this.failure=undefined;this.active=account;
   if(account){const cached=this.agent.db.prepare('SELECT value FROM cloud_context WHERE account=?').get(account);if(cached)this.context=JSON.parse(String(cached.value)) as Context;}
  }
  this.session=session;
  // Claim inventory before networking, including files still being parsed. A later
  // account cannot acquire the previous account's offline queue or metadata.
  if(session)for(const row of this.agent.db.prepare('SELECT id FROM documents WHERE id NOT IN (SELECT id FROM cloud_owner)').all())this.bind(String(row.id));
  if(changed)await this.agent.journal.publish();
  return session;
 }
 bind(id:string){if(this.active&&this.session){const document=this.agent.db.prepare('SELECT * FROM documents WHERE id=?').get(id) as unknown as LocalDocument|undefined,scope=document?this.nativeScope(document):undefined;this.agent.db.prepare('INSERT OR IGNORE INTO cloud_owner VALUES(?,?)').run(id,scope?.account??this.active);}}
 bindProject(id:string){this.agent.db.prepare('INSERT OR IGNORE INTO cloud_project_owner VALUES(?,?)').run(id,this.active);}
 visible(id:string){const owner=this.agent.db.prepare('SELECT account FROM cloud_owner WHERE id=?').get(id);return owner?owner.account===this.active&&!!this.session:true;}
 assertVisible(id:string){if(!this.visible(id))throw new Error('DOCUMENT_NOT_FOUND');}
 /** The existing native collector uploads only explicitly consented recording scopes.
  * Its copy/receipt/STT remains authoritative; a metadata-only local row is not a second source. */
 nativeRecording(document:Pick<LocalDocument,'source_id'|'relative_path'|'ext'>){
  if(!['.mp3','.m4a','.wav','.aac','.ogg','.flac','.amr'].includes(document.ext))return false;
  return this.nativeScope(document)?.kind==='call_recording';
 }
 private nativeScope(document:Pick<LocalDocument,'source_id'|'relative_path'|'ext'>){
  const file=path.resolve(this.agent.source(document.source_id).root,document.relative_path);
  const scope=this.session?.nativeSources?.filter(scope=>inside(path.resolve(scope.root),file)).sort((a,b)=>b.root.length-a.root.length)[0];
  if(!scope)return undefined;
  const audio=['.mp3','.m4a','.wav','.aac','.ogg','.flac','.amr'].includes(document.ext),photo=['.jpg','.jpeg','.png','.webp','.heic','.heif','.bmp','.tif','.tiff','.gif'].includes(document.ext);
  const relative=path.relative(scope.root,file),knownRecording=relative.split(/[\\/]/).some(part=>['recordings','call recordings','call recording','통화 녹음','통화녹음'].includes(part.toLocaleLowerCase())),knownPhotos=relative.split(/[\\/]/).some(part=>['dcim','camera','camera roll'].includes(part.toLocaleLowerCase()));
  return scope.kind==='call_recording'?audio?scope:undefined:scope.kind==='photos'?photo&&!knownRecording?scope:undefined:!audio&&!knownRecording&&(!knownPhotos||scope.managed_root)?scope:undefined;
 }
 projects(local:Project[]){
  const names=new Set(this.agent.db.prepare('SELECT id,site FROM documents WHERE site IS NOT NULL').all().filter(row=>this.visible(String(row.id))).map(row=>String(row.site)));
  const remote=this.session?this.context?.projects??[]:[];
  const owned=new Set(this.agent.db.prepare('SELECT id FROM cloud_project_owner WHERE account=?').all(this.active).map(row=>String(row.id)));
  return [...remote,...local.filter(p=>(names.has(p.display_name)||owned.has(p.id))&&!remote.some(r=>r.display_name===p.display_name))];
 }
 private async call(route:string,body?:unknown,key?:string,session=this.session):Promise<unknown>{
  if(!session)throw new Error('CLOUD_LOGIN_REQUIRED');
  let response:Response;
  try{response=await this.request(`${session.apiUrl.replace(/\/$/,'')}${route}`,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${session.accessToken}`,'X-Tenant-ID':session.tenantId,...(body===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':key??randomUUID()})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
  catch{throw new Error('CLOUD_WAITING_FOR_SERVER');}
  if(accountFor(session)!==this.active)throw new Error('CLOUD_ACCOUNT_CHANGED');
  if(!response.ok){const payload=await response.json().catch(()=>null) as {error?:{code?:string}}|null;const code=payload?.error?.code;throw new Error(response.status===401?'CLOUD_LOGIN_REQUIRED':code==='VERSION_CONFLICT'?'CLOUD_VERSION_CONFLICT':response.status===404?'DOCUMENT_NOT_FOUND':response.status>=500?'CLOUD_WAITING_FOR_SERVER':`CLOUD_${code&&/^[A-Z_]+$/.test(code)?code:'REQUEST_REJECTED'}`);}
  return response.json();
 }
 private pending(){
  const items:PushItem[]=this.agent.journal.rows({},true,Number.MAX_SAFE_INTEGER).rows.filter(d=>!this.nativeScope(d)&&d.hash&&['complete','partial','unsupported','encrypted'].includes(d.status)).map(d=>({id:d.id,received_at:d.received_at,file_name:d.name,project_name:d.site,categories:JSON.parse(d.categories) as string[],excerpt:d.excerpt.slice(0,12000),sha256:d.hash,mime:mimeFor(d.ext),source_kind:d.ext.match(/\.(jpe?g|png|webp|heic)/)?'photos':'local_file',revision:d.revision}));
  for(const sheet of this.agent.db.prepare("SELECT * FROM local_photo_sheets WHERE state='succeeded'").all()){
   const snapshot=JSON.parse(String(sheet.snapshot)) as {title:string;project_name:string;photos:{revision_id:string}[]};
   if(!snapshot.photos.every(p=>this.visible(p.revision_id)))continue;
   items.push({id:String(sheet.id),received_at:String(sheet.completed_at),file_name:`${snapshot.title}.pdf`,project_name:snapshot.project_name,categories:['delivery_work'],excerpt:snapshot.title,sha256:String(sheet.sha256),mime:'application/pdf',source_kind:'photo_sheet',revision:1});
  }
  return items.map(item=>({item,fingerprint:sha256(JSON.stringify(item))})).filter(({item,fingerprint})=>{if(!this.visible(item.id))return false;const previous=this.agent.db.prepare('SELECT fingerprint FROM cloud_delivery WHERE id=? AND account=?').get(item.id,this.active);return previous?.fingerprint!==fingerprint;});
 }
 sync(){if(!this.running)this.running=this.run().finally(()=>{this.running=undefined;});return this.running;}
 async stop(){await this.running;}
 private async readContext(session:CloudSession){
  const context=await this.call('/v1/work/context',undefined,undefined,session) as Context;
  const account=accountFor(session);
  this.agent.db.prepare('INSERT OR REPLACE INTO cloud_context VALUES(?,?)').run(account,JSON.stringify(context));
  if(account===this.active){this.context=context;for(const p of context.projects){this.agent.db.prepare('INSERT OR IGNORE INTO local_projects(id,display_name) VALUES(?,?)').run(p.id,p.display_name);this.bindProject(p.id);}}
  return context;
 }
 private async run(){
  let account='';
  try{
   const session=await this.refreshSession();if(!session)return;account=accountFor(session);
   const pending=this.pending();for(const {item} of pending)this.bind(item.id);
   await this.readContext(session);
   for(let index=0;index<pending.length;){
    if(this.active!==account)return;
    const batch:typeof pending=[];let bytes=100;
    while(index<pending.length&&batch.length<20){const item=pending[index]!,size=Buffer.byteLength(JSON.stringify(item.item),'utf8')+1;if(batch.length&&bytes+size>350000)break;batch.push(item);bytes+=size;index++;}
    const result=await this.call('/v1/local-journal/push',{device_id:session.deviceId,items:batch.map(x=>x.item)},undefined,session) as {items:{local_id:string;revision_id:string}[]};
    for(const ack of result.items){const sent=batch.find(x=>x.item.id===ack.local_id);if(sent)this.agent.db.prepare('INSERT OR REPLACE INTO cloud_delivery VALUES(?,?,?,?)').run(ack.local_id,account,sent.fingerprint,ack.revision_id);}
   }
   await this.linkNativeSources(session);
   const items:Entry[]=[];let cursor:string|null=null;
   for(let page=0;page<20;page++){if(this.active!==account)return;const result=await this.call('/v1/work/journal'+(cursor?`?cursor=${encodeURIComponent(cursor)}`:''),undefined,undefined,session) as {items:Entry[];next_cursor:string|null};items.push(...result.items);cursor=result.next_cursor;if(!cursor)break;}
   this.agent.db.exec('BEGIN IMMEDIATE');
   try{this.agent.db.prepare('DELETE FROM cloud_cache WHERE account=?').run(account);for(const item of items)this.agent.db.prepare('INSERT OR REPLACE INTO cloud_cache VALUES(?,?,?)').run(account,item.id,JSON.stringify(item));this.agent.db.exec('COMMIT');}catch(error){this.agent.db.exec('ROLLBACK');throw error;}
   if(this.active!==account)return;
   let organizationChanged=false;
   for(const item of items){
    const mapping=this.agent.db.prepare('SELECT id FROM cloud_delivery WHERE account=? AND revision_id=?').get(account,item.id);
    if(!mapping||!this.agent.db.prepare('SELECT id FROM documents WHERE id=?').get(String(mapping.id)))continue;
    const doc=this.agent.document(String(mapping.id));if(doc.site!==item.project_name)organizationChanged=true;
    this.agent.db.prepare('INSERT OR REPLACE INTO document_site_origins VALUES(?,?)').run(doc.id,'manual');
    this.agent.db.prepare('UPDATE documents SET site=?,categories=?,category=? WHERE id=?').run(item.project_name,JSON.stringify(item.categories),item.categories.map(c=>categoryLabels[c]??c).join(' · '),doc.id);
    const current=this.pending().find(x=>x.item.id===doc.id);if(current)this.agent.db.prepare('UPDATE cloud_delivery SET fingerprint=? WHERE id=? AND account=?').run(current.fingerprint,doc.id,account);
   }
   if(organizationChanged)await this.agent.journal.publish();
   // A push may have created a local project's canonical server ID.
   if(pending.length)await this.readContext(session);
   this.failure=undefined;
  }catch(error){if(!account||account===this.active)this.failure=error instanceof Error?error.message:'CLOUD_WAITING_FOR_SERVER';}
 }
 private entries(){if(!this.active||!this.session)return [];return this.agent.db.prepare('SELECT value FROM cloud_cache WHERE account=?').all(this.active).map(r=>JSON.parse(String(r.value)) as Entry);}
 private async linkNativeSources(session:CloudSession){
  if(!session.nativeSources?.length)return;
  const account=accountFor(session),candidates=(this.agent.db.prepare('SELECT d.*,c.fingerprint FROM documents d JOIN cloud_delivery c ON c.id=d.id AND c.account=? WHERE d.hash IS NOT NULL AND d.available=1').all(account) as unknown as (LocalDocument&{fingerprint:string})[]).filter(d=>this.visible(d.id)&&this.nativeScope(d)&&d.fingerprint!==`native:${d.hash}`).map(d=>{const scope=this.nativeScope(d)!;return {id:d.id,sha256:d.hash!,native_capture_id:windowsNativeCaptureId(scope.source_id,path.relative(scope.root,path.resolve(this.agent.source(d.source_id).root,d.relative_path)),d.hash!)};});
  for(let index=0;index<candidates.length;index+=25){
   if(this.active!==account)return;
   const batch=candidates.slice(index,index+25),result=await this.call('/v1/local-journal/native-links',{device_id:session.deviceId,items:batch},undefined,session) as {items:{local_id:string;revision_id:string|null;state:string}[]};
   for(const ack of result.items){const sent=batch.find(item=>item.id===ack.local_id);if(sent&&ack.state==='linked'&&ack.revision_id)this.agent.db.prepare('INSERT OR REPLACE INTO cloud_delivery VALUES(?,?,?,?)').run(sent.id,account,`native:${sent.sha256}`,ack.revision_id);}
  }
 }
 private mapping(id:string,field:'id'|'revision_id'){
  if(!this.session)return undefined;
  const native=this.nativeMapping(id,field);if(native)return native;
  const mapping=this.agent.db.prepare(`SELECT id,revision_id,fingerprint FROM cloud_delivery WHERE account=? AND ${field}=?`).get(this.active,id) as {id:string;revision_id:string;fingerprint:string}|undefined;
  if(mapping?.fingerprint.startsWith('native:')){const doc=this.agent.db.prepare('SELECT hash,status FROM documents WHERE id=?').get(mapping.id);if(!doc||mapping.fingerprint!==`native:${String(doc.hash)}`||!['complete','partial','encrypted','unsupported'].includes(String(doc.status)))return undefined;}
  return mapping;
 }
 private nativeMapping(id:string,field:'id'|'revision_id'){
  if(!this.session?.nativeSources?.length)return undefined;
  const entries=this.entries().filter(e=>!e.local_metadata&&typeof e.sha256==='string');
  const entry=field==='revision_id'?entries.find(e=>e.id===id):undefined;
  if(field==='revision_id'&&!entry)return undefined;
  const rows=(this.agent.db.prepare(`SELECT * FROM documents WHERE ${field==='id'?'id':'hash'}=? AND available=1 AND hash IS NOT NULL AND status IN ('complete','partial','encrypted','unsupported')`).all(field==='id'?id:String(entry!.sha256)) as unknown as LocalDocument[]).filter(d=>this.visible(d.id)&&!!this.nativeScope(d));
  for(const doc of rows){const scope=this.nativeScope(doc)!,file=path.resolve(this.agent.source(doc.source_id).root,doc.relative_path),capture=windowsNativeCaptureId(scope.source_id,path.relative(scope.root,file),doc.hash!);
   const matched=entry??entries.find(e=>e.sha256===doc.hash&&e.client_capture_id===capture&&e.capture_device_id===this.session!.deviceId);
   if(matched&&matched.client_capture_id===capture&&matched.capture_device_id===this.session!.deviceId)return {id:doc.id,revision_id:matched.id};
  }
  return undefined;
 }
 /** Translate references only; model text and user text are never rewritten. */
 private normalizeReferences(value:unknown,key=''):unknown{
  if(['client_command_id','client_turn_id','intent_id','project_id','user_id','tenant_id','device_id','event_id','task_id','run_id','group_id'].includes(key))return value;
  if(typeof value==='string'&&(/(?:^|_)ids?$/.test(key)||key==='attachment_refs'))return this.mapping(value,'id')?.revision_id??value;
  if(Array.isArray(value))return value.map(item=>this.normalizeReferences(item,key));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,this.normalizeReferences(item,name)]));
  return value;
 }
 private localRequest(request:{route:string;[key:string]:unknown}){
  if(typeof request.id!=='string')return request;
  const mapping=this.mapping(request.id,'revision_id');return mapping?{...request,id:mapping.id}:request;
 }
 private hasLocalPhotoRequest(request:{route:string;[key:string]:unknown}){
  const {route}=request;
  if(route==='photos.preview')return !!this.agent.db.prepare('SELECT id FROM documents WHERE id=?').get(String(request.id));
  if(route==='photos.group')return !!this.agent.db.prepare('SELECT id FROM local_photo_groups WHERE id=?').get(String(request.id));
  if(route==='sheets.read'||route==='sheets.file')return !!this.agent.db.prepare('SELECT id FROM local_photo_sheets WHERE id=?').get(String(request.id));
  if(route==='photos.command'||route==='sheets.prepare'){
   const command=JSON.parse(String(request.command)) as {group_id?:string;photos?:{revision_id:string}[]};
   if(command.group_id)return !!this.agent.db.prepare('SELECT id FROM local_photo_groups WHERE id=?').get(command.group_id);
   const local=command.photos?.filter(p=>this.agent.db.prepare('SELECT id FROM documents WHERE id=?').get(p.revision_id)).length??0;
   if(local&&local!==command.photos?.length)throw new Error('INVALID_MIXED_PHOTO_SOURCES');
   return local>0;
  }
  return false;
 }
 async work(request:{route:string;[key:string]:unknown},origin:string):Promise<unknown|undefined>{
  const session=await this.refreshSession();
  if(request.route==='context'){
   if(session){try{await this.readContext(session);this.failure=undefined;}catch(error){this.failure=error instanceof Error?error.message:'CLOUD_WAITING_FOR_SERVER';}}
   const local=await this.agent.journal.work(request,origin) as Record<string,unknown>;
   return {...local,...(this.context??{}),...(session?{user_id:session.userId,tenant_id:session.tenantId}:{}),local:true,cloud_connected:!!session,cloud_status:this.info().status,projects:this.agent.journal.projects()};
  }
  const local=this.localRequest(request);
  if(['materials.original','materials.detail'].includes(request.route)&&typeof local.id==='string'&&this.agent.db.prepare('SELECT id FROM documents WHERE id=?').get(local.id)){
   this.assertVisible(local.id);return this.agent.journal.work(local,origin);
  }
  if(this.hasLocalPhotoRequest(request))return this.agent.journal.work(request,origin);
  if(!session){
   if(['journal.list','materials.list','capture.status','archive.status','setup.read','setup.command','guide.read','guide.save','organization.answer','photos.list'].includes(request.route))return undefined;
   throw new Error('CLOUD_LOGIN_REQUIRED');
  }
  if(['journal.list','materials.list'].includes(request.route))return this.mergedJournal(request,origin);
  if(request.route==='photos.list'){
   const remote=await this.call(workHttp(WorkRequestSchema.parse(request)).path,undefined,undefined,session) as {photos:Record<string,unknown>[];groups:Record<string,unknown>[];next_cursor:string|null};
   const localPhotos=await this.agent.journal.work({...request,cursor:undefined},origin) as typeof remote;
   return {...remote,photos:[...localPhotos.photos,...remote.photos],groups:[...localPhotos.groups,...remote.groups]};
  }
  if(request.route==='organization.answer'&&typeof local.id==='string'&&this.agent.db.prepare('SELECT id FROM documents WHERE id=?').get(local.id)){
   this.assertVisible(local.id);
   const mapping=this.mapping(local.id,'id');
   if(!mapping)throw new Error('CLOUD_SYNC_REQUIRED');
   const remote=this.entries().find(e=>e.id===mapping.revision_id);
   const call=workHttp(WorkRequestSchema.parse({...request,id:mapping.revision_id,version:remote?.organization_version??request.version}));
   const result=await this.call(call.path,call.body,call.key,session);
   await this.agent.journal.work({...local,version:this.agent.document(local.id).revision},origin);void this.sync();return result;
  }
  let normalized:Record<string,unknown>={...request};
  if(typeof request.command==='string')normalized.command=JSON.stringify(this.normalizeReferences(JSON.parse(request.command)));
  normalized=this.normalizeReferences(normalized) as Record<string,unknown>;
  const call=workHttp(WorkRequestSchema.parse(normalized));
  try{return await this.call(call.path,call.body,call.key,session);}catch(error){if(accountFor(session)===this.active)this.failure=error instanceof Error?error.message:'CLOUD_WAITING_FOR_SERVER';throw error;}
 }
 private async mergedJournal(request:{route:string;[key:string]:unknown},origin:string){
  const isMaterials=request.route==='materials.list';
  const local:Entry[]=[];let cursor:string|null='0';
  do{
   const page=await this.agent.journal.work({...request,cursor},origin) as {items?:Entry[];materials?:Entry[];next_cursor:string|null};
   local.push(...(isMaterials?page.materials!:page.items!));cursor=page.next_cursor;
  }while(cursor&&local.length<10000);
  // Keep canonical server IDs wherever synced, so documents, events and corrections
  // all refer to the same evidence. The local-original bridge resolves the alias.
  const owned=new Map(this.agent.db.prepare('SELECT id,revision_id FROM cloud_delivery WHERE account=?').all(this.active).map(row=>[String(row.id),String(row.revision_id)]));
  for(const item of local){const native=this.nativeMapping(item.id,'id');if(native)owned.set(item.id,native.revision_id);}
  const cache=this.entries();const cachedIds=new Set(cache.map(e=>e.id));
  const localItems:Entry[]=local.filter(e=>!owned.has(e.id)||!cachedIds.has(owned.get(e.id)!)).map(e=>({...e,...(owned.has(e.id)?{id:owned.get(e.id)!,local_id:e.id}:{}),original_available:true}));
  const cloud=cache.filter(e=>(!request.project_id||e.project_id===request.project_id)&&(!request.category||e.categories.includes(String(request.category)))&&(!request.q||(/^\d{4}-\d{2}-\d{2}$/.test(String(request.q))?new Date(e.received_at).toLocaleDateString('sv-SE',{timeZone:'Asia/Seoul'})===request.q:JSON.stringify(e).toLocaleLowerCase().includes(String(request.q).toLocaleLowerCase())))).map(e=>({...e,original_available:!!this.mapping(e.id,'revision_id'),...(isMaterials?{title:e.file_name??e.title??e.excerpt,status:e.parse_status??'complete',job_state:null,created_at:e.received_at,processed_at:e.received_at,sha256:e.sha256??'',processor_version:'shared',organization_state:e.project_id?'linked':'unassigned',matched_text:e.excerpt}:{})}));
  const items:Entry[]=[...localItems,...cloud];items.sort((a,b)=>String(b.received_at??b.created_at).localeCompare(String(a.received_at??a.created_at))||String(a.id).localeCompare(String(b.id)));
  // Work cursors are UUIDs. The last displayed ID works for both local and server entries.
  const prior=typeof request.cursor==='string'?items.findIndex(e=>e.id===request.cursor):-1;
  const offset=prior<0?0:prior+1,page=items.slice(offset,offset+50);
  return {[isMaterials?'materials':'items']:page,next_cursor:items.length>offset+50?page.at(-1)?.id??null:null,partial:!!this.failure,sync_status:this.info().status};
 }
}
