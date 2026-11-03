import {deleteFixtureTenants} from './fixture-cleanup.js';
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { parseStrictLocalEnv } from "../scripts/local-env-values.mjs";
import { verifyLocalDevelopmentDb } from "../scripts/db-gate.mjs";

test("C06 lease expiry, one effect, bounded retry and dead-letter on real Postgres", async () => {
  assert.equal((await verifyLocalDevelopmentDb()).status, "READY");
  const env = parseStrictLocalEnv(readFileSync("services/api/.env", "utf8"));
  const setting = (key: string) => {
    const value = env[key];
    assert.ok(value, `Missing local test setting: ${key}`);
    return value;
  };
  const adminAuth = createClient(setting("SUPABASE_URL"), setting("SUPABASE_SECRET_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const admin = postgres(setting("MIGRATION_DATABASE_URL"), { max: 1 });
  const runtime = postgres(setting("DATABASE_URL"), { max: 2 });
  const worker = postgres(setting("WORKER_DATABASE_URL"), { max: 2 });
  const tenantId = randomUUID();
  const tenantBId = randomUUID();
  const hash = randomBytes(32).toString("hex");
  let userId: string | undefined;
  let tenantCreated = false;
  let tenantBCreated = false;
  try {
    const created = await adminAuth.auth.admin.createUser({
      email: `c06-${randomUUID()}@example.invalid`,
      password: randomBytes(24).toString("hex"), email_confirm: true,
    });
    assert.ifError(created.error);
    userId = created.data.user?.id;
    assert.ok(userId);
    await admin`insert into app.tenants(id,display_name)
      values (${tenantId}::uuid,'fixture C06 tenant')`;
    tenantCreated = true;
    await admin`insert into app.memberships(tenant_id,user_id,role)
      values (${tenantId}::uuid,${userId}::uuid,'owner')`;
    const [blob] = await admin`insert into app.evidence_blobs
      (tenant_id,sha256,byte_length,sniffed_mime,storage_key)
      values (${tenantId}::uuid,${hash},1,'text/plain',${`${tenantId}/${randomUUID()}`})
      returning id`;
    assert.ok(blob);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const [document] = await admin`insert into app.documents(tenant_id)
        values (${tenantId}::uuid) returning id`;
      assert.ok(document);
      const [revision] = await admin`insert into app.document_revisions
        (tenant_id,document_id,revision_number,blob_id,declared_mime)
        values (${tenantId}::uuid,${document.id}::uuid,1,${blob.id}::uuid,
          'text/plain') returning id`;
      assert.ok(revision);
      const [job] = await admin`insert into app.jobs
        (tenant_id,job_type,evidence_revision_id,processor_version,input_hash)
        values (${tenantId}::uuid,'parse_original',${revision.id}::uuid,
          'fixture-v1',${hash}) returning id`;
      assert.ok(job);
      ids.push(job.id as string);
      await admin`insert into app.outbox(tenant_id,job_id,topic,operation_key)
        values (${tenantId}::uuid,${job.id}::uuid,'parse_original_ready',
          ${`parse_original:${job.id}`})`;
    }
    const [firstId, secondId, thirdId] = ids;
    assert.ok(firstId && secondId && thirdId);
    await admin`insert into app.tenants(id,display_name)
      values (${tenantBId}::uuid,'fixture C06 second tenant')`;
    tenantBCreated = true;
    await admin`insert into app.memberships(tenant_id,user_id,role)
      values (${tenantBId}::uuid,${userId}::uuid,'owner')`;
    const [otherBlob] = await admin`insert into app.evidence_blobs
      (tenant_id,sha256,byte_length,sniffed_mime,storage_key)
      values (${tenantBId}::uuid,${hash},1,'text/plain',
        ${`${tenantBId}/${randomUUID()}`}) returning id`;
    assert.ok(otherBlob);
    const [otherDocument] = await admin`insert into app.documents(tenant_id)
      values (${tenantBId}::uuid) returning id`;
    assert.ok(otherDocument);
    const [otherRevision] = await admin`insert into app.document_revisions
      (tenant_id,document_id,revision_number,blob_id,declared_mime)
      values (${tenantBId}::uuid,${otherDocument.id}::uuid,1,
        ${otherBlob.id}::uuid,'text/plain') returning id`;
    assert.ok(otherRevision);
    const [otherJob] = await admin`insert into app.jobs
      (tenant_id,job_type,evidence_revision_id,processor_version,input_hash,available_at)
      values (${tenantBId}::uuid,'parse_original',${otherRevision.id}::uuid,
        'fixture-v1',${hash},now() + interval '1 hour') returning id`;
    assert.ok(otherJob);
    const noDirectRows = await runtime`select id from app.jobs
      where tenant_id = ${tenantId}::uuid`;
    assert.equal(noDirectRows.length, 0, "RLS denies a runtime role without request context");
    const [privileges] = await admin`select
      has_function_privilege('authenticated',
        'app.claim_parse_job(text,integer)', 'EXECUTE') as browser_claim,
      has_function_privilege('authenticated',
        'app.complete_parse_job(uuid,uuid,uuid,text)', 'EXECUTE') as browser_complete,
      has_function_privilege('sigongnote_api',
        'app.claim_parse_job(text,integer)', 'EXECUTE') as api_claim,
      has_function_privilege('sigongnote_api',
        'app.extend_parse_job_lease(uuid,uuid,uuid,integer)', 'EXECUTE') as api_extend,
      has_function_privilege('sigongnote_api',
        'app.complete_parse_job(uuid,uuid,uuid,text)', 'EXECUTE') as api_complete,
      has_function_privilege('sigongnote_api',
        'app.fail_parse_job(uuid,uuid,uuid,text,boolean)', 'EXECUTE') as api_fail,
      has_function_privilege('sigongnote_worker',
        'app.claim_parse_job(text,integer)', 'EXECUTE') as worker_claim`;
    assert.equal(privileges?.browser_claim, false);
    assert.equal(privileges?.browser_complete, false);
    assert.equal(privileges?.api_claim, false);
    assert.equal(privileges?.api_extend, false);
    assert.equal(privileges?.api_complete, false);
    assert.equal(privileges?.api_fail, false);
    assert.equal(privileges?.worker_claim, true);
    await assert.rejects(runtime`select * from app.claim_parse_job('fixture-worker',60)`,
      /permission denied/);
    await assert.rejects(worker`select id from app.jobs`, /permission denied/);

    const [lease1] = await worker`select * from app.claim_parse_job_for_tenant('fixture-worker-a',60,'fixture-v1',${tenantId}::uuid)`;
    assert.equal(lease1?.job_id, firstId);
    assert.equal(lease1?.tenant_id, tenantId);
    assert.equal(lease1?.attempt_count, 1);
    assert.equal(lease1?.expected_sha256, hash);
    const extended = await worker`select app.extend_parse_job_lease(
      ${tenantId}::uuid,${firstId}::uuid,${lease1.lease_token}::uuid,60) as ok`;
    assert.equal(extended[0]?.ok, true);
    const wrongExtension = await worker`select app.extend_parse_job_lease(
      ${tenantId}::uuid,${firstId}::uuid,${randomUUID()}::uuid,60) as ok`;
    assert.equal(wrongExtension[0]?.ok, false);
    await admin`update app.jobs set lease_expires_at = now() - interval '1 second'
      where tenant_id = ${tenantId}::uuid and id = ${firstId}::uuid`;
    const [lease2] = await worker`select * from app.claim_parse_job_for_tenant('fixture-worker-b',60,'fixture-v1',${tenantId}::uuid)`;
    assert.equal(lease2?.job_id, firstId);
    assert.equal(lease2?.attempt_count, 2);
    assert.notEqual(lease2?.lease_token, lease1.lease_token);
    const resultHash = randomBytes(32).toString("hex");
    const stale = await worker`select app.complete_parse_job(
      ${tenantId}::uuid,${firstId}::uuid,${lease1.lease_token}::uuid,${resultHash}) as ok`;
    assert.equal(stale[0]?.ok, false);
    const complete = await worker`select app.complete_parse_job(
      ${tenantId}::uuid,${firstId}::uuid,${lease2.lease_token}::uuid,${resultHash}) as ok`;
    assert.equal(complete[0]?.ok, true);
    const replay = await worker`select app.complete_parse_job(
      ${tenantId}::uuid,${firstId}::uuid,${lease2.lease_token}::uuid,${resultHash}) as ok`;
    assert.equal(replay[0]?.ok, true);
    const changed = await worker`select app.complete_parse_job(
      ${tenantId}::uuid,${firstId}::uuid,${lease2.lease_token}::uuid,
      ${randomBytes(32).toString("hex")}) as ok`;
    assert.equal(changed[0]?.ok, false);
    const [effectCount] = await admin`select count(*)::integer as total from app.job_effects
      where tenant_id = ${tenantId}::uuid and job_id = ${firstId}::uuid`;
    assert.equal(effectCount?.total, 1);

    const [deterministic] = await worker`select * from app.claim_parse_job_for_tenant('fixture-worker',60,'fixture-v1',${tenantId}::uuid)`;
    assert.equal(deterministic?.job_id, secondId);
    const [dead] = await worker`select app.fail_parse_job(
      ${tenantId}::uuid,${secondId}::uuid,${deterministic.lease_token}::uuid,
      'INVALID_FORMAT',false) as state`;
    assert.equal(dead?.state, "dead");

    for (let attempt = 1; attempt <= 5; attempt++) {
      const [lease] = await worker`select * from app.claim_parse_job_for_tenant('fixture-worker',60,'fixture-v1',${tenantId}::uuid)`;
      assert.equal(lease?.job_id, thirdId);
      assert.equal(lease?.attempt_count, attempt);
      const failureRows: ReadonlyArray<{ state: string }> = await worker`select app.fail_parse_job(
        ${tenantId}::uuid,${thirdId}::uuid,${lease.lease_token}::uuid,
        'TEMPORARY_FAILURE',true) as state`;
      assert.equal(failureRows[0]?.state, attempt < 5 ? "retry_wait" : "dead");
      if (attempt < 5) {
        const [timing] = await admin`select extract(epoch from (available_at - now()))::integer
          as seconds from app.jobs where tenant_id = ${tenantId}::uuid
            and id = ${thirdId}::uuid`;
        const minutes = [1, 5, 30, 120][attempt - 1] ?? 0;
        assert.ok(Number(timing?.seconds) >= minutes * 60 - 5);
        const [early] = await worker`select * from app.claim_parse_job_for_tenant('fixture-worker',60,'fixture-v1',${tenantId}::uuid)`;
        assert.equal(early, undefined);
        await admin`update app.jobs set available_at = now() - interval '1 second'
          where tenant_id = ${tenantId}::uuid and id = ${thirdId}::uuid`;
      }
    }
    const afterDead = await worker`select * from app.claim_parse_job_for_tenant('fixture-worker',60,'fixture-v1',${tenantId}::uuid)`;
    assert.equal(afterDead.length, 0);
    await admin`update app.jobs set available_at = now() - interval '1 second'
      where tenant_id = ${tenantBId}::uuid and id = ${otherJob.id}::uuid`;
    const [crossTenant] = await worker`select * from app.claim_parse_job_for_tenant('fixture-worker',60,'fixture-v1',${tenantBId}::uuid)`;
    assert.equal(crossTenant?.tenant_id, tenantBId);
    assert.equal(crossTenant?.job_id, otherJob.id);
    const [crossComplete] = await worker`select app.complete_parse_job(
      ${tenantBId}::uuid,${otherJob.id}::uuid,${crossTenant.lease_token}::uuid,
      ${randomBytes(32).toString("hex")}) as ok`;
    assert.equal(crossComplete?.ok, true);
    const [totalEffects] = await admin`select count(*)::integer as total from app.job_effects
      where tenant_id = ${tenantId}::uuid`;
    assert.equal(totalEffects?.total, 1);
    const [outboxCount] = await admin`select count(*)::integer as total from app.outbox
      where tenant_id = ${tenantId}::uuid`;
    assert.equal(outboxCount?.total, 3);
  } finally {
    await runtime.end();
    await worker.end();
    await admin.begin(async tx=>{await deleteFixtureTenants(tx,[...(tenantCreated?[tenantId]:[]),...(tenantBCreated?[tenantBId]:[])]);});
    await admin.end();
    if (userId) assert.ifError((await adminAuth.auth.admin.deleteUser(userId)).error);
  }
});
