import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import postgres from "postgres";
import { renderToStaticMarkup } from "react-dom/server";
import { DirectoryView, fixtureDirectory, searchMaterials } from "../apps/web/src/directory.tsx";
import { demoReducer, emptySession } from "../apps/web/src/demo-session.ts";
import { createApp } from "../services/api/src/app.ts";
import { parseStrictLocalEnv } from "../scripts/local-env-values.mjs";
import { verifyLocalDevelopmentDb } from "../scripts/db-gate.mjs";

test("UX directories ask familiar questions and retain discoverable documents without internal categories", () => {
  const projects = renderToStaticMarkup(<DirectoryView mode="projects" />);
  const materials = renderToStaticMarkup(<DirectoryView mode="materials" />);
  assert.match(projects, /어느 현장이 궁금하세요/);
  assert.match(materials, /어떤 자료를 찾으세요/);
  assert.match(materials, /9월 자재 단가표/);
  assert.match(materials, /문틀 규격 안내/);
  assert.equal(searchMaterials(fixtureDirectory, "문틀").length, 2);
  assert.equal(searchMaterials(fixtureDirectory, "  새빛  ")[0]?.id, "e-2");
  assert.equal(searchMaterials(fixtureDirectory, "없는 이름").length, 0);
  for (const item of fixtureDirectory.evidence) {
    const detail = renderToStaticMarkup(<DirectoryView mode="materials" selectedId={item.id} />);
    assert.doesNotMatch(detail + materials + projects, /귀속|연결|객체|상태|미확정|기준자료|시트|I12|B4/);
  }
});

test("UX Today answer appears at the same site without another decision or a fabricated balance", () => {
  const session = demoReducer(emptySession, { type: "answer", id: "payment", answer: { choice: "yes" } });
  const html = renderToStaticMarkup(<DirectoryView mode="projects" selectedId="project-4" session={session} />);
  assert.match(html, /이미 보내셨다고 적어뒀어요/);
  assert.match(html, /보낸 돈은 아직 계산하지 않아요/);
  assert.match(html, /줄 돈<\/dt><dd>아직 계산 전/);
  assert.doesNotMatch(html, /0원|지급 완료|여기에 답하기/);
  const undone = demoReducer(session, { type: "undo", id: "payment" });
  const afterUndo = renderToStaticMarkup(<DirectoryView mode="projects" selectedId="project-4" session={undone} />);
  assert.doesNotMatch(afterUndo, /이미 보내셨다고/);
  assert.match(afterUndo, /여기에 답하기/);
});

test("UX cost matches the answer on the site and stays separate from unknown cash", () => {
  for (const choice of ["yes", "no"] as const) {
    const session = demoReducer(emptySession, { type: "answer", id: "duplicate", answer: { choice } });
    const html = renderToStaticMarkup(<DirectoryView mode="projects" selectedId="project-2" session={session} />);
    assert.ok(html.includes(`<dt>이 보수에 들어간 비용 · 예시</dt><dd>${choice === "yes" ? "150,000원" : "300,000원"}</dd>`));
    assert.match(html, /줄 돈<\/dt><dd>아직 계산 전/);
  }
});

