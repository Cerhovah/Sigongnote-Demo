import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,lstat,readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createFieldLedgerSnapshot,mergeFieldLedgerBundles,parseFieldLedgerBundle,type FieldLedgerBundle,type FieldLedgerSnapshot} from '../../packages/domain/src/field-ledger.js';
import {importLedgerCsv,LedgerCsvError} from './csv.js';

export type SourceReference={path?:string;text?:string;sha256:string;mime?:string;downloadName?:string};
type ImportState={version:1;bundle:FieldLedgerBundle;sources:Record<string,SourceReference>;imports:Record<string,string[]>;incoming:Record<string,string>};
export type LedgerQuery={projectId?:string|null;from?:string|null;to?:string|null;search?:string;attribution?:'assigned'|'review'|'all'};
export class DemoFault extends Error {constructor(public readonly code:string,public readonly statusCode=400){super(code);}}
const empty=():FieldLedgerBundle=>({schemaVersion:1,projects:[],sources:[],records:[]});
const withoutUrls=(bundle:FieldLedgerBundle):FieldLedgerBundle=>({...bundle,sources:bundle.sources.map(source=>({...source,url:null}))});
export const digest=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const within=(root:string,file:string)=>{const relative=path.relative(root,file);return relative!==''&&!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative);};
const mimeFor=(name:string)=>({'.txt':'text/plain;charset=utf-8','.csv':'text/csv;charset=utf-8','.json':'application/json;charset=utf-8','.pdf':'application/pdf','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}[path.extname(name).toLowerCase()]??'application/octet-stream');
const safeName=(name:string)=>[...path.basename(name.replaceAll('\\','/'))].filter(character=>character.charCodeAt(0)>=32&&character.charCodeAt(0)!==127).join('').slice(0,180)||'자료';
async function readJson(file:string,fallback:unknown){try{return JSON.parse(await readFile(file,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return fallback;throw new DemoFault('PRIVATE_DATA_INVALID',422);}}
async function atomic(file:string,value:unknown){const tmp=`${file}.${randomUUID()}.tmp`;await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});await rename(tmp,file);}
async function assertOutsideGit(directory:string){
 let existing=directory;
 for(;;){try{await lstat(existing);break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const parent=path.dirname(existing);if(parent===existing)throw error;existing=parent;}}
 const resolved=path.resolve(await realpath(existing),path.relative(existing,directory));
 for(let cursor=resolved;;cursor=path.dirname(cursor)){
  try{await lstat(path.join(cursor,'.git'));throw new DemoFault('PRIVATE_DIRECTORY_IN_GIT');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(path.dirname(cursor)===cursor)break;
 }
}

/** Private local store. It never modifies files from the source registry or incoming folder. */
export class DemoStore {
 readonly dataDir:string;
 private queue:Promise<unknown>=Promise.resolve();
 private state:ImportState={version:1,bundle:empty(),sources:{},imports:{},incoming:{}};
 private base:FieldLedgerBundle=empty();
 private references:Record<string,SourceReference>={};
 constructor(dataDir:string){this.dataDir=path.resolve(dataDir);}
 async initialize(){
  await assertOutsideGit(this.dataDir);
  await mkdir(this.dataDir,{recursive:true});
  if((await lstat(this.dataDir)).isSymbolicLink())throw new DemoFault('PRIVATE_DIRECTORY_SYMLINK');
  for(const directory of ['imported','snapshots','incoming']){const target=path.join(this.dataDir,directory);await mkdir(target,{recursive:true});if((await lstat(target)).isSymbolicLink())throw new DemoFault('PRIVATE_DIRECTORY_SYMLINK');}
  const saved=await readJson(path.join(this.dataDir,'import-state.json'),null) as ImportState|null;
  if(saved){if(saved.version!==1||!saved.sources||!saved.imports||!saved.incoming)throw new DemoFault('PRIVATE_DATA_INVALID',422);this.state={...saved,bundle:withoutUrls(parseFieldLedgerBundle(saved.bundle))};}
  await this.refresh();return this;
 }
 private serial<T>(operation:()=>Promise<T>):Promise<T>{const result=this.queue.then(operation);this.queue=result.catch(()=>undefined);return result;}
 private async reload(){
  this.base=withoutUrls(parseFieldLedgerBundle(await readJson(path.join(this.dataDir,'bundle.json'),empty())));
  const registry=await readJson(path.join(this.dataDir,'source-paths.json'),{}) as Record<string,SourceReference>;
  if(!registry||typeof registry!=='object'||Array.isArray(registry))throw new DemoFault('PRIVATE_DATA_INVALID',422);
  this.references={...registry,...this.state.sources};
 }
 private current():FieldLedgerBundle{
  const bundle=mergeFieldLedgerBundles(this.base,this.state.bundle);
  return {...bundle,sources:bundle.sources.map(source=>({...source,url:this.references[source.id]?`/api/sources/${encodeURIComponent(source.id)}`:null}))};
 }
 async refresh(){return this.serial(async()=>{await this.reload();return this.current();});}
 async snapshot(query:LedgerQuery={}):Promise<FieldLedgerSnapshot>{return this.serial(async()=>{
  await this.reload();const snapshot=await createFieldLedgerSnapshot(this.current(),query);
  const filename=path.join(this.dataDir,'snapshots',snapshot.id+'.json');
  const existing=await readJson(filename,null) as FieldLedgerSnapshot|null;
  if(existing)return existing;
  await writeFile(filename,JSON.stringify(snapshot,null,2)+'\n',{flag:'wx',mode:0o600});return snapshot;
 });}
 async savedSnapshot(id:string):Promise<FieldLedgerSnapshot>{
  if(!/^[a-f0-9]{64}$/.test(id))throw new DemoFault('SNAPSHOT_NOT_FOUND',404);
  const snapshot=await readJson(path.join(this.dataDir,'snapshots',id+'.json'),null) as FieldLedgerSnapshot|null;
  if(!snapshot||snapshot.id!==id)throw new DemoFault('SNAPSHOT_NOT_FOUND',404);return snapshot;
 }
 async source(id:string){
  await this.refresh();const source=this.current().sources.find(s=>s.id===id),reference=this.references[id];
  if(!source||!reference||!/^[a-f0-9]{64}$/.test(reference.sha256))throw new DemoFault('SOURCE_NOT_FOUND',404);
  let bytes:Buffer;
  if(typeof reference.text==='string')bytes=Buffer.from(reference.text);
  else if(typeof reference.path==='string'){
   const absolute=path.resolve(reference.path);
   try{const stat=await lstat(absolute);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>64*1024*1024)throw new DemoFault('SOURCE_UNAVAILABLE',409);bytes=await readFile(absolute);}catch(error){if(error instanceof DemoFault)throw error;throw new DemoFault('SOURCE_UNAVAILABLE',409);}
  }else throw new DemoFault('SOURCE_NOT_FOUND',404);
  if(digest(bytes)!==reference.sha256)throw new DemoFault('SOURCE_CHANGED',409);
  return {bytes,name:safeName(reference.downloadName??source.label),mime:reference.mime??mimeFor(source.label),sha256:reference.sha256};
 }
 async importFile(name:string,bytes:Buffer,projectId:string|null){return this.serial(async()=>{
  await this.reload();return this.importUnlocked(name,bytes,projectId);
 });}
 private async importUnlocked(rawName:string,bytes:Buffer,projectId:string|null){
  if(!bytes.length||bytes.length>16*1024*1024)throw new DemoFault('FILE_SIZE',413);
  const current=this.current();if(projectId!==null&&!current.projects.some(p=>p.id===projectId))throw new DemoFault('PROJECT_NOT_FOUND',404);
  const sha=digest(bytes),prior=this.state.imports[sha];if(prior)return {recordIds:prior,duplicate:true};
  const name=safeName(rawName),sourceId=`source-${sha}`,recordId=`receipt-${sha}`;
  const target=path.join(this.dataDir,'imported',sha+path.extname(name).toLowerCase().replace(/[^.a-z0-9]/g,''));
  if(!within(path.join(this.dataDir,'imported'),target))throw new DemoFault('INVALID_FILE');
  const now=new Date().toISOString();
  let incoming:FieldLedgerBundle|null=null;
  if(path.extname(name).toLowerCase()==='.csv'){
   try{incoming=importLedgerCsv(bytes,current,{id:sourceId,kind:'file',label:name,sha256:sha,url:`/api/sources/${sourceId}`,version:1},projectId);}catch(error){if(error instanceof LedgerCsvError)throw new DemoFault(error.code,422);throw error;}
  }
  if(path.extname(name).toLowerCase()==='.json'){
   let parsed:unknown;try{parsed=JSON.parse(bytes.toString('utf8'));}catch{throw new DemoFault('JSON_INVALID',422);}
   if(parsed&&typeof parsed==='object'&&'schemaVersion' in parsed){
    try{incoming=parseFieldLedgerBundle(parsed);}catch{throw new DemoFault('LEDGER_BUNDLE_INVALID',422);}
    incoming={...incoming,sources:[...incoming.sources,{id:sourceId,kind:'file',label:name,sha256:sha,url:`/api/sources/${sourceId}`,version:1}],records:incoming.records.map(r=>{
     const priorRecord=current.records.find(previous=>previous.id===r.id);
     return priorRecord&&(priorRecord.revision??1)>=(r.revision??1)?r:{...r,sourceIds:[...new Set([...r.sourceIds,sourceId])],sourceVersions:{...r.sourceVersions,[sourceId]:1}};
    })};
   }else throw new DemoFault('LEDGER_BUNDLE_INVALID',422);
  }else if(incoming===null){
   incoming={schemaVersion:1,projects:current.projects.filter(p=>p.id===projectId),sources:[{id:sourceId,kind:'file',label:name,sha256:sha,url:`/api/sources/${sourceId}`,version:1}],records:[{id:recordId,projectId,projectName:current.projects.find(p=>p.id===projectId)?.name??null,occurredAt:null,receivedAt:now,type:'기타',party:null,item:null,quantity:null,amountMinor:null,request:`자료 접수: ${name}`,change:null,status:'접수',attribution:projectId?'assigned':'review',confirmation:'recorded',nextAction:null,previousIds:[],sourceIds:[sourceId],updatedAt:now,origin:'journal',revision:1,sourceVersions:{[sourceId]:1},transactionKey:null,supersedes:null}]};
  }
  incoming={...incoming,records:incoming.records.map(record=>{
   const previous=current.records.find(candidate=>candidate.id===record.id);
   if(!previous)return {...record,receivedAt:record.receivedAt??now};
   if((record.revision??1)>(previous.revision??1))return {...record,receivedAt:record.receivedAt??previous.receivedAt};
   return record;
  })};
  let nextBundle:FieldLedgerBundle;try{nextBundle=mergeFieldLedgerBundles(withoutUrls(current),withoutUrls(incoming));}catch{throw new DemoFault('LEDGER_VERSION_CONFLICT',409);}
  // Parse every recognized row and resolve versions before making any durable mutation.
  try{await writeFile(target,bytes,{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;if(digest(await readFile(target))!==sha)throw new DemoFault('SOURCE_CHANGED',409);}
  const recordIds=incoming.records.map(r=>r.id);
  const next:ImportState={...this.state,bundle:nextBundle,sources:{...this.state.sources,[sourceId]:{path:target,sha256:sha,mime:mimeFor(name),downloadName:name}},imports:{...this.state.imports,[sha]:recordIds}};
  await atomic(path.join(this.dataDir,'import-state.json'),next);this.state=next;this.references={...this.references,...next.sources};
  return {recordIds,duplicate:false};
 }
 async scanIncoming(){return this.serial(async()=>{
  await this.reload();const incomingRoot=path.join(this.dataDir,'incoming');const projects=new Set(this.current().projects.map(p=>p.id));let added=0,failed=0;
  const folders=[{directory:incomingRoot,projectId:null as string|null}];
  for(const item of await readdir(incomingRoot,{withFileTypes:true}))if(item.isDirectory()&&!item.isSymbolicLink()&&projects.has(item.name))folders.push({directory:path.join(incomingRoot,item.name),projectId:item.name});
  for(const folder of folders)for(const item of await readdir(folder.directory,{withFileTypes:true})){
   if(!item.isFile()||item.isSymbolicLink()||item.name.startsWith('.'))continue;
   const file=path.join(folder.directory,item.name),resolved=await realpath(file);if(!within(incomingRoot,resolved))continue;
   const stat=await lstat(file);if(stat.size>16*1024*1024)continue;
   const signature=`${stat.size}:${stat.mtimeMs}`,key=path.relative(incomingRoot,file);if(this.state.incoming[key]===signature)continue;
   try{const bytes=await readFile(file);const result=await this.importUnlocked(item.name,bytes,folder.projectId);this.state={...this.state,incoming:{...this.state.incoming,[key]:signature}};await atomic(path.join(this.dataDir,'import-state.json'),this.state);if(!result.duplicate)added++;}catch{failed++;}
  }
  return {added,failed};
 });}
}
