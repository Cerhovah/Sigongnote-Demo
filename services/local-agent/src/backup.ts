import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {backup,DatabaseSync} from 'node:sqlite';
import type {LocalAgent} from './agent.js';
import {sha256} from './agent.js';
import type {CopyProtection} from './protection.js';
export class LocalBackup {
 private references(db:DatabaseSync){return db.prepare("SELECT hash,ext FROM documents WHERE hash IS NOT NULL UNION SELECT r.hash,d.ext FROM revisions r JOIN documents d ON d.id=r.document_id ORDER BY hash,ext").all().map(r=>{const hash=String(r.hash),ext=String(r.ext);if(!/^[a-f0-9]{64}$/.test(hash)||!/^\.[a-z0-9]+$/.test(ext))throw new Error('BACKUP_INVALID');return {hash,ext};});}
 private busy=false;
 constructor(private readonly agent:LocalAgent,private readonly protection:CopyProtection){}
 async create(){
  if(this.busy)throw new Error('BACKUP_BUSY');this.busy=true;
  const id=randomUUID(),folder=path.join(this.agent.dataDir,'backups');
  const temporary=path.join(folder,`${id}.sqlite`),target=path.join(folder,`${id}.sgnbackup`);
  try{
   await mkdir(folder,{recursive:true});
   await backup(this.agent.db,temporary);
   const check=new DatabaseSync(temporary,{readOnly:true});let counts:{documents:number;revisions:number};let refs:{hash:string;ext:string}[];
   try{if(check.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')throw new Error('BACKUP_INVALID');
    counts={documents:Number(check.prepare('SELECT count(*) n FROM documents').get()?.n),revisions:Number(check.prepare('SELECT count(*) n FROM revisions').get()?.n)};refs=this.references(check);
   }finally{check.close();}
   const copies=path.join(folder,id);await mkdir(copies);
   const missing:{hash:string;ext:string;reason:string}[]=[];
   for(const ref of refs){
    let sealed:Buffer;
    try{sealed=await readFile(this.agent.copyPath(ref.hash,ref.ext));if(sha256(this.protection.decrypt(sealed))!==ref.hash)throw new Error('BACKUP_SOURCE_INVALID');}
    catch{missing.push({...ref,reason:'source_unavailable_or_invalid'});continue;}
    await writeFile(path.join(copies,ref.hash+ref.ext),sealed,{flag:'wx',mode:0o600});
   }
   const raw=await readFile(temporary);await writeFile(target,this.protection.encrypt(raw),{flag:'wx',mode:0o600});
   const manifest={id,version:2,createdAt:new Date().toISOString(),sha256:sha256(raw),counts,sourceCount:refs.length,archivedCount:refs.length-missing.length,missing,status:missing.length?'incomplete':'complete',scope:'device_index_and_available_referenced_copies',restoreRequires:'same Windows account and DPAPI key; server and native client queues separately'};
   await writeFile(path.join(folder,`${id}.json`),JSON.stringify(manifest),{flag:'wx',mode:0o600});return manifest;
  }finally{await unlink(temporary).catch(()=>{});this.busy=false;}
 }
 async verify(id:string){
  if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('BACKUP_INVALID');
  const folder=path.join(this.agent.dataDir,'backups'),manifest=JSON.parse(await readFile(path.join(folder,`${id}.json`),'utf8'));
  const bytes=this.protection.decrypt(await readFile(path.join(folder,`${id}.sgnbackup`)));if(sha256(bytes)!==manifest.sha256)throw new Error('BACKUP_INVALID');
  const separate=path.join(folder,`${randomUUID()}.restore.sqlite`);await writeFile(separate,bytes,{flag:'wx',mode:0o600});
  try{const db=new DatabaseSync(separate,{readOnly:true});try{
   if(db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok'||Number(db.prepare('SELECT count(*) n FROM documents').get()?.n)!==manifest.counts.documents||Number(db.prepare('SELECT count(*) n FROM revisions').get()?.n)!==manifest.counts.revisions)throw new Error('BACKUP_INVALID');
   const refs=this.references(db);
   if(manifest.version!==2||refs.length!==manifest.sourceCount)throw new Error('BACKUP_LEGACY_INDEX_ONLY');
   const missing=manifest.missing??[];
   if(!Array.isArray(missing))throw new Error('BACKUP_INVALID');
   const absent=new Set<string>();
   for(const item of missing){if(!refs.some(r=>r.hash===item.hash&&r.ext===item.ext)||absent.has(item.hash+item.ext))throw new Error('BACKUP_INVALID');absent.add(item.hash+item.ext);}
   for(const ref of refs){if(absent.has(ref.hash+ref.ext))continue;const raw=this.protection.decrypt(await readFile(path.join(folder,id,ref.hash+ref.ext)));if(sha256(raw)!==ref.hash)throw new Error('BACKUP_SOURCE_MISSING');}
   return {integrity:'ok',status:absent.size?'incomplete':'complete',missingCount:absent.size,counts:manifest.counts,sourceReferencesChecked:refs.length-absent.size,expectedReferences:refs.length,scope:'index_and_available_copies_restore_same_key',crossDeviceVerified:false};
  }finally{db.close();}}finally{await unlink(separate);}
 }
 async read(id:string){if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('BACKUP_INVALID');return readFile(path.join(this.agent.dataDir,'backups',`${id}.sgnbackup`));}
}
