import {deleteFixtureTenants} from "./fixture-cleanup.js";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { createApp } from "../services/api/src/app.ts";
import { createTokenVerifier } from "../services/api/src/auth.ts";
import { createStorageGateway, ORIGINAL_BUCKET } from "../services/api/src/storage.ts";
import { parseStrictLocalEnv } from "../scripts/local-env-values.mjs";
import { verifyLocalDevelopmentDb } from "../scripts/db-gate.mjs";

test("C05 private upload verifies bytes, retains revisions and deduplicates per tenant", async () => {
  assert.equal((await verifyLocalDevelopmentDb()).status, "READY");
  const env = parseStrictLocalEnv(readFileSync("services/api/.env", "utf8"));
  const setting = (key: string) => {
    const value = env[key];
    assert.ok(value, `Missing local test setting: ${key}`);
    return value;
  };
  const url = setting("SUPABASE_URL");
  const publishable = setting("SUPABASE_PUBLISHABLE_KEY");
  const admin = createClient(url, setting("SUPABASE_SECRET_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const client = createClient(url, publishable, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const adminDb = postgres(setting("MIGRATION_DATABASE_URL"), { max: 1 });
  const runtimeDb = postgres(setting("DATABASE_URL"), { max: 2 });
  const app = createApp({ db: runtimeDb, verifyToken: createTokenVerifier(url, publishable),
    storage: createStorageGateway(url, setting("SUPABASE_SECRET_KEY")) });
  const tenantId = randomUUID();
  const email = `c05-${randomUUID()}@example.invalid`;
  const password = randomBytes(24).toString("hex");
  const source = Buffer.from("fixture C05: original remains private\n", "utf8");
  const corrupted = Buffer.from(source);
  corrupted[0] = 0x78;
  const sha256 = createHash("sha256").update(source).digest("hex");
  let userId: string | undefined;
  let tenantCreated = false;
  const uploadedPaths: string[] = [];
  try {
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    assert.ifError(created.error);
    userId = created.data.user?.id;
    assert.ok(userId);
    await adminDb`insert into app.tenants(id,display_name)
      values (${tenantId}::uuid,'fixture C05 tenant')`;
    tenantCreated = true;
    await adminDb`insert into app.memberships(tenant_id,user_id,role)
      values (${tenantId}::uuid,${userId}::uuid,'owner')`;
    const signed = await client.auth.signInWithPassword({ email, password });
    assert.ifError(signed.error);
    const token = signed.data.session?.access_token;
    assert.ok(token);
    const headers = { authorization: `Bearer ${token}`, "x-tenant-id": tenantId };
    const oversized = await app.inject({ method: "POST", url: "/v1/ingestions",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { client_capture_id: randomUUID(), sha256,
        byte_length: 209715201, declared_mime: "text/plain" } });
    assert.equal(oversized.statusCode, 413);
    const prepare = async (captureId = randomUUID(), idempotency = randomUUID(),
      extra: Record<string, unknown> = {}) => {
      const response = await app.inject({ method: "POST", url: "/v1/ingestions",
        headers: { ...headers, "idempotency-key": idempotency },
        payload: { client_capture_id: captureId, sha256, byte_length: source.length,
          declared_mime: "text/plain", ...extra } });
      assert.equal(response.statusCode, 201, response.body);
      const receipt = response.json();
      assert.equal(receipt.state, "prepared");
      assert.ok(receipt.upload_url.startsWith(`${url}/storage/v1/`));
      assert.equal(receipt.upload.protocol,"tus");
      assert.equal(receipt.upload.endpoint,`${url}/storage/v1/upload/resumable`);
      assert.equal(receipt.upload.chunk_bytes,6 * 1024 * 1024);
      assert.equal(receipt.upload.authorization,"user_bearer+signature");
      assert.equal(receipt.upload.metadata_keys,"bucketName,objectName,contentType");
      assert.equal(receipt.upload.upsert,false);
      return { receipt, captureId, idempotency };
    };
    const upload = async (receipt: {ingestion_id:string;upload_url:string}, bytes: Buffer) => {
      const path = `${tenantId}/${receipt.ingestion_id}`;
      uploadedPaths.push(path);
      const uploadToken = new URL(receipt.upload_url).searchParams.get("token");
      assert.ok(uploadToken);
      const result = await admin.storage.from(ORIGINAL_BUCKET).uploadToSignedUrl(
        path, uploadToken, bytes, { contentType: "text/plain" });
      assert.ifError(result.error);
    };
    const complete = (id: string, key = randomUUID(), bytes: Buffer = source) => app.inject({
      method: "POST", url: `/v1/ingestions/${id}/complete`,
      headers: { ...headers, "idempotency-key": key },
      payload: { sha256: createHash("sha256").update(bytes).digest("hex"),
        byte_length: bytes.length },
    });

    const bad = await prepare();
    await upload(bad.receipt, corrupted);
    const rejected = await complete(bad.receipt.ingestion_id);
    assert.equal(rejected.statusCode, 422, rejected.body);
    assert.equal(rejected.json().error.retryable, false);
    const [failedIntent] = await adminDb`select status,rejection_reason from app.upload_intents
      where tenant_id = ${tenantId}::uuid and id = ${bad.receipt.ingestion_id}::uuid`;
    assert.equal(failedIntent?.status, "rejected");
    assert.equal(failedIntent?.rejection_reason, "hash_mismatch");
    const [before] = await adminDb`select count(*)::integer as total from app.evidence_blobs
      where tenant_id = ${tenantId}::uuid`;
    assert.equal(before?.total, 0);
    const [beforeJobs] = await adminDb`select count(*)::integer as total from app.jobs
      where tenant_id = ${tenantId}::uuid`;
    assert.equal(beforeJobs?.total, 0);

    const first = await prepare(bad.captureId);
    assert.notEqual(first.receipt.ingestion_id, bad.receipt.ingestion_id);
    const replay = await prepare(first.captureId, first.idempotency);
    assert.deepEqual(replay.receipt, first.receipt);
    const differentKey = await app.inject({ method: "POST", url: "/v1/ingestions",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { client_capture_id: first.captureId, sha256,
        byte_length: source.length, declared_mime: "text/plain" } });
    assert.equal(differentKey.statusCode, 409);
    // A field extract exists, but the original has never reached Storage.
    await adminDb`insert into app.evidence_blobs(tenant_id,sha256,byte_length,sniffed_mime,storage_key,scan_state,storage_location)
      values(${tenantId}::uuid,${sha256},${source.length},'application/octet-stream',${`${tenantId}/device-only/${sha256}`},'unsupported','device')`;
    await upload(first.receipt, source);
    const completionKey = randomUUID();
    const completed = await complete(first.receipt.ingestion_id, completionKey);
    assert.equal(completed.statusCode, 200, completed.body);
    assert.equal(completed.json().state, "queued");
    assert.ok(completed.json().job_id);
    assert.equal(completed.json().deduplicated, false);
    const original = await admin.storage.from(ORIGINAL_BUCKET).download(`${tenantId}/${first.receipt.ingestion_id}`);
    assert.ifError(original.error);
    assert.equal(createHash('sha256').update(Buffer.from(await original.data!.arrayBuffer())).digest('hex'),sha256);
    const [promoted]=await adminDb`select storage_location,storage_key from app.evidence_blobs where tenant_id=${tenantId}::uuid and sha256=${sha256}`;
    assert.equal(promoted?.storage_location,'server');assert.equal(promoted?.storage_key,`${tenantId}/${first.receipt.ingestion_id}`);
    const completeReplay = await complete(first.receipt.ingestion_id, completionKey);
    assert.deepEqual(completeReplay.json(), completed.json());
    const [queued] = await adminDb`select j.id, o.id as outbox_id
      from app.jobs j join app.outbox o on o.tenant_id = j.tenant_id
        and o.job_id = j.id where j.tenant_id = ${tenantId}::uuid`;
    assert.equal(queued?.id, completed.json().job_id);
    assert.ok(queued?.outbox_id);
    const unauthenticated = await client.storage.from(ORIGINAL_BUCKET)
      .download(`${tenantId}/${first.receipt.ingestion_id}`);
    assert.ok(unauthenticated.error, "Private original must not download with client key");

    const second = await prepare();
    await upload(second.receipt, source);
    const duplicate = await complete(second.receipt.ingestion_id);
    assert.equal(duplicate.statusCode, 200, duplicate.body);
    assert.equal(duplicate.json().deduplicated, true);
    assert.equal(duplicate.json().blob_id, completed.json().blob_id);
    assert.notEqual(duplicate.json().revision_id, completed.json().revision_id);
    const [counts] = await adminDb`select count(*)::integer as total from app.evidence_blobs
      where tenant_id = ${tenantId}::uuid`;
    assert.equal(counts?.total, 1);
    const [revisions] = await adminDb`select count(*)::integer as total from app.document_revisions
      where tenant_id = ${tenantId}::uuid`;
    assert.equal(revisions?.total, 2);
    const modified = Buffer.from("fixture C05: changed source remains private\n", "utf8");
    const resetBefore=(await app.inject({method:'GET',url:'/v1/sync/changes?sync_version=2',headers})).json().reset_sequence;
    const revisionFields = { document_id: completed.json().document_id,
      predecessor_revision_id: completed.json().revision_id, expected_version: 1 };
    const next = await prepare(randomUUID(), randomUUID(), { ...revisionFields,
      sha256: createHash("sha256").update(modified).digest("hex"),
      byte_length: modified.length });
    const competing = await prepare(randomUUID(), randomUUID(), { ...revisionFields,
      sha256: createHash("sha256").update(modified).digest("hex"),
      byte_length: modified.length });
    await upload(next.receipt, modified);
    await upload(competing.receipt, modified);
    const nextRevision = await complete(next.receipt.ingestion_id, randomUUID(), modified);
    assert.equal(nextRevision.statusCode, 200, nextRevision.body);
    assert.equal(nextRevision.json().document_id, completed.json().document_id);
    assert.notEqual(nextRevision.json().revision_id, completed.json().revision_id);
    const [chain] = await adminDb`select revision_number, predecessor_id
      from app.document_revisions where tenant_id = ${tenantId}::uuid
        and id = ${nextRevision.json().revision_id}::uuid`;
    assert.equal(Number(chain?.revision_number), 2);
    assert.equal(chain?.predecessor_id, completed.json().revision_id);
    assert.equal(nextRevision.json().revision_number,2);
    assert.equal((await complete(next.receipt.ingestion_id,randomUUID(),modified)).json().revision_number,2);
    const read=(url:string)=>app.inject({method:'GET',url,headers});
    const current=(await read('/v1/work/materials')).json().materials;
    assert.ok(current.some((m:any)=>m.id===nextRevision.json().revision_id&&m.revision_number===2));
    assert.ok(!current.some((m:any)=>m.id===completed.json().revision_id));
    assert.equal((await read('/v1/work/materials/'+completed.json().revision_id)).json().revision.latest_revision_id,nextRevision.json().revision_id);
    const feed=(await read('/v1/sync/changes?sync_version=2')).json();
    assert.ok(feed.changes.some((c:any)=>c.id===completed.json().revision_id&&c.tombstone));
    assert.ok(feed.changes.some((c:any)=>c.id===nextRevision.json().revision_id&&c.document_id===completed.json().document_id&&!c.tombstone));
    assert.equal(feed.reset_sequence,resetBefore,'a file edit must not reset every device or rehash every copy');
    assert.equal((await read('/v1/sync/changes?sync_version=2&cursor='+encodeURIComponent(feed.next_cursor))).json().changes.length,0);
    const staleCompletion = await complete(competing.receipt.ingestion_id, randomUUID(), modified);
    assert.equal(staleCompletion.statusCode, 409, staleCompletion.body);
    const [staleIntent] = await adminDb`select status,rejection_reason from app.upload_intents
      where tenant_id = ${tenantId}::uuid and id = ${competing.receipt.ingestion_id}::uuid`;
    assert.equal(staleIntent?.status, "rejected");
    assert.equal(staleIntent?.rejection_reason, "stale_document");
    const stale = await app.inject({ method: "POST", url: "/v1/ingestions",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { client_capture_id: randomUUID(), sha256,
        byte_length: source.length, declared_mime: "text/plain", ...revisionFields } });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json().error.details.current_version, 2);
    const large = Buffer.alloc(11 * 1024 * 1024 + 37, 0x61);
    const largeHash = createHash("sha256").update(large).digest("hex");
    const largePrepare = await app.inject({ method:"POST", url:"/v1/ingestions",
      headers:{ ...headers, "idempotency-key":randomUUID() },
      payload:{ client_capture_id:randomUUID(),sha256:largeHash,
        byte_length:large.length,declared_mime:"text/plain" } });
    assert.equal(largePrepare.statusCode,201,largePrepare.body);
    const largeIntent = largePrepare.json() as { ingestion_id:string; upload_url:string;
      upload:{endpoint:string;signature:string;object_name:string;bucket:string;chunk_bytes:number} };
    uploadedPaths.push(`${tenantId}/${largeIntent.ingestion_id}`);
    const fixtureUserId = userId;
    assert.ok(fixtureUserId);
    await adminDb.begin(async tx => {
      await tx`select set_config('request.jwt.claim.sub',${fixtureUserId},true)`;
      const [reserved] = await tx`select app.can_insert_original(
        ${`${tenantId}/${largeIntent.ingestion_id}`}) as allowed`;
      const [foreignPath] = await tx`select app.can_insert_original(
        ${`${randomUUID()}/${largeIntent.ingestion_id}`}) as allowed`;
      assert.equal(reserved?.allowed,true);
      assert.equal(foreignPath?.allowed,false);
    });
    const signature = largeIntent.upload.signature;
    assert.ok(signature);
    assert.equal(signature.split(".").length,3,"Signed TUS token must be a JWT");
    const resumable = new URL(largeIntent.upload.endpoint);
    const metadata = (value:string) => Buffer.from(value).toString("base64");
    const createdUpload = await fetch(resumable,{
      method:"POST",headers:{ "tus-resumable":"1.0.0",authorization:`Bearer ${token}`,
        "upload-length":String(large.length),"x-signature":signature,
        "upload-metadata":`bucketName ${metadata(largeIntent.upload.bucket)},objectName ${metadata(largeIntent.upload.object_name)},contentType ${metadata("text/plain")}` },
    });
    assert.equal(createdUpload.status,201,await createdUpload.text());
    const tusUrl = new URL(createdUpload.headers.get("location") ?? "",resumable);
    for (let offset=0;offset<large.length;) {
      const chunk = large.subarray(offset,Math.min(offset + 6 * 1024 * 1024,large.length));
      const sent: Response = await fetch(tusUrl,{ method:"PATCH",headers:{
        "tus-resumable":"1.0.0","upload-offset":String(offset),
        "content-type":"application/offset+octet-stream","x-signature":signature,
        authorization:`Bearer ${token}`,
      },body:chunk });
      assert.equal(sent.status,204,await sent.text());
      offset = Number(sent.headers.get("upload-offset"));
    }
    const largeComplete = await complete(largeIntent.ingestion_id,randomUUID(),large);
    assert.equal(largeComplete.statusCode,200,largeComplete.body);

    const expiring = await prepare();
    await adminDb`update app.upload_intents set expires_at = now() - interval '1 minute'
      where tenant_id = ${tenantId}::uuid and id = ${expiring.receipt.ingestion_id}::uuid`;
    const expired = await complete(expiring.receipt.ingestion_id);
    assert.equal(expired.statusCode, 410, expired.body);
    const expiredRetry = await prepare(expiring.captureId);
    assert.equal(expiredRetry.receipt.state, "prepared");
    const abandoning = await prepare();
    const abandonKey = randomUUID();
    const abandon = () => app.inject({ method:"POST",
      url:`/v1/ingestions/${abandoning.receipt.ingestion_id}/abandon`,
      headers:{...headers,"idempotency-key":abandonKey},
      payload:{sha256,byte_length:source.length} });
    const abandoned = await abandon();
    assert.equal(abandoned.statusCode,200,abandoned.body);
    assert.deepEqual(abandoned.json(),{ingestion_id:abandoning.receipt.ingestion_id,
      state:"rejected",reason:"client_abandoned"});
    assert.deepEqual((await abandon()).json(),abandoned.json());
    const [abandonedIntent] = await adminDb`select status,rejection_reason
      from app.upload_intents where tenant_id=${tenantId}::uuid
        and id=${abandoning.receipt.ingestion_id}::uuid`;
    assert.deepEqual({status:abandonedIntent?.status,
      reason:abandonedIntent?.rejection_reason},
      {status:"rejected",reason:"client_abandoned"});
    const abandonRetry = await prepare(abandoning.captureId);
    assert.notEqual(abandonRetry.receipt.ingestion_id,
      abandoning.receipt.ingestion_id);
    const verifiedAbandon = await app.inject({method:"POST",
      url:`/v1/ingestions/${first.receipt.ingestion_id}/abandon`,
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:{sha256,byte_length:source.length} });
    assert.equal(verifiedAbandon.statusCode,409,verifiedAbandon.body);
    const foreign = await app.inject({ method: "POST", url: `/v1/ingestions/${first.receipt.ingestion_id}/complete`,
      headers: { ...headers, "x-tenant-id": randomUUID(), "idempotency-key": randomUUID() },
      payload: { sha256, byte_length: source.length } });
    assert.equal(foreign.statusCode, 404, foreign.body);
  } finally {
    await app.close();
    await runtimeDb.end();
    if (tenantCreated) {
      await adminDb.begin(async tx => {
        await deleteFixtureTenants(tx,[tenantId]);
      });
    }
    await adminDb.end();
    if (uploadedPaths.length) {
      assert.ifError((await admin.storage.from(ORIGINAL_BUCKET).remove(uploadedPaths)).error);
    }
    if (userId) assert.ifError((await admin.auth.admin.deleteUser(userId)).error);
  }
});
