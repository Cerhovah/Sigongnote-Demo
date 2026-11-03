import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import postgres from "postgres";
import { parseStrictLocalEnv } from "../scripts/local-env-values.mjs";
import { verifyLocalDevelopmentDb } from "../scripts/db-gate.mjs";
import { createApp } from "../services/api/src/app.ts";

test("C30 scoped decisions use CAS, idempotency, audit and never confirm money implicitly", async () => {
  assert.equal((await verifyLocalDevelopmentDb()).status, "READY");
  const env = parseStrictLocalEnv(readFileSync("services/api/.env", "utf8"));
  assert.ok(env.MIGRATION_DATABASE_URL && env.DATABASE_URL);
  const admin = postgres(env.MIGRATION_DATABASE_URL, { max: 1 });
  const runtime = postgres(env.DATABASE_URL, { max: 2 });
  const actor = randomUUID(); const session = randomUUID(); const tenant = randomUUID();
  const project = randomUUID(); const exception = randomUUID();
  const revisions: [string,string] = [randomUUID(), randomUUID()];
  const evidenceIds: [string,string] = [randomUUID(), randomUUID()];
  const app = createApp({ db: runtime, verifyToken: async () => ({ userId: actor, sessionId: session }) });
  let seeded = false;
  try {
    await admin.begin(async tx => {
      await tx`insert into auth.users(id) values (${actor}::uuid)`;
      await tx`insert into auth.sessions(id,user_id) values (${session}::uuid,${actor}::uuid)`;
      await tx`insert into app.tenants(id,display_name) values (${tenant}::uuid,'C30 fixture')`;
      await tx`insert into app.memberships(tenant_id,user_id,role) values (${tenant}::uuid,${actor}::uuid,'owner')`;
      await tx`insert into app.projects(tenant_id,id,display_name) values (${tenant}::uuid,${project}::uuid,'C30 site')`;
      for (let i = 0; i < 2; i++) {
        const revisionId = revisions[i]; const evidenceId = evidenceIds[i];
        assert.ok(revisionId && evidenceId);
        const [blob] = await tx`insert into app.evidence_blobs(tenant_id,sha256,byte_length,sniffed_mime,storage_key)
          values (${tenant}::uuid,${String(i).repeat(64)},1,'text/plain',${`${tenant}/c30-${i}`}) returning id`;
        const [document] = await tx`insert into app.documents(tenant_id) values (${tenant}::uuid) returning id`;
        await tx`insert into app.document_revisions(tenant_id,id,document_id,revision_number,blob_id,declared_mime)
          values (${tenant}::uuid,${revisionId}::uuid,${document?.id}::uuid,1,${blob?.id}::uuid,'text/plain')`;
        await tx`insert into app.evidence_index(tenant_id,id,revision_id,scope,category,display_title,search_text,locator,source_kind)
          values (${tenant}::uuid,${evidenceId}::uuid,${revisionId}::uuid,'unassigned','delivery_work',
            'candidate','needle',${tx.json({kind:"text",position:{line:i+1}})},'original')`;
      }
      await tx`insert into app.exception_cases(tenant_id,id,cause_key,cause,due_at)
        values (${tenant}::uuid,${exception}::uuid,'payment-1','payment_due',${new Date(Date.now()+172800000)})`;
    });
    seeded = true;
    await runtime.begin(async tx => {
      await tx`select set_config('request.jwt.claim.sub',${actor},true)`;
      const [active] = await tx`select app.session_is_active(${actor}::uuid,${session}::uuid) as value`;
      const rows = await tx`select id from app.evidence_index where tenant_id=${tenant}::uuid
        and id=any(${tx.array([evidenceIds[0]],2950)})`;
      assert.equal(active?.value, true);
      assert.equal(rows.length, 1);
    });
    const baseHeaders = { authorization: "Bearer fixture", "x-tenant-id": tenant };
    const key = randomUUID();
    const payload = { scope: "project_attribution", targets: [{ type: "evidence_index", id: evidenceIds[0], version: 1 }],
      choice: "confirm_project", project_id: project, reason: "원문과 현장 대조 완료",
      evidence_ids: [evidenceIds[0]] };
    const request = (idem: string, version: number) => app.inject({ method: "POST", url: "/v1/decisions",
      headers: { ...baseHeaders, "idempotency-key": idem, "if-match": `"${version}"` }, payload });
    const [first, concurrentReplay] = await Promise.all([request(key, 1), request(key, 1)]);
    assert.equal(first.statusCode, 201, first.body);
    assert.equal(concurrentReplay?.statusCode, 201, concurrentReplay?.body);
    assert.deepEqual(concurrentReplay?.json(), first.json());
    assert.equal(first.json().money_confirmed, false);
    assert.equal(first.json().payment_confirmed, false);
    const replay = await request(key, 1);
    assert.equal(replay.statusCode, first.statusCode);
    assert.deepEqual(replay.json(), first.json());
    const changedBody = await app.inject({ method: "POST", url: "/v1/decisions",
      headers: { ...baseHeaders, "idempotency-key": key, "if-match": '"1"' },
      payload: { ...payload, choice: "reject_candidate", project_id: undefined } });
    assert.equal(changedBody.statusCode, 409);
    assert.equal(changedBody.json().error.code, "IDEMPOTENCY_CONFLICT");
    assert.equal((await request(randomUUID(), 1)).statusCode, 409);
    const [audit] = await admin`select count(*)::int as n from app.decisions where tenant_id=${tenant}::uuid`;
    assert.equal(audit?.n, 1);
    const [attribution] = await admin`select version,project_id from app.evidence_attributions
      where tenant_id=${tenant}::uuid and evidence_index_id=${evidenceIds[0]}::uuid`;
    assert.equal(Number(attribution?.version), 2);
    assert.equal(attribution?.project_id, project);
    const search = await app.inject({ method: "GET", url: "/v1/search?q=needle", headers: baseHeaders });
    assert.equal(search.statusCode, 200, search.body);
    assert.deepEqual(search.json().results.map((item: {scope:string}) => item.scope).sort(), ["project","unassigned"]);
    const corrected = await app.inject({ method: "POST", url: "/v1/decisions",
      headers: { ...baseHeaders, "idempotency-key": randomUUID(), "if-match": '"2"' },
      payload: { scope: "project_attribution", targets: [{ type: "evidence_index", id: evidenceIds[0], version: 2 }],
        choice: "reject_candidate", reason: "현장 귀속 근거 재검토", evidence_ids: [evidenceIds[0]] } });
    assert.equal(corrected.statusCode, 201, corrected.body);
    assert.equal(corrected.json().target_version, 3);
    const [correctedRow] = await admin`select state,project_id from app.evidence_attributions
      where tenant_id=${tenant}::uuid and evidence_index_id=${evidenceIds[0]}::uuid`;
    assert.equal(correctedRow?.state, "rejected");
    assert.equal(correctedRow?.project_id, null);
    const [history] = await admin`select count(*)::int as n from app.decisions where tenant_id=${tenant}::uuid
      and scope='project_attribution'`;
    assert.equal(history?.n, 2);
    const identity = await app.inject({ method: "POST", url: "/v1/decisions",
      headers: { ...baseHeaders, "idempotency-key": randomUUID(), "if-match": '"1"' },
      payload: { scope: "economic_transaction_identity", choice: "distinct_transaction",
        targets: revisions.map(id => ({ type: "document_revision", id, version: 1 })),
        evidence_ids: evidenceIds, reason: "운송 지시가 다른 별도 거래" } });
    assert.equal(identity.statusCode, 201, identity.body);
    assert.equal(identity.json().cost_confirmed, false);
    const review = new Date(Date.now()+86400000).toISOString();
    const defer = await app.inject({ method: "POST", url: `/v1/exceptions/${exception}/defer`,
      headers: { ...baseHeaders, "idempotency-key": randomUUID(), "if-match": '"1"' },
      payload: { reason: "지급 근거 확인 예정", next_review_at: review } });
    assert.equal(defer.statusCode, 200, defer.body);
    assert.equal(defer.json().unresolved, true);
    assert.equal(defer.json().exception.state, "deferred");
  } finally {
    await app.close();
    if (seeded) await admin.begin(async tx => {
      await tx`delete from app.command_receipts where tenant_id=${tenant}::uuid`;
      await tx`delete from app.exception_events where tenant_id=${tenant}::uuid`;
      await tx`delete from app.exception_cases where tenant_id=${tenant}::uuid`;
      await tx`delete from app.evidence_attributions where tenant_id=${tenant}::uuid`;
      await tx`delete from app.transaction_identities where tenant_id=${tenant}::uuid`;
      await tx`delete from app.decisions where tenant_id=${tenant}::uuid`;
      await tx`delete from app.evidence_index where tenant_id=${tenant}::uuid`;
      await tx`delete from app.document_revisions where tenant_id=${tenant}::uuid`;
      await tx`delete from app.documents where tenant_id=${tenant}::uuid`;
      await tx`delete from app.evidence_blobs where tenant_id=${tenant}::uuid`;
      await tx`delete from app.projects where tenant_id=${tenant}::uuid`;
      await tx`alter table app.memberships disable trigger memberships_guard`;
      await tx`delete from app.memberships where tenant_id=${tenant}::uuid`;
      await tx`alter table app.memberships enable trigger memberships_guard`;
      await tx`delete from app.tenants where id=${tenant}::uuid`;
      await tx`delete from auth.sessions where id=${session}::uuid`;
      await tx`delete from auth.users where id=${actor}::uuid`;
    });
    await Promise.all([admin.end(),runtime.end()]);
  }
});
