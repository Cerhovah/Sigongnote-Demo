import {verifyLocalDevelopmentDb} from '../scripts/db-gate.mjs';
import {deleteFixtureTenants} from "./fixture-cleanup.js";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { parseStrictLocalEnv } from "../scripts/local-env-values.mjs";
import { createApp } from "../services/api/src/app.ts";
import { createTokenVerifier } from "../services/api/src/auth.ts";
import { createStorageGateway, ORIGINAL_BUCKET } from "../services/api/src/storage.ts";

test("C07 separates consent from OS reports and fences revoked uploads/jobs", async () => {
  assert.notEqual(process.env.SIGONGNOTE_E2E_DB,'1');
  assert.equal((await verifyLocalDevelopmentDb()).status,'READY');
  const env = parseStrictLocalEnv(readFileSync("services/api/.env","utf8"));
  const setting = (key:string) => {
    const value = env[key];
    assert.ok(value,`Missing local test setting: ${key}`);
    return value;
  };
  const url = setting("SUPABASE_URL");
  const admin = createClient(url,setting("SUPABASE_SECRET_KEY"),{
    auth:{autoRefreshToken:false,persistSession:false,detectSessionInUrl:false},
  });
  const userClient = createClient(url,setting("SUPABASE_PUBLISHABLE_KEY"),{
    auth:{autoRefreshToken:false,persistSession:false,detectSessionInUrl:false},
  });
  const adminDb = postgres(setting("MIGRATION_DATABASE_URL"),{max:1});
  const runtimeDb = postgres(setting("DATABASE_URL"),{max:2});
  const workerDb = postgres(setting("WORKER_DATABASE_URL"),{max:1});
  const gateway = createStorageGateway(url,setting("SUPABASE_SECRET_KEY"));
  let signalVerification: (() => void) | undefined;
  let releaseVerification: (() => void) | undefined;
  const verificationStarted = new Promise<void>(resolve => { signalVerification=resolve; });
  const verificationReleased = new Promise<void>(resolve => { releaseVerification=resolve; });
  let delayVerification = false;
  const app = createApp({db:runtimeDb,
    verifyToken:createTokenVerifier(url,setting("SUPABASE_PUBLISHABLE_KEY")),
    storage:{...gateway,verify:async (...args) => {
      if (delayVerification) {
        signalVerification?.();
        await verificationReleased;
      }
      return gateway.verify(...args);
    }}});
  const tenantId = randomUUID();
  const email = `c07-${randomUUID()}@example.invalid`;
  const password = randomBytes(24).toString("hex");
  const bytes = Buffer.from("fixture C07 source bytes only\n","utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const uploaded:string[] = [];
  let userId:string|undefined;
  let secondUserId:string|undefined;
  let tenantCreated = false;
  try {
    const created = await admin.auth.admin.createUser({email,password,email_confirm:true});
    assert.ifError(created.error);
    userId=created.data.user?.id;
    assert.ok(userId);
    await adminDb`insert into app.tenants(id,display_name)
      values (${tenantId}::uuid,'fixture C07 tenant')`;
    tenantCreated=true;
    await adminDb`insert into app.memberships(tenant_id,user_id,role)
      values (${tenantId}::uuid,${userId}::uuid,'owner')`;
    const second=await admin.auth.admin.createUser({
      email:`c07-second-${randomUUID()}@example.invalid`,
      password:randomBytes(24).toString("hex"),email_confirm:true});
    assert.ifError(second.error);
    secondUserId=second.data.user?.id;
    assert.ok(secondUserId);
    await adminDb`insert into app.memberships(tenant_id,user_id,role)
      values (${tenantId}::uuid,${secondUserId}::uuid,'owner')`;
    const signed=await userClient.auth.signInWithPassword({email,password});
    assert.ifError(signed.error);
    const token=signed.data.session?.access_token;
    assert.ok(token);
    const headers={authorization:`Bearer ${token}`,"x-tenant-id":tenantId};
    const post=async (path:string,payload:Record<string,unknown>,
      key=randomUUID(),version?:number) =>
      await app.inject({method:"POST",url:path,
        headers:{...headers,"idempotency-key":key,
          ...(version===undefined?{}:{"if-match":`"${version}"`})},payload});
    const jwk=generateKeyPairSync("ec",{namedCurve:"P-256"}).publicKey.export({format:"jwk"});
    const device=await post("/v1/devices",{platform:"windows",app_version:"c07-fixture",
      public_key_jwk:{kty:"EC",crv:"P-256",x:jwk.x,y:jwk.y}});
    assert.equal(device.statusCode,201,device.body);
    const deviceId=device.json().id as string;
    const makeSource=async (kind:"folder"|"manual_share"|"sms",serverUpload=true) => {
      const key=randomUUID();
      const payload={
        device_id:deviceId,kind,scope_fingerprint:sha256,
        consent_version:1,local_selection_consent:true,
        server_upload_consent:serverUpload,external_ai_consent:false};
      const response=await post("/v1/capture-sources",payload,key);
      assert.equal(response.statusCode,201,response.body);
      if(kind==="folder") {
        const replay=await post("/v1/capture-sources",payload,key);
        assert.equal(replay.statusCode,201,replay.body);
        assert.equal(replay.json().id,response.json().id);
      }
      return response.json() as {id:string;generation:number;version:number;
        permission:string;capability:string;reported_permission:string|null;
        upload_ready:boolean};
    };
    const folder=await makeSource("folder");
    assert.equal(folder.capability,"passive");
    assert.equal(folder.permission,"not_requested");
    assert.equal(folder.upload_ready,true,
      "Backend consent gate is separate from local Windows folder accessibility");
    const report=await post(`/v1/capture-sources/${folder.id}/checkpoint`,{
      generation:folder.generation,reported_permission:"granted",
      cursor_token:sha256,pending_count:2,bytes_pending:48,
    },randomUUID(),folder.version);
    assert.equal(report.statusCode,200,report.body);
    assert.equal(report.json().reported_permission,"granted");
    assert.equal(report.json().permission,"not_requested",
      "A bearer-token claim must not turn into an OS grant");
    const folderCaptureId=randomUUID();
    const folderPrepareKey=randomUUID();
    const folderBody={
      client_capture_id:folderCaptureId,sha256,byte_length:bytes.length,
      declared_mime:"text/plain",source_id:folder.id,
      source_generation:folder.generation};
    const preparedFolder=await post("/v1/ingestions",folderBody,folderPrepareKey);
    assert.equal(preparedFolder.statusCode,201,preparedFolder.body);
    const revokedFolder=await post(`/v1/capture-sources/${folder.id}/revoke`,{},
      randomUUID(),report.json().version);
    assert.equal(revokedFolder.statusCode,200,revokedFolder.body);
    const staleFolder=await post("/v1/ingestions",folderBody,folderPrepareKey);
    assert.equal(staleFolder.statusCode,410,staleFolder.body);
    const sms=await makeSource("sms");
    assert.equal(sms.capability,"policy_gated");
    const deniedSms=await post("/v1/ingestions",{
      client_capture_id:randomUUID(),sha256,byte_length:bytes.length,
      declared_mime:"text/plain",source_id:sms.id,
      source_generation:sms.generation});
    assert.equal(deniedSms.statusCode,410,deniedSms.body);

    const manual=await makeSource("manual_share");
    assert.equal(manual.upload_ready,true);
    const captureId=randomUUID();
    const prepareKey=randomUUID();
    const prepareBody={
      client_capture_id:captureId,sha256,byte_length:bytes.length,
      declared_mime:"text/plain",source_id:manual.id,
      source_generation:manual.generation};
    const prepare=await post("/v1/ingestions",prepareBody,prepareKey);
    assert.equal(prepare.statusCode,201,prepare.body);
    const intentId=prepare.json().ingestion_id as string;
    const path=`${tenantId}/${intentId}`;
    uploaded.push(path);
    const uploadToken=new URL(prepare.json().upload_url).searchParams.get("token");
    assert.ok(uploadToken);
    assert.ifError((await admin.storage.from(ORIGINAL_BUCKET)
      .uploadToSignedUrl(path,uploadToken,bytes,{contentType:"text/plain"})).error);
    delayVerification=true;
    const completing=post(`/v1/ingestions/${intentId}/complete`,{
      sha256,byte_length:bytes.length});
    await verificationStarted;
    const revokeStarted=Date.now();
    let revoked:Awaited<ReturnType<typeof post>>;
    try {
      revoked=await Promise.race([post(`/v1/capture-sources/${manual.id}/revoke`,{},
        randomUUID(),manual.version),new Promise<never>((_,reject) => {
        setTimeout(() => reject(new Error("Revoke waited for Storage verification")),1000);
      })]);
    } finally { releaseVerification?.(); }
    assert.ok(Date.now()-revokeStarted<1000);
    assert.equal(revoked.statusCode,200,revoked.body);
    assert.equal(revoked.json().active,false);
    assert.equal(revoked.json().generation,manual.generation+1);
    assert.equal(revoked.json().permission,"not_requested",
      "Application consent withdrawal must not pretend to revoke an OS grant");
    const replayAfterRevoke=await post("/v1/ingestions",prepareBody,prepareKey);
    assert.equal(replayAfterRevoke.statusCode,410,replayAfterRevoke.body);
    const complete=await completing;
    assert.equal(complete.statusCode,410,complete.body);
    const [intent]=await adminDb`select status,rejection_reason from app.upload_intents
      where tenant_id = ${tenantId}::uuid and id = ${intentId}::uuid`;
    assert.equal(intent?.status,"rejected");
    assert.equal(intent?.rejection_reason,"source_revoked");
    const [ledger]=await adminDb`select count(*)::integer as n,
      count(*) filter (where initiated_by = 'subject')::integer as subject_count
      from app.consent_grants
      where tenant_id = ${tenantId}::uuid and source_id = ${manual.id}::uuid`;
    assert.equal(ledger?.n,2);
    assert.equal(ledger?.subject_count,2);
    await assert.rejects(async () => adminDb`update app.consent_grants
      set event = 'granted' where tenant_id = ${tenantId}::uuid and
        source_id = ${manual.id}::uuid`);

    const manual2=await makeSource("manual_share");
    const prepared=await post("/v1/ingestions",{
      client_capture_id:randomUUID(),sha256,byte_length:bytes.length,
      declared_mime:"text/plain",source_id:manual2.id,
      source_generation:manual2.generation});
    assert.equal(prepared.statusCode,201,prepared.body);
    const secondId=prepared.json().ingestion_id as string;
    const secondPath=`${tenantId}/${secondId}`;
    uploaded.push(secondPath);
    const secondToken=new URL(prepared.json().upload_url).searchParams.get("token");
    assert.ok(secondToken);
    assert.ifError((await admin.storage.from(ORIGINAL_BUCKET)
      .uploadToSignedUrl(secondPath,secondToken,bytes,{contentType:"text/plain"})).error);
    const completedKey=randomUUID();
    const accepted=await post(`/v1/ingestions/${secondId}/complete`,{
      sha256,byte_length:bytes.length},completedKey);
    assert.equal(accepted.statusCode,200,accepted.body);
    const jobId=accepted.json().job_id as string;
    const [lease]=await workerDb`select * from app.claim_parse_job_for_tenant('c07-fixture',60,'document-python-v1',${tenantId}::uuid)`;
    assert.equal(lease?.job_id,jobId);
    const revoked2=await post(`/v1/capture-sources/${manual2.id}/revoke`,{},
      randomUUID(),manual2.version);
    assert.equal(revoked2.statusCode,200,revoked2.body);
    const sameReceipt=await post(`/v1/ingestions/${secondId}/complete`,{
      sha256,byte_length:bytes.length},completedKey);
    assert.equal(sameReceipt.statusCode,200,sameReceipt.body);
    assert.deepEqual(sameReceipt.json(),accepted.json());
    const newAttempt=await post(`/v1/ingestions/${secondId}/complete`,{
      sha256,byte_length:bytes.length});
    assert.equal(newAttempt.statusCode,410,newAttempt.body);
    const [effect]=await workerDb`select app.complete_parse_job(
      ${tenantId}::uuid,${jobId}::uuid,${lease.lease_token}::uuid,${sha256}) as accepted`;
    assert.equal(effect?.accepted,false);
    const [job]=await adminDb`select state from app.jobs
      where tenant_id = ${tenantId}::uuid and id = ${jobId}::uuid`;
    assert.equal(job?.state,"cancelled");
    const [effects]=await adminDb`select count(*)::integer as n from app.job_effects
      where tenant_id = ${tenantId}::uuid`;
    assert.equal(effects?.n,0);
    const manual3=await makeSource("manual_share");
    const third=await post("/v1/ingestions",{
      client_capture_id:randomUUID(),sha256,byte_length:bytes.length,
      declared_mime:"text/plain",source_id:manual3.id,
      source_generation:manual3.generation});
    assert.equal(third.statusCode,201,third.body);
    await adminDb`update app.memberships set role = 'viewer',version = version + 1
      where tenant_id = ${tenantId}::uuid and user_id = ${userId}::uuid`;
    const viewerRevoked=await post(`/v1/capture-sources/${sms.id}/revoke`,{},
      randomUUID(),sms.version);
    assert.equal(viewerRevoked.statusCode,200,viewerRevoked.body);
    const deviceRevoke=await post(`/v1/devices/${deviceId}/revoke`,{},randomUUID(),1);
    assert.equal(deviceRevoke.statusCode,200,deviceRevoke.body);
    const [afterDevice]=await adminDb`select active,generation from app.capture_sources
      where tenant_id = ${tenantId}::uuid and id = ${manual3.id}::uuid`;
    assert.equal(afterDevice?.active,false);
    assert.equal(Number(afterDevice?.generation),manual3.generation+1);
    const [deviceLedger]=await adminDb`select initiated_by from app.consent_grants
      where tenant_id = ${tenantId}::uuid and source_id = ${manual3.id}::uuid
        and event = 'revoked'`;
    assert.equal(deviceLedger?.initiated_by,"device_revoke");
    const [thirdIntent]=await adminDb`select status,rejection_reason from app.upload_intents
      where tenant_id = ${tenantId}::uuid and id = ${third.json().ingestion_id}::uuid`;
    assert.equal(thirdIntent?.rejection_reason,"source_revoked");
    assert.equal(thirdIntent?.status,"rejected");
    const foreign=await app.inject({method:"GET",url:"/v1/capture-sources",
      headers:{...headers,"x-tenant-id":randomUUID()}});
    assert.equal(foreign.statusCode,404,foreign.body);
  } finally {
    releaseVerification?.();
    await app.close();
    await runtimeDb.end();
    await workerDb.end();
    if (tenantCreated) await adminDb.begin(async tx => {await deleteFixtureTenants(tx,[tenantId]);});
    await adminDb.end();
    if (uploaded.length) assert.ifError((await admin.storage
      .from(ORIGINAL_BUCKET).remove(uploaded)).error);
    if (userId) assert.ifError((await admin.auth.admin.deleteUser(userId)).error);
    if (secondUserId) assert.ifError((await admin.auth.admin.deleteUser(secondUserId)).error);
  }
});