test("C29 directory endpoints do not reveal foreign project, evidence, or search hits", async () => {
  assert.equal((await verifyLocalDevelopmentDb()).status, "READY");
  const env = parseStrictLocalEnv(readFileSync("services/api/.env", "utf8"));
  assert.ok(env.MIGRATION_DATABASE_URL && env.DATABASE_URL);
  const admin = postgres(env.MIGRATION_DATABASE_URL, { max: 1 });
  const runtime = postgres(env.DATABASE_URL, { max: 1 });
  const actor = randomUUID();
  const session = randomUUID();
  const ownTenant = randomUUID();
  const foreignTenant = randomUUID();
  const ownProject = randomUUID();
  const foreignProject = randomUUID();
  const ownRevision = randomUUID();
  const foreignRevision = randomUUID();
  const app = createApp({ db: runtime, verifyToken: async () => ({ userId: actor, sessionId: session }) });
  try {
    await admin.begin(async tx => {
      await tx`insert into auth.users(id) values (${actor}::uuid)`;
      await tx`insert into auth.sessions(id,user_id) values (${session}::uuid,${actor}::uuid)`;
      await tx`insert into app.tenants(id,display_name) values (${ownTenant}::uuid,'C29 own'),(${foreignTenant}::uuid,'C29 foreign')`;
      await tx`insert into app.memberships(tenant_id,user_id,role) values (${ownTenant}::uuid,${actor}::uuid,'owner')`;
      for (const item of [{ tenant: ownTenant, project: ownProject, revision: ownRevision },
        { tenant: foreignTenant, project: foreignProject, revision: foreignRevision }]) {
        await tx`insert into app.projects(tenant_id,id,display_name) values (${item.tenant}::uuid,${item.project}::uuid,'same project')`;
        const [blob] = await tx`insert into app.evidence_blobs(tenant_id,sha256,byte_length,sniffed_mime,storage_key)
          values (${item.tenant}::uuid,${"c".repeat(64)},1,'text/plain',${`${item.tenant}/c29`}) returning id`;
        const [document] = await tx`insert into app.documents(tenant_id) values (${item.tenant}::uuid) returning id`;
        await tx`insert into app.document_revisions(tenant_id,id,document_id,revision_number,blob_id,declared_mime)
          values (${item.tenant}::uuid,${item.revision}::uuid,${document?.id}::uuid,1,${blob?.id}::uuid,'text/plain')`;
        await tx`insert into app.evidence_index(tenant_id,revision_id,project_id,scope,category,display_title,search_text,locator,source_kind)
          values (${item.tenant}::uuid,${item.revision}::uuid,${item.project}::uuid,'project','delivery_work',
            'same title','needle',${tx.json({kind:"text",position:{line:1}})},'original')`;
      }
    });
    const headers = { authorization: "Bearer fixture", "x-tenant-id": ownTenant };
    const projectList = await app.inject({ method: "GET", url: "/v1/projects", headers });
    assert.equal(projectList.statusCode, 200, projectList.body);
    assert.equal(projectList.json().projects.length, 1);
    const own = await app.inject({ method: "GET", url: `/v1/projects/${ownProject}`, headers });
    assert.equal(own.statusCode, 200, own.body);
    const foreign = await app.inject({ method: "GET", url: `/v1/projects/${foreignProject}`, headers });
    assert.equal(foreign.statusCode, 404);
    const ownEvidence = await app.inject({ method: "GET", url: `/v1/evidence/${ownRevision}`, headers });
    assert.equal(ownEvidence.statusCode, 200, ownEvidence.body);
    const foreignEvidence = await app.inject({ method: "GET", url: `/v1/evidence/${foreignRevision}`, headers });
    assert.equal(foreignEvidence.statusCode, 404);
    const search = await app.inject({ method: "GET", url: "/v1/search?q=needle", headers });
    assert.equal(search.statusCode, 200, search.body);
    assert.equal(search.json().results.length, 1);
    assert.equal(search.json().results[0].revision_id, ownRevision);
    assert.equal(search.body.includes("search_text"), false);
  } finally {
    await app.close();
    await admin.begin(async tx => {
      await tx`delete from app.evidence_index where tenant_id in (${ownTenant}::uuid,${foreignTenant}::uuid)`;
      await tx`delete from app.document_revisions where tenant_id in (${ownTenant}::uuid,${foreignTenant}::uuid)`;
      await tx`delete from app.documents where tenant_id in (${ownTenant}::uuid,${foreignTenant}::uuid)`;
      await tx`delete from app.evidence_blobs where tenant_id in (${ownTenant}::uuid,${foreignTenant}::uuid)`;
      await tx`delete from app.projects where tenant_id in (${ownTenant}::uuid,${foreignTenant}::uuid)`;
      await tx`alter table app.memberships disable trigger memberships_guard`;
      await tx`delete from app.memberships where tenant_id=${ownTenant}::uuid`;
      await tx`alter table app.memberships enable trigger memberships_guard`;
      await tx`delete from app.tenants where id in (${ownTenant}::uuid,${foreignTenant}::uuid)`;
      await tx`delete from auth.sessions where id=${session}::uuid`;
      await tx`delete from auth.users where id=${actor}::uuid`;
    });
    await Promise.all([admin.end(), runtime.end()]);
  }
});

test("C29 new directory tables enforce RLS tenant isolation in local Supabase", async () => {
  assert.equal((await verifyLocalDevelopmentDb()).status, "READY");
  const env = parseStrictLocalEnv(readFileSync("services/api/.env", "utf8"));
  const url = env.MIGRATION_DATABASE_URL;
  assert.ok(url);
  const db = postgres(url, { max: 1 });
  const actor = randomUUID();
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const rollback = new Error("ROLLBACK_FIXTURE");
  try {
    await assert.rejects(db.begin(async tx => {
      await tx`insert into auth.users(id) values (${actor}::uuid)`;
      await tx`insert into app.tenants(id,display_name) values (${tenantA}::uuid,'C29 fixture A'),(${tenantB}::uuid,'C29 fixture B')`;
      await tx`insert into app.memberships(tenant_id,user_id,role) values (${tenantA}::uuid,${actor}::uuid,'owner')`;
      for (const tenant of [tenantA, tenantB]) {
        const [project] = await tx`insert into app.projects(tenant_id,display_name) values (${tenant}::uuid,'same name') returning id`;
        const [order] = await tx`insert into app.work_orders(tenant_id,project_id,display_name)
          values (${tenant}::uuid,${project?.id}::uuid,'one work') returning id`;
        await tx`insert into app.work_bundles(tenant_id,work_order_id,display_name,trade_pack_id,trade_pack_version,trade_pack_hash)
          values (${tenant}::uuid,${order?.id}::uuid,'bundle','generic','1.0.0',${"a".repeat(64)})`;
        const [blob] = await tx`insert into app.evidence_blobs(tenant_id,sha256,byte_length,sniffed_mime,storage_key)
          values (${tenant}::uuid,${"b".repeat(64)},1,'text/plain',${`${tenant}/fixture`}) returning id`;
        const [document] = await tx`insert into app.documents(tenant_id) values (${tenant}::uuid) returning id`;
        const [revision] = await tx`insert into app.document_revisions(tenant_id,document_id,revision_number,blob_id,declared_mime)
          values (${tenant}::uuid,${document?.id}::uuid,1,${blob?.id}::uuid,'text/plain') returning id`;
        await tx`insert into app.evidence_index(tenant_id,revision_id,project_id,scope,category,display_title,search_text,locator,source_kind)
          values (${tenant}::uuid,${revision?.id}::uuid,${project?.id}::uuid,'project','delivery_work',
            'same title','fixture',${tx.json({kind:"text",position:{line:1}})},'original')`;
      }
      await tx`select set_config('request.jwt.claim.sub',${actor},true)`;
      await tx.unsafe("set local role sigongnote_api");
      const bundles = await tx`select tenant_id from app.work_bundles`;
      const evidence = await tx`select tenant_id from app.evidence_index`;
      assert.deepEqual(bundles.map(row => row.tenant_id), [tenantA]);
      assert.deepEqual(evidence.map(row => row.tenant_id), [tenantA]);
      throw rollback;
    }), error => error === rollback);
  } finally { await db.end(); }
});
