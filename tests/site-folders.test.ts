import {deleteFixtureTenants} from './fixture-cleanup.js';
import assert from "node:assert/strict";
import {randomUUID,generateKeyPairSync} from "node:crypto";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import postgres from "postgres";
import {verifyLocalDevelopmentDb} from "../scripts/db-gate.mjs";
import {parseStrictLocalEnv} from "../scripts/local-env-values.mjs";
import {LOCAL_CAPTURE_POLICY} from "../services/api/src/capture-scope.ts";
import {createApp} from "../services/api/src/app.ts";

test("D02 site creation and folder binding preserve scope, retries and tenant/device ownership",async()=>{
 assert.equal((await verifyLocalDevelopmentDb()).status,"READY");
 const env=parseStrictLocalEnv(readFileSync("services/api/.env","utf8"));
 assert.ok(env.MIGRATION_DATABASE_URL && env.DATABASE_URL);
 const admin=postgres(env.MIGRATION_DATABASE_URL,{max:1}),runtime=postgres(env.DATABASE_URL,{max:4});
 const tenant=randomUUID(),foreign=randomUUID(),actor=randomUUID(),other=randomUUID(),session=randomUUID(),otherSession=randomUUID();
 let removed=0;
 const app=createApp({db:runtime,capturePolicy:LOCAL_CAPTURE_POLICY,storage:{sign:async()=>"http://127.0.0.1:54321/storage/v1/object/upload/sign/sigongnote-originals/fake?token=synthetic-test-signature-0000000000000000",verify:async()=>({matches:true,sniffedMime:"application/pdf"}),remove:async()=>{removed++;}},verifyToken:async token=>token==="fixture"?{userId:actor,sessionId:session}:{userId:other,sessionId:otherSession}});
 const call=async(method:"POST"|"GET",url:string,payload?:object,key=randomUUID(),company=tenant,token="fixture",version?:number)=>
  app.inject({method,url,headers:{authorization:`Bearer ${token}`,"x-tenant-id":company,"idempotency-key":key,
   ...(version?{"if-match":`"${version}"`}:{})},...(payload?{payload}:{})});
 let seeded=false;
 try{
  await admin.begin(async tx=>{
   await tx`insert into auth.users(id) values (${actor}::uuid),(${other}::uuid)`;
   await tx`insert into auth.sessions(id,user_id) values (${session}::uuid,${actor}::uuid),(${otherSession}::uuid,${other}::uuid)`;
   await tx`insert into app.tenants(id,display_name) values (${tenant}::uuid,'D02 fixture'),(${foreign}::uuid,'D02 foreign')`;
   await tx`insert into app.memberships(tenant_id,user_id,role) values (${tenant}::uuid,${actor}::uuid,'owner'),(${tenant}::uuid,${other}::uuid,'operator')`;
  });seeded=true;
  const projectKey=randomUUID(),projectBody={display_name:" 합성 현장 "};
  const created=await call("POST","/v1/projects",projectBody,projectKey);
  assert.equal(created.statusCode,201,created.body);
  assert.equal(created.json().display_name,"합성 현장");
  assert.equal((await call("POST","/v1/projects",projectBody,projectKey)).json().id,created.json().id);
  assert.equal((await call("POST","/v1/projects",{display_name:"other"},projectKey)).statusCode,409);
  assert.equal((await call("POST","/v1/projects",{display_name:" "})).statusCode,400);
  assert.equal((await call("POST","/v1/projects",projectBody,randomUUID(),foreign)).statusCode,404);
  const jwk=generateKeyPairSync("ec",{namedCurve:"P-256"}).publicKey.export({format:"jwk"});
  const device=await call("POST","/v1/devices",{platform:"android",app_version:"d02-fixture",public_key_jwk:{kty:"EC",crv:"P-256",x:jwk.x,y:jwk.y}});
  assert.equal(device.statusCode,201,device.body);
  const source=await call("POST","/v1/capture-sources",{device_id:device.json().id,kind:"folder",scope_fingerprint:"a".repeat(64),
   consent_version:1,local_selection_consent:true,server_upload_consent:true,external_ai_consent:false});
  assert.equal(source.statusCode,201,source.body);
  const scope={capture_method:"saf_tree",history_mode:"all",history_since:null,scope_mode:"work_dedicated",
   rule_version:1,processing_policy_id:"local-fixture-v1",fingerprint_algorithm:"hmac-sha256-device-v1"};
  const photoBody={device_id:device.json().id,kind:"photos",scope_fingerprint:"e".repeat(64),
   consent_version:2,local_selection_consent:true,server_upload_consent:true,external_ai_consent:false,scope};
  assert.deepEqual((await call("GET","/v1/capture-policy")).json(),LOCAL_CAPTURE_POLICY);
  for(const change of [{consent_version:1},{scope:{...scope,capture_method:"notification"}},
   {scope:{...scope,scope_mode:"mixed_hold"}},{scope:{...scope,history_mode:"since"}},
   {scope:{...scope,processing_policy_id:"unregistered"}},{external_ai_consent:true}]){
   assert.equal((await call("POST","/v1/capture-sources",{...photoBody,...change})).statusCode,400);
  }
  const photo=await call("POST","/v1/capture-sources",photoBody);
  assert.equal(photo.statusCode,201,photo.body);assert.equal(photo.json().capability,"passive");
  assert.equal(photo.json().scope_fingerprint,photoBody.scope_fingerprint);assert.deepEqual(photo.json().scope,scope);assert.deepEqual(photo.json().processing_policy,LOCAL_CAPTURE_POLICY);
  const ingestBody={client_capture_id:randomUUID(),sha256:"a".repeat(64),byte_length:100,
   declared_mime:"application/pdf",source_id:photo.json().id,source_generation:1};
  assert.equal((await call("POST","/v1/ingestions",ingestBody)).json().error.code,"SOURCE_SCOPE_MISMATCH");
  const prepared=await call("POST","/v1/ingestions",{...ingestBody,declared_mime:"image/jpeg"});
  assert.equal(prepared.statusCode,201,prepared.body);
  const completePath=`/v1/ingestions/${prepared.json().ingestion_id}/complete`;
  const completeBody={sha256:ingestBody.sha256,byte_length:100};
  assert.equal((await call("POST",completePath,completeBody)).json().error.code,"SOURCE_SCOPE_MISMATCH");
  assert.equal((await call("POST",completePath,completeBody)).json().error.code,"SOURCE_SCOPE_MISMATCH");assert.equal(removed,1);
  assert.equal((await call("POST",`/v1/capture-sources/${photo.json().id}/revoke`,{},randomUUID(),tenant,"fixture",1)).statusCode,200);
  const grants=await admin`select scope,processing_policy from app.consent_grants where tenant_id=${tenant}::uuid and source_id=${photo.json().id}::uuid order by generation`;
  assert.equal(grants.length,2);for(const grant of grants){assert.deepEqual(grant.scope,scope);assert.deepEqual(grant.processing_policy,LOCAL_CAPTURE_POLICY);}
  const body={source_id:source.json().id,source_generation:1,scope_fingerprint:"b".repeat(64),scope_mode:"project",project_id:created.json().id};
  const pair=await Promise.all([call("POST","/v1/site-folder-bindings",body),call("POST","/v1/site-folder-bindings",body)]);
  assert.deepEqual(pair.map(r=>r.statusCode).sort(),[200,201]);
  assert.equal(pair[0]?.json().id,pair[1]?.json().id);
  assert.equal((await call("POST","/v1/site-folder-bindings",{...body,source_generation:2})).statusCode,410);
  assert.equal((await call("POST","/v1/site-folder-bindings",{...body,scope_mode:"company_common"})).statusCode,400);
  assert.equal((await call("POST","/v1/site-folder-bindings",{...body,scope_mode:"company_common",project_id:null})).statusCode,409);
  assert.equal((await call("POST","/v1/site-folder-bindings",body,randomUUID(),tenant,"other")).statusCode,404);
  assert.equal((await call("POST","/v1/site-folder-bindings",{...body,project_id:randomUUID(),scope_fingerprint:"c".repeat(64)})).statusCode,404);
  assert.equal((await call("POST","/v1/site-folder-bindings",{...body,local_path:"private"})).statusCode,400);
  const common=await call("POST","/v1/site-folder-bindings",{...body,scope_fingerprint:"c".repeat(64),scope_mode:"company_common",project_id:null,display_name:null});
  assert.equal(common.statusCode,201,common.body);
  assert.equal((await call("GET","/v1/site-folder-bindings")).json().bindings.length,2);
  assert.equal((await call("GET","/v1/site-folder-bindings",undefined,randomUUID(),tenant,"other")).json().bindings.length,0);
  const loose=await call("POST","/v1/site-folder-bindings",{...body,scope_fingerprint:"f".repeat(64),scope_mode:"unassigned",project_id:null,display_name:"공통 자료"});
  assert.equal(loose.statusCode,201,loose.body);assert.equal(loose.json().display_name,"공통 자료");
  const edit={client_command_id:randomUUID(),changes:[{id:loose.json().id,expected_version:1,source_generation:1,scope_mode:"project",project_id:created.json().id},{id:common.json().id,expected_version:99,source_generation:1,scope_mode:"unassigned",project_id:null}]};
  const staleBatch=await call("POST","/v1/site-folder-bindings/batch",edit);assert.equal(staleBatch.statusCode,409,staleBatch.body);
  assert.equal((await call("GET","/v1/site-folder-bindings")).json().bindings.find((b:{id:string})=>b.id===loose.json().id).version,1);
  edit.changes[1]!.expected_version=1;
  const batch=await call("POST","/v1/site-folder-bindings/batch",edit);assert.equal(batch.statusCode,200,batch.body);
  assert.ok(batch.json().bindings.every((b:{version:number})=>b.version===2));
  assert.deepEqual((await call("POST","/v1/site-folder-bindings/batch",edit)).json(),batch.json());
  assert.equal((await call("POST","/v1/site-folder-bindings/batch",{...edit,client_command_id:randomUUID()})).statusCode,409);
  assert.equal((await call("POST","/v1/site-folder-bindings/batch",{...edit,client_command_id:randomUUID()},randomUUID(),tenant,"other")).statusCode,404);
  const revoked=await call("POST",`/v1/capture-sources/${source.json().id}/revoke`,{},randomUUID(),tenant,"fixture",1);
  assert.equal(revoked.statusCode,200,revoked.body);
  assert.equal((await call("GET","/v1/site-folder-bindings")).json().bindings.length,0);
  assert.equal((await call("POST","/v1/site-folder-bindings",{...body,scope_fingerprint:"d".repeat(64)})).statusCode,410);
 }finally{
  await app.close();
  if(seeded)await admin.begin(async tx=>{
   // Only synthetic IDs owned by this test. Local session setting leaves other sessions' guards intact.
   await deleteFixtureTenants(tx,[tenant,foreign]);
   await tx`delete from auth.sessions where id in (${session}::uuid,${otherSession}::uuid)`;
   await tx`delete from auth.users where id in (${actor}::uuid,${other}::uuid)`;
  });
  await runtime.end();await admin.end();
 }
});
