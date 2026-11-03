import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {processingFixture} from './processing-fixture.js';
import type {Services} from '../services/api/src/routes.js';
import {createApp} from '../services/api/src/app.js';
export async function photoFixture(overrides:Partial<Services>={}){
 const db=await processingFixture(),f=await db.createFixture(),project=randomUUID();
 await db.admin`insert into app.projects(tenant_id,id,display_name) values(${f.tenant}::uuid,${project}::uuid,'합성 사진 현장')`;
 const files=new Map<string,Buffer>();
 const services={...overrides,db:db.api,capturePolicy:db.config.policy,verifyToken:async()=>({userId:f.user,sessionId:f.session}),storage:{async sign(path:string){return 'https://storage.invalid/'+path+'?token=synthetic-opaque-upload-signature';},async verify(path:string,hash:string,length:number){const bytes=files.get(path);return {matches:!!bytes&&createHash('sha256').update(bytes).digest('hex')===hash&&bytes.length===length,sniffedMime:'image/png'};},async readBytes(path:string){return files.get(path)!;},async remove(){}}};
 const app=createApp(services),headers={authorization:'Bearer synthetic','x-tenant-id':f.tenant};
 const get=(url:string,tenant=f.tenant)=>app.inject({method:'GET',url,headers:{...headers,'x-tenant-id':tenant}}),post=(url:string,payload:object)=>app.inject({method:'POST',url,headers:{...headers,'idempotency-key':randomUUID()},payload});
 const upload=async(bytes:Buffer)=>{const hash=createHash('sha256').update(bytes).digest('hex');const prepared=await post('/v1/ingestions',{client_capture_id:randomUUID(),source_id:f.source,source_generation:1,sha256:hash,byte_length:bytes.length,declared_mime:'image/png'});assert.equal(prepared.statusCode,201,prepared.body);files.set(f.tenant+'/'+prepared.json().ingestion_id,bytes);const completed=await post('/v1/ingestions/'+prepared.json().ingestion_id+'/complete',{sha256:hash,byte_length:bytes.length});assert.equal(completed.statusCode,200,completed.body);return completed.json().revision_id as string;};
 return {...db,f,project,app,services,get,post,upload,files,async close(){await app.close();await db.cleanup();}};
}
