import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { organizeEvidence, categories as categoryIds } from '../../../packages/domain/src/organization.js';
import type { LocalAgent, LocalDocument } from './agent.js';
import { LocalPhotos } from './photos.js';

export const categoryLabels: Record<string,string> = {agreement:'약속',drawing_material:'도면·자재',delivery_work:'납품·작업',billing_payment:'청구·지급',inspection_defect:'점검·하자'};
const escapeHtml = (v:string) => v.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
// biome-ignore lint/suspicious/noControlCharactersInRegex: Windows filenames exclude control characters.
const label = (v:string) => v.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/,'').slice(0,70) || '현장 확인 전';
export const mimeFor = (ext:string) => ({'.pdf':'application/pdf','.txt':'text/plain','.csv':'text/csv','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.heic':'image/heic','.mp3':'audio/mpeg','.m4a':'audio/mp4','.wav':'audio/wav','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}[ext] ?? 'application/octet-stream');
type Indexed = LocalDocument & {received_at:string;baseline:number;categories:string;duplicate_of:string|null};

/** The reception journal is derived from the same durable document rows as search. */
export class LocalJournal {
  readonly outputRoot: string;
  readonly photos: LocalPhotos;
  constructor(private readonly agent: LocalAgent) {
    const db = agent.db;
    const columns = new Set(db.prepare('PRAGMA table_info(documents)').all().map(r=>String(r.name)));
    for (const [name,definition] of [['received_at',"TEXT NOT NULL DEFAULT ''"],['baseline','INTEGER NOT NULL DEFAULT 1'],['categories',"TEXT NOT NULL DEFAULT '[]'"],['duplicate_of','TEXT']] as const)
      if (!columns.has(name)) db.exec(`ALTER TABLE documents ADD COLUMN ${name} ${definition}`);
    db.exec(`CREATE TABLE IF NOT EXISTS local_projects(id TEXT PRIMARY KEY,display_name TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS local_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS document_reception ON documents(baseline,received_at);`);
    // Existing unprocessed inventory is metadata, never an implicit request to read all history.
    db.prepare("UPDATE documents SET status='indexed' WHERE baseline=1 AND received_at='' AND status='pending'").run();
    this.outputRoot = path.join(agent.dataDir,'자료 정리');
    this.photos=new LocalPhotos(agent);
  }
  private allProjects() { return this.agent.db.prepare('SELECT id,display_name FROM local_projects ORDER BY display_name').all() as {id:string;display_name:string}[]; }
  projects() { const projects=this.allProjects();return this.agent.cloud?.projects(projects)??projects; }
  private project(name:string) {
    const clean=label(name);const created=this.agent.db.prepare('INSERT OR IGNORE INTO local_projects VALUES(?,?)').run(randomUUID(),clean);
    const project=this.allProjects().find(p=>p.display_name===clean)!;if(created.changes)this.agent.cloud?.bindProject(project.id);return project;
  }
  classify(id:string) {
    const doc=this.agent.document(id) as Indexed;
    const text=[doc.name,doc.relative_dir,doc.excerpt].join('\n');
    const manual=this.agent.db.prepare('SELECT kind FROM document_site_origins WHERE document_id=?').get(id)?.kind==='manual';
    let site=doc.site;
    if (!site) {
      const matched=this.projects().filter(p=>text.includes(p.display_name));
      if(matched.length===1) site=matched[0]!.display_name;
      else if(matched.length===0) {
        const folders=doc.relative_dir.split(/[\\/]/).filter(v=>/현장|공사|아파트|빌라|병원/.test(v));
        const fromName=doc.name.match(/^(.{2,50}?(?:현장|공사|아파트|빌라|병원))(?=[_\s.\-]|$)/)?.[1];
        const fromContent=[...doc.excerpt.matchAll(/(?:^|\n)\s*(?:현장명|현장|공사명|프로젝트)\s*[:：]\s*([^\n]{2,50})/g)].map(m=>m[1]!.trim());
        const candidates=[...new Set([...folders,...(fromName?[fromName]:[]),...fromContent])];
        if(candidates.length===1) site=this.project(candidates[0]!).display_name;
      }
    }
    if(site) this.project(site);
    const projects=this.allProjects();
    const result=organizeEvidence({tenantId:'local',revisionId:id,spans:[{text:doc.name,locator:'filename'},{text:doc.relative_dir,locator:'path'},...doc.excerpt.split('\n').filter(Boolean).map((text,i)=>({text,locator:`text:${i}`}))],projects,bindings:site?[{project_id:projects.find(p=>p.display_name===site)!.id,scope_mode:'project'}]:[],bundles:[]});
    const tags=[...result.categories];
    if(!tags.length && /\.(jpe?g|png|webp|heic)$/i.test(doc.ext)) tags.push('delivery_work');
    if(!tags.length && /거래명세/.test(text)) tags.push('billing_payment');
    const category=tags.map(c=>categoryLabels[c]).join(' · ') || '분류 확인 전';
    this.agent.db.prepare('UPDATE documents SET site=?,categories=?,category=? WHERE id=?').run(site,JSON.stringify(tags),category,id);
    if(site&&!manual) this.agent.db.prepare("INSERT OR REPLACE INTO document_site_origins VALUES(?,'automatic')").run(id);
    if(doc.hash) {
      const existing=this.agent.db.prepare("SELECT id,available FROM documents WHERE hash=? AND id<>? AND duplicate_of IS NULL AND status IN ('complete','partial','encrypted','unsupported') ORDER BY available DESC,baseline,received_at LIMIT 1").get(doc.hash,id);
      if(existing&&!existing.available) {
        // A rename keeps the original journal identity/date and points it at the
        // newly discovered path. The transient scan row is retained as an alias.
        this.agent.db.exec('BEGIN IMMEDIATE');
        try {
          this.agent.db.prepare('UPDATE documents SET relative_path=?,available=0,duplicate_of=? WHERE id=?').run(`.sigongnote-alias/${id}`,String(existing.id),id);
          this.agent.db.prepare('UPDATE documents SET source_id=?,relative_path=?,relative_dir=?,name=?,ext=?,size=?,mtime=?,available=1 WHERE id=?').run(doc.source_id,doc.relative_path,doc.relative_dir,doc.name,doc.ext,doc.size,doc.mtime,String(existing.id));
          this.agent.db.exec('COMMIT');
        } catch(error){this.agent.db.exec('ROLLBACK');throw error;}
      } else this.agent.db.prepare('UPDATE documents SET duplicate_of=? WHERE id=?').run(existing?String(existing.id):null,id);
    }
  }
  status() {
    const rows=(this.agent.db.prepare('SELECT * FROM documents WHERE available=1').all() as unknown as Indexed[]).filter(row=>(this.agent.cloud?.visible(row.id)??true)&&!this.agent.cloud?.nativeRecording(row));
    return {total:rows.filter(row=>!row.duplicate_of).length,pending:rows.filter(row=>['pending','reading'].includes(String(row.status))).length,source_count:this.agent.sources().filter(s=>s.enabled).length,last_scan:this.agent.sources().map(s=>s.last_scan).filter(Boolean).sort().at(-1)??null,discovering:this.agent.progress.phase!=='idle',baseline_count:rows.filter(row=>row.baseline===1).length,output_root:this.outputRoot};
  }
  organizeHistory() {
    const rows=(this.agent.db.prepare('SELECT * FROM documents WHERE baseline=1 AND available=1').all() as unknown as Indexed[]).filter(row=>(this.agent.cloud?.visible(row.id)??true)&&!this.agent.cloud?.nativeRecording(row));
    const update=this.agent.db.prepare("UPDATE documents SET baseline=0,received_at=CASE WHEN received_at='' THEN ? ELSE received_at END,status=CASE WHEN status='indexed' THEN 'pending' ELSE status END WHERE id=?");
    for(const row of rows)update.run(new Date().toISOString(),String(row.id));return {queued:rows.length};
  }
  rows(filter:{project_id?:string;q?:string;category?:string;cursor?:string}={}, journal=false,limit=50) {
    const project=filter.project_id?this.projects().find(p=>p.id===filter.project_id)?.display_name:undefined;
    const offset=Math.max(0,Number(filter.cursor)||0);
    let rows=this.agent.db.prepare(`SELECT d.* FROM documents d JOIN sources s ON s.id=d.source_id WHERE s.enabled=1 AND d.available=1 AND d.duplicate_of IS NULL ${journal?'AND d.baseline=0':''} ORDER BY d.received_at DESC,d.mtime DESC,d.id`).all() as unknown as Indexed[];
    if(this.agent.cloud)rows=rows.filter(d=>this.agent.cloud!.visible(d.id)&&!this.agent.cloud!.nativeRecording(d));
    if(filter.project_id) rows=rows.filter(d=>d.site===project);
    if(filter.category) rows=rows.filter(d=>(JSON.parse(d.categories) as string[]).includes(filter.category!));
    if(filter.q) rows=rows.filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(filter.q!)?new Date(d.received_at).toLocaleDateString('sv-SE',{timeZone:'Asia/Seoul'})===filter.q:[d.name,d.excerpt,d.site,d.relative_path].join(' ').toLocaleLowerCase().includes(filter.q!.toLocaleLowerCase()));
    return {rows:rows.slice(offset,offset+limit),next_cursor:rows.length>offset+limit?String(offset+limit):null};
  }
  async work(request: {route:string;[key:string]:unknown}, origin:string):Promise<unknown|undefined> {
    const route=request.route;
    const filter={...(typeof request.project_id==='string'?{project_id:request.project_id}:{}),...(typeof request.q==='string'?{q:request.q}:{}),...(typeof request.category==='string'?{category:request.category}:{}),...(typeof request.cursor==='string'?{cursor:request.cursor}:{})};
    const projectId=(site:string|null)=>this.projects().find(p=>p.display_name===site)?.id??null;
    if(typeof request.id==='string'&&['materials.detail','materials.original','organization.answer'].includes(route))this.agent.cloud?.assertVisible(request.id);
    if(route==='context') return {user_id:'00000000-0000-4000-8000-000000000001',tenant_id:'00000000-0000-4000-8000-000000000002',company:'내 업무자료',local:true,can_resolve_site:true,projects:this.projects(),setup:{project_id:null,version:1,dismissed:true,completed:true}};
    if(route==='journal.list') { const result=this.rows({...filter,cursor:'0'},true,Number.MAX_SAFE_INTEGER);const documents=result.rows.map(d=>({id:d.id,title:d.name,organization_version:d.revision,received_at:d.received_at,occurred_at:null,source_kind:/^image/.test(mimeFor(d.ext))?'photos':'local_file',declared_mime:mimeFor(d.ext),project_id:projectId(d.site),project_name:d.site,categories:JSON.parse(d.categories),excerpt:d.excerpt.slice(0,2000)||d.name,reading_state:d.status,parse_status:d.status,observations:[]}));const sheets=(await this.photos.journalEntries()).filter(d=>(!filter.project_id||d.project_id===filter.project_id)&&(!filter.category||d.categories.includes(filter.category))&&(!filter.q||(/^\d{4}-\d{2}-\d{2}$/.test(filter.q)?new Date(d.received_at).toLocaleDateString('sv-SE',{timeZone:'Asia/Seoul'})===filter.q:JSON.stringify(d).includes(filter.q))));const items=[...documents,...sheets].sort((a,b)=>b.received_at.localeCompare(a.received_at)||a.id.localeCompare(b.id));const offset=Math.max(0,Number(filter.cursor)||0);return {items:items.slice(offset,offset+50),next_cursor:items.length>offset+50?String(offset+50):null}; }
    if(route==='materials.list') {const result=this.rows(filter);return {materials:result.rows.map(d=>({id:d.id,title:d.name,status:d.status,job_state:d.status==='pending'?'queued':null,project_name:d.site,project_id:projectId(d.site),created_at:d.received_at||new Date(d.mtime).toISOString(),processed_at:d.hash?d.received_at:null,sha256:d.hash??'',processor_version:'local-v1',categories:JSON.parse(d.categories),organization_state:d.site?'linked':'unassigned',organization_version:d.revision,matched_text:d.excerpt.slice(0,220)})),next_cursor:result.next_cursor};}
    if(route==='materials.detail') {const d=this.agent.document(String(request.id)) as Indexed;return {revision:{id:d.id,revision_number:d.revision,status:d.status,declared_mime:mimeFor(d.ext)},organization:{state:d.site?'linked':'unassigned',version:d.revision,categories:JSON.parse(d.categories)},result:d.hash?{created_at:d.received_at,processor_version:'local-v1',output:JSON.parse(d.parsed)}:null};}
    if(route==='materials.original') {const file=await this.agent.sourcePath(this.agent.document(String(request.id)));if(process.platform==='win32'){await promisify(execFile)('explorer.exe',[file],{windowsHide:true,timeout:15000});return {opened:true};}return {url:`${origin}/local-original/${String(request.id)}`};}
    if(route==='organization.answer') {const d=this.agent.document(String(request.id));const p=this.projects().find(p=>p.id===request.project_id);if(!p)throw new Error('INVALID_PROJECT');if(d.revision!==request.version)throw new Error('STALE_DOCUMENT');this.agent.db.prepare('UPDATE documents SET site=? WHERE id=?').run(p.display_name,d.id);this.agent.db.prepare("INSERT OR REPLACE INTO document_site_origins VALUES(?,'manual')").run(d.id);this.classify(d.id);await this.publish();return {saved:true};}
    if(route==='guide.read')return {step:2,completed:true};
    if(route==='guide.save')return {saved:true};
    if(['journal.tasks','agenda.read','documents.list','questions.list','ledger.list','activity.status'].includes(route))throw new Error('CLOUD_LOGIN_REQUIRED');
    if(route==='capture.status')return {sources:[],local:this.status()};
    if(route==='archive.status')return {local:true,...this.status()};
    if(route==='setup.read')return {project_id:null,version:1,dismissed:true,completed:true,projects:this.projects(),documents:[]};
    if(route==='setup.command') {const command=JSON.parse(String(request.command)) as {action:string;display_name?:string;project_id?:string};if(command.action==='select'){const p=command.display_name?this.project(command.display_name):this.projects().find(p=>p.id===command.project_id);if(!p)throw new Error('INVALID_PROJECT');return {project_id:p.id,version:1,dismissed:true,completed:true};}if(['complete','dismiss'].includes(command.action))return {project_id:null,version:1,dismissed:true,completed:true};throw new Error('INVALID_LOCAL_COMMAND');}
    const photoResult=await this.photos.work(request);if(photoResult!==undefined)return photoResult;
    return undefined;
  }
  async publish() {
    await mkdir(this.outputRoot,{recursive:true});
    if((await lstat(this.outputRoot)).isSymbolicLink())throw new Error('MANAGED_FOLDER_CHANGED');
    const marker=path.join(this.outputRoot,'sigongnote-generated.json');
    try{await writeFile(marker,JSON.stringify({local:true,version:1}),{flag:'wx'});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    type FilingEntry=Pick<Indexed,'relative_path'|'name'|'received_at'|'site'|'category'|'categories'>&{root:string};
    const rows:FilingEntry[]=(this.agent.db.prepare('SELECT d.*,s.root FROM documents d JOIN sources s ON s.id=d.source_id WHERE s.enabled=1 AND d.available=1 AND d.duplicate_of IS NULL AND d.baseline=0 ORDER BY d.received_at DESC').all() as unknown as (FilingEntry&{id:string})[]).filter(d=>this.agent.cloud?.visible(d.id)??true);
    for(const sheet of await this.photos.journalEntries()) {
      const file=this.agent.db.prepare("SELECT file_path FROM local_photo_sheets WHERE id=? AND state='succeeded'").get(sheet.id)?.file_path;
      if(!file)continue;
      try{const info=await lstat(String(file));if(!info.isFile()||info.isSymbolicLink())continue;}catch{continue;}
      rows.push({root:path.dirname(String(file)),relative_path:path.basename(String(file)),name:`${sheet.excerpt}.pdf`,received_at:sheet.received_at,site:sheet.project_name,category:'납품·작업',categories:JSON.stringify(sheet.categories)});
    }
    rows.sort((a,b)=>b.received_at.localeCompare(a.received_at)||a.name.localeCompare(b.name));
    const groups=new Map<string,FilingEntry[]>();
    for(const d of rows){const tags=JSON.parse(d.categories) as string[];for(const tag of tags.length?tags:['unassigned']){const key=path.join(label(d.site??'현장 확인 전'),categoryLabels[tag]??'분류 확인 전');groups.set(key,[...(groups.get(key)??[]),d]);}}
    const priorGroups=this.agent.db.prepare("SELECT value FROM local_settings WHERE key='published_groups'").get()?.value;
    if(priorGroups)for(const key of JSON.parse(String(priorGroups)) as string[])if(!groups.has(key))groups.set(key,[]);
    const documentHtml=(title:string,docs:typeof rows)=>`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:17px/1.7 system-ui;max-width:960px;margin:40px auto;padding:0 24px;color:#183029}a{color:#185f4a}li{margin:12px 0}small{color:#65756e}</style><h1>${escapeHtml(title)}</h1><ul>${docs.map(d=>`<li><a href="${escapeHtml(pathToFileURL(path.join(d.root,d.relative_path)).href)}">${escapeHtml(d.name)}</a> <small>${escapeHtml(new Date(d.received_at).toLocaleDateString('sv-SE',{timeZone:'Asia/Seoul'}))} · ${escapeHtml(d.site??'현장 확인 전')} · ${escapeHtml(d.category)}</small></li>`).join('')}</ul></html>`;
    const outputs=new Map<string,string>([['업무일지.html',documentHtml('업무일지',rows)]]);
    for(const [directory,docs] of groups)outputs.set(path.join(directory,'자료목록.html'),documentHtml(directory,docs));
    for(const [relative,body] of outputs){const target=path.join(this.outputRoot,relative);await mkdir(path.dirname(target),{recursive:true});let cursor=path.dirname(target);while(cursor!==this.outputRoot){if((await lstat(cursor)).isSymbolicLink())throw new Error('MANAGED_FOLDER_CHANGED');cursor=path.dirname(cursor);}try{if((await lstat(target)).isSymbolicLink())throw new Error('MANAGED_FOLDER_CHANGED');if(await readFile(target,'utf8')===body)continue;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}const temp=`${target}.${randomUUID()}.tmp`;await writeFile(temp,body,{flag:'wx'});await rename(temp,target);}
    this.agent.db.prepare("INSERT OR REPLACE INTO local_settings VALUES('published_groups',?)").run(JSON.stringify([...groups.keys()]));
  }
}
