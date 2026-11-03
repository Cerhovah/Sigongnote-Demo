import {deleteFixtureTenants} from './fixture-cleanup.js';
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
import { verifyLocalDevelopmentDb } from "../scripts/db-gate.mjs";
import { parseStrictLocalEnv } from "../scripts/local-env-values.mjs";
import { organizeEvidence } from "../packages/domain/src/organization.js";
import { createApp } from "../services/api/src/app.ts";
import { createStorageGateway, ORIGINAL_BUCKET } from "../services/api/src/storage.ts";
import { LOCAL_CAPTURE_POLICY } from "../services/api/src/capture-scope.ts";
import { assertWorkerRole, parseBytes, runParseOnce, parserEnvironment } from "../services/api/src/parse-worker.ts";

const python={python:resolve("services/document-worker/.venv",process.platform==="win32"?"Scripts/python.exe":"bin/python"),pythonRoot:resolve("services/document-worker")};
import {MESSAGE_MIME} from "../services/api/src/message-bundle.js";
import {syntheticMessage} from "../scripts/work-preview-message.js";
import {changeSmsActivation} from "../scripts/sms-activation.js";
test("D18 gated SMS source and synthetic qualification -> Storage -> worker -> same message/image, then revocation",async()=>{
 assert.equal((await verifyLocalDevelopmentDb()).status,"READY");
 const env=parseStrictLocalEnv(readFileSync("services/api/.env","utf8"));
 const admin=postgres(env.MIGRATION_DATABASE_URL!,{max:1}),db=postgres(env.DATABASE_URL!,{max:3}),worker=postgres(env.WORKER_DATABASE_URL!,{max:3});
 const storage=createClient(env.SUPABASE_URL!,env.SUPABASE_SECRET_KEY!,{auth:{persistSession:false,autoRefreshToken:false}}).storage.from(ORIGINAL_BUCKET);
 const tenant=randomUUID(),user=randomUUID(),session=randomUUID(),foreign=randomUUID();const objects:string[]=[];
 const app=createApp({db,capturePolicy:LOCAL_CAPTURE_POLICY,verifyToken:async()=>({userId:user,sessionId:session}),storage:createStorageGateway(env.SUPABASE_URL!,env.SUPABASE_SECRET_KEY!)});
 const headers={authorization:"Bearer fixture","x-tenant-id":tenant};
 const call=(url:string,payload?:object)=>app.inject({method:payload?"POST":"GET",url,headers:{...headers,"idempotency-key":randomUUID()},...(payload?{payload}:{})});
 try{
  await admin`insert into auth.users(id) values(${user}::uuid)`;
  await admin`insert into auth.sessions(id,user_id) values(${session}::uuid,${user}::uuid)`;
  await admin`insert into app.tenants(id,display_name) values(${tenant}::uuid,'D18 synthetic')`;
  await admin`insert into app.memberships(tenant_id,user_id,role) values(${tenant}::uuid,${user}::uuid,'owner')`;
  await assertWorkerRole(worker);
  const jwk=generateKeyPairSync("ec",{namedCurve:"P-256"}).publicKey.export({format:"jwk"});
  const device=await call("/v1/devices",{platform:"android",app_version:"d18-fixture",public_key_jwk:{kty:"EC",crv:"P-256",x:jwk.x,y:jwk.y}});assert.equal(device.statusCode,201,device.body);
  const source=await call("/v1/capture-sources",{device_id:device.json().id,kind:"sms",scope_fingerprint:"f".repeat(64),consent_version:2,local_selection_consent:true,server_upload_consent:true,external_ai_consent:false,scope:{capture_method:"sms_provider",history_mode:"all",history_since:null,scope_mode:"work_dedicated",rule_version:1,processing_policy_id:LOCAL_CAPTURE_POLICY.id,fingerprint_algorithm:"hmac-sha256-device-v1"}});
  assert.equal(source.statusCode,201,source.body);assert.equal(source.json().capability,"policy_gated");assert.equal(source.json().upload_ready,false);
  const bytes=syntheticMessage(),hash=createHash("sha256").update(bytes).digest("hex");
  const payload={client_capture_id:randomUUID(),sha256:hash,byte_length:bytes.length,declared_mime:MESSAGE_MIME,source_id:source.json().id,source_generation:1};
  assert.equal((await call("/v1/ingestions",payload)).statusCode,410);
  assert.equal((await admin`select count(*)::int n from app.upload_intents where tenant_id=${tenant}::uuid`)[0]?.n,0);
  // Synthetic tenant only: this emulates an approved server source, not Play/installer qualification.
  await admin`update app.capture_sources set capability='passive' where tenant_id=${tenant}::uuid and id=${source.json().id}::uuid`;
  assert.equal((await call('/v1/ingestions',payload)).statusCode,410,'a legacy capability flag cannot replace explicit SMS qualification');
  await changeSmsActivation(admin,{schema:'sms-activation-v1',tenant_id:tenant,user_id:user,device_id:device.json().id,source_id:source.json().id,generation:1,scope_fingerprint:source.json().scope_fingerprint,processing_policy_id:LOCAL_CAPTURE_POLICY.id,application_id:'com.sigongnote.app.smssync',certificate_sha256:'a'.repeat(64),installation_fingerprint:'b'.repeat(64),policy_evidence_sha256:'c'.repeat(64),installer_evidence_sha256:'d'.repeat(64),accepted_by:user,accepted_at:new Date(Date.now()-1000).toISOString(),expires_at:new Date(Date.now()+3600000).toISOString(),revoked_at:null},false,true);
  assert.equal((await call(`/v1/capture-sources/${source.json().id}/sms-access`)).json().ready,true);
  const qualified=(await call('/v1/capture-sources')).json().sources.find((s:{id:string})=>s.id===source.json().id);assert.equal(qualified.upload_ready,true);
  assert.equal((await call('/v1/ingestions',{...payload,source_id:undefined,source_generation:undefined})).json().error.code,'SOURCE_SCOPE_MISMATCH');
  assert.equal((await call('/v1/ingestions',{...payload,declared_mime:'text/plain'})).json().error.code,'SOURCE_SCOPE_MISMATCH');
  const prepared=await call("/v1/ingestions",payload);assert.equal(prepared.statusCode,201,prepared.body);const receipt=prepared.json(),key=`${tenant}/${receipt.ingestion_id}`;objects.push(key);
  assert.ifError((await storage.uploadToSignedUrl(key,new URL(receipt.upload_url).searchParams.get("token")!,bytes,{contentType:MESSAGE_MIME})).error);
  const complete=await call(`/v1/ingestions/${receipt.ingestion_id}/complete`,{sha256:hash,byte_length:bytes.length});assert.equal(complete.statusCode,200,complete.body);const revision=complete.json().revision_id;
  const download=async(input:{storage_key:string})=>{const {data,error}=await storage.download(input.storage_key);assert.ifError(error);return new Uint8Array(await data!.arrayBuffer());};
  assert.equal(await runParseOnce({db:worker,policy:LOCAL_CAPTURE_POLICY,tenantScope:tenant,...python,python:resolve('.work/nonexistent-python'),download}),"retry");
  assert.equal((await admin`select count(*)::int n from app.parse_results where tenant_id=${tenant}::uuid`)[0]?.n,0);
  await admin`update app.jobs set available_at=now()-interval '1 second' where tenant_id=${tenant}::uuid`;
  assert.equal(await runParseOnce({db:worker,policy:LOCAL_CAPTURE_POLICY,tenantScope:tenant,...python,download:async input=>{const {data,error}=await storage.download(input.storage_key);assert.ifError(error);return new Uint8Array(await data!.arrayBuffer());}}),"stored");
  const detail=await call(`/v1/work/materials/${revision}`);assert.equal(detail.statusCode,200,detail.body);assert.equal(detail.json().result.output.status,"partial");
  assert.ok(detail.json().result.output.spans.some((s:{text:string})=>s.text.includes("합성 햇살현장 문자")));
  const message=await call(`/v1/work/materials/${revision}/message`);assert.equal(message.statusCode,200,message.body);assert.equal(message.json().missing_parts,1);assert.equal(message.json().parts.length,1);assert.equal(message.headers['cache-control'],'no-store');
  assert.equal(message.json().source_kind,'sms');
  assert.equal((await call('/v1/work/materials?q='+encodeURIComponent('문자 납품'))).json().materials[0].id,revision);
  assert.equal((await app.inject({url:`/v1/work/materials/${revision}/message`,headers:{...headers,'x-tenant-id':foreign}})).statusCode,404);
  const revoke=await app.inject({method:'POST',url:`/v1/capture-sources/${source.json().id}/revoke`,payload:{},headers:{...headers,'idempotency-key':randomUUID(),'if-match':`"${qualified.version}"`}});assert.equal(revoke.statusCode,200,revoke.body);
  assert.equal((await call(`/v1/work/materials/${revision}/message`)).statusCode,404);
  assert.equal((await call(`/v1/work/materials/${revision}/original`)).statusCode,404);
 }finally{
  await app.close();if(objects.length)await storage.remove(objects);
  await admin.begin(async tx=>{
   await deleteFixtureTenants(tx,[tenant]);
   await tx`delete from auth.sessions where id=${session}::uuid`;await tx`delete from auth.users where id=${user}::uuid`;
  });await Promise.all([admin.end(),db.end(),worker.end()]);
 }
});

