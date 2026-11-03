import {randomUUID,createHash} from 'node:crypto';
import type {LocalAgent} from './agent.js';
import {maskSensitive} from '../../../packages/domain/src/claims.js';
class FieldHttpError extends Error {constructor(message:string,readonly permanent:boolean){super(message);}}
export interface FieldConfig {apiUrl:string;authUrl:string;publishableKey:string;email:string;password:string;tenantId:string;deviceId:string;sources:Record<string,{id:string;generation:number}>;telemetryConsentVersion:1}
export class FieldBridge {
 private access='';private expires=0;private sending=false;private authPending:Promise<string>|undefined;
 readonly sessionId=randomUUID();
 constructor(private readonly agent:LocalAgent,private readonly config:FieldConfig,private readonly request:typeof fetch=fetch){
  for(const value of [config.apiUrl,config.authUrl]){const u=new URL(value);if(u.hostname!=='127.0.0.1'||u.protocol!=='http:'||u.username||u.password)throw new Error('FIELD_LOCAL_ONLY');}
  agent.db.exec(`CREATE TABLE IF NOT EXISTS field_outbox(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',result TEXT,error TEXT,created_at TEXT NOT NULL,UNIQUE(document_id,revision,payload));
   CREATE TABLE IF NOT EXISTS field_event_queue(id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS field_commands(id TEXT PRIMARY KEY,question_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',result TEXT,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS field_attempts(id TEXT PRIMARY KEY,count INTEGER NOT NULL,next_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS field_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
 }
 async login(email:string,password:string){
  const response=await this.request(`${this.config.authUrl}/auth/v1/token?grant_type=password`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{apikey:this.config.publishableKey,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
  if(!response.ok)throw new Error('FIELD_LOGIN_REQUIRED');const data=await response.json() as {access_token:string;expires_in:number};return data;
 }
 private async token(){
  if(this.access&&Date.now()<this.expires)return this.access;
  if(!this.authPending)this.authPending=(async()=>{const r=await this.login(this.config.email,this.config.password);this.access=r.access_token;this.expires=Date.now()+(r.expires_in-60)*1000;return this.access;})().finally(()=>{this.authPending=undefined;});
  return this.authPending;
 }
 async call(route:string,body?:unknown,key?:string,token?:string):Promise<unknown>{
  const response=await this.request(`${this.config.apiUrl}${route}`,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(15000),
   headers:{Authorization:`Bearer ${token??await this.token()}`,'X-Tenant-ID':this.config.tenantId,...(body===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':key??randomUUID()})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok){const data=await response.json().catch(()=>({})) as {error?:{code?:string}};const code=data.error?.code;throw new FieldHttpError(code==='VERSION_CONFLICT'?'FIELD_ANSWER_CHANGED':code==='DOMAIN_INVARIANT'?'FIELD_DOCUMENT_INVALID':response.status===401?'FIELD_LOGIN_REQUIRED':response.status===404?'FIELD_SCOPE_REQUIRED':'FIELD_SERVER_REJECTED',response.status>=400&&response.status<500&&![408,429].includes(response.status));}
  return response.json();
 }
 delivery(id:string){const row=this.agent.db.prepare('SELECT status,error FROM field_outbox WHERE document_id=? ORDER BY created_at DESC LIMIT 1').get(id);return {status:String(row?.status??'missing'),error:row?.error??null};}
 info(){return {configured:true,pending:Number(this.agent.db.prepare("SELECT count(*) n FROM field_outbox WHERE status='pending'").get()?.n??0),
  failed:Number(this.agent.db.prepare("SELECT count(*) n FROM field_outbox WHERE status='failed'").get()?.n??0),
  lastSync:this.agent.db.prepare("SELECT value FROM field_meta WHERE key='last_sync'").get()?.value??null,
  telemetryLost:Number(this.agent.db.prepare("SELECT value FROM field_meta WHERE key='lost'").get()?.value??0)};}
 queue(id:string){
  const d=this.agent.document(id),s=this.agent.source(d.source_id),binding=this.config.sources[s.id];
  if(!s.enabled||!d.hash||!['complete','partial'].includes(d.status)||!binding)throw new Error('FIELD_SCOPE_REQUIRED');
  const spans=(JSON.parse(d.parsed).spans as {locator:string;text:string}[]).slice(0,40).map(x=>({...x,text:maskSensitive(x.text).slice(0,500)}));
  const payload={source_id:binding.id,source_generation:binding.generation,local_document_id:d.id,local_revision:d.revision,sha256:d.hash,byte_length:d.size,
   parser_version:`${JSON.parse(d.parsed).parserVersion}/bridge-v2`.slice(0,80),parse_state:d.status,spans,title:d.category,category:d.category==='돈'?'billing_payment':d.category==='납품'?'delivery_work':'agreement'};
  this.agent.db.prepare('INSERT OR IGNORE INTO field_outbox(id,document_id,revision,payload,created_at) VALUES(?,?,?,?,?)').run(randomUUID(),id,d.revision,JSON.stringify(payload),new Date().toISOString());
 }
 private ready(id:string){return Number(this.agent.db.prepare('SELECT next_at FROM field_attempts WHERE id=?').get(id)?.next_at??0)<=Date.now();}
 private failed(id:string,error:unknown,table:'field_outbox'|'field_commands'){
  const count=Number(this.agent.db.prepare('SELECT count FROM field_attempts WHERE id=?').get(id)?.count??0)+1;
  this.agent.db.prepare('INSERT INTO field_attempts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET count=excluded.count,next_at=excluded.next_at').run(id,count,Date.now()+Math.min(3600000,60000*2**count));
  if((error instanceof FieldHttpError&&error.permanent)||count>=3)this.agent.db.prepare(`UPDATE ${table} SET status=? WHERE id=?`).run(table==='field_commands'?'conflict':'failed',id);
 }
 async flush(){
  if(this.sending)return;this.sending=true;
  try{
   for(const row of this.agent.db.prepare("SELECT * FROM field_outbox WHERE status='pending' ORDER BY created_at LIMIT 10").all()){
    if(!this.ready(String(row.id)))continue;
    const d=this.agent.document(String(row.document_id)),s=this.agent.source(d.source_id),payload=JSON.parse(String(row.payload));
    if(!s.enabled||d.revision!==row.revision||d.hash!==payload.sha256||!['complete','partial'].includes(d.status)){this.agent.db.prepare("UPDATE field_outbox SET status='failed',error='stale' WHERE id=?").run(String(row.id));continue;}
    try{const result=await this.call('/v1/field/captures',payload,String(row.id));this.agent.db.prepare("UPDATE field_outbox SET status='acked',result=?,error=NULL WHERE id=?").run(JSON.stringify(result),String(row.id));}
    catch(error){this.agent.db.prepare('UPDATE field_outbox SET error=? WHERE id=?').run(error instanceof FieldHttpError?error.message:'FIELD_WAITING_FOR_SERVER',String(row.id));this.failed(String(row.id),error,'field_outbox');}
   }
   for(const command of this.agent.db.prepare("SELECT * FROM field_commands WHERE status='pending' ORDER BY created_at LIMIT 10").all()){
    if(!this.ready(String(command.id)))continue;
    try{const result=await this.call(`/v1/field/questions/${command.question_id}/answer`,JSON.parse(String(command.payload)),String(command.id));
     this.agent.db.prepare("UPDATE field_commands SET status='acked',result=? WHERE id=?").run(JSON.stringify(result),String(command.id));
    }catch(error){this.failed(String(command.id),error,'field_commands');}
   }
   const rows=this.agent.db.prepare('SELECT * FROM field_event_queue ORDER BY created_at LIMIT 50').all();
   if(rows.length){const result=await this.call('/v1/field/events',{device_id:this.config.deviceId,events:rows.map(x=>JSON.parse(String(x.payload)))}) as {ack:string[]};
    for(const id of result.ack)this.agent.db.prepare('DELETE FROM field_event_queue WHERE id=?').run(id);}
   this.agent.db.prepare("INSERT INTO field_meta VALUES('last_sync',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(new Date().toISOString());
  }finally{this.sending=false;}
 }
 record(control:string,screen:string,actor:'human'|'agent_test',extra:{task_id?:string;document_id?:string;active_ms?:number}={}){
  if(this.config.telemetryConsentVersion!==1)return;
  if(extra.document_id){const mapping=this.agent.db.prepare("SELECT result FROM field_outbox WHERE document_id=? AND status='acked' ORDER BY revision DESC LIMIT 1").get(extra.document_id);
    if(mapping)extra={...extra,document_id:JSON.parse(String(mapping.result)).document_id};}
  const controls=['screen_enter','screen_exit','question_view','evidence_open','answer','unknown','later','cancel','search','copy_prepare','copy_approve','copy_cancel','error'];
  if(!controls.includes(control)||!['today','projects','materials','admin'].includes(screen))throw new Error('INVALID_EVENT');
  const expired=this.agent.db.prepare("DELETE FROM field_event_queue WHERE created_at<datetime('now','-90 days')").run().changes;
  const count=Number(this.agent.db.prepare('SELECT count(*) n FROM field_event_queue').get()?.n??0);
  if(count>=5000||expired){this.agent.db.prepare("INSERT INTO field_meta VALUES('lost',?) ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+CAST(excluded.value AS INTEGER)").run(String(Number(expired)+(count>=5000?1:0)));if(count>=5000)return;}
  const sequence=Number(this.agent.db.prepare("SELECT value FROM field_meta WHERE key='seq'").get()?.value??0)+1;
  this.agent.db.prepare("INSERT INTO field_meta VALUES('seq',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(sequence));
  const id=randomUUID(),now=new Date().toISOString(),payload={event_id:id,session_id:this.sessionId,task_id:extra.task_id??null,document_id:extra.document_id??null,operation_id:null,
   actor,client_time:now,device_sequence:sequence,app_version:'0.1.0',screen_id:screen,control_id:control,result_code:'observed',active_ms:extra.active_ms??0,latency_ms:0,consent_version:1};
  this.agent.db.prepare('INSERT INTO field_event_queue VALUES(?,?,?)').run(id,JSON.stringify(payload),now);
 }
 async today(){await this.flush().catch(()=>{});return this.call('/v1/today');}
 async answer(id:string,body:unknown,key:string){
  const old=this.agent.db.prepare('SELECT * FROM field_commands WHERE id=?').get(key);
  if(old&&(old.question_id!==id||old.payload!==JSON.stringify(body)))throw new Error('FIELD_COMMAND_CONFLICT');
  this.agent.db.prepare('INSERT OR IGNORE INTO field_commands(id,question_id,payload,created_at) VALUES(?,?,?,?)').run(key,id,JSON.stringify(body),new Date().toISOString());
  await this.flush();const result=this.agent.db.prepare('SELECT * FROM field_commands WHERE id=?').get(key);
  if(result?.status==='conflict')throw new Error('FIELD_ANSWER_CHANGED');
  if(result?.status!=='acked')throw new Error('FIELD_WAITING_FOR_SERVER');return JSON.parse(String(result.result));
 }
 async approvedQuote(id:string){return this.call(`/v1/quotes/${id}/approved-snapshot`);}
 async projects(){return this.call('/v1/projects');}
 async project(id:string){return this.call(`/v1/projects/${id}`);}
 async admin(token:string,from:string,to:string){return this.call(`/v1/admin/field?from=${from}&to=${to}`,undefined,undefined,token);}
}
export function reportCsv(data:{events:Record<string,unknown>[];generated_at:string}){
 const cell=(v:unknown)=>{let s=String(v??'');if(/^[\s]*[=+@-]/.test(s))s=`'${s}`;return `"${s.replaceAll('"','""')}"`;};
 const headers=['사용자 가명','업무','조작자','받은 시각(KST)','화면','행동','결과','활동시간(ms)','앱 버전','생성 시각(KST)'];
 const kst=(v:unknown)=>new Date(String(v)).toLocaleString('sv-SE',{timeZone:'Asia/Seoul'});
 return '\uFEFF'+[headers,...data.events.map(e=>[createHash('sha256').update(String(e.user_id)).digest('hex').slice(0,12),e.task_id,e.actor,kst(e.received_at),e.screen_id,e.control_id,e.result_code,e.active_ms,e.app_version,kst(data.generated_at)])].map(r=>r.map(cell).join(',')).join('\r\n');
}
