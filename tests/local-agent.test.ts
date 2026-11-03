import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LocalAgent, inside, sha256 } from "../services/local-agent/src/agent.js";
import { LocalAi } from "../services/local-agent/src/ai.js";
const session=async()=>({apiUrl:"https://api.sigongnote.invalid",accessToken:"test-token",tenantId:"00000000-0000-4000-8000-000000000002",userId:"00000000-0000-4000-8000-000000000001",deviceId:"00000000-0000-4000-8000-000000000003"});
import { createLocalServer } from "../services/local-agent/src/server.js";
import type { Parser } from "../services/local-agent/src/parser.js";
import { CopyProtection } from "../services/local-agent/src/protection.js";

const testProtection = () => new CopyProtection(Buffer.alloc(32, 7));

const parse: Parser = async file => {
  const bytes = await readFile(file);
  return { status: "complete", sourceHash: sha256(bytes), parserVersion: "test/1", issues: [], spans: [{ locator: "line:1", text: bytes.toString("utf8") }] };
};
async function fixture(parser = parse) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "sigongnote-local-test-"));
  const root = path.join(temp, "business"); const data = path.join(temp, "private");
  await mkdir(root); await mkdir(data);
  await writeFile(path.join(root, "납품.txt"), "테스트 현장 자재 5개를 준비해 주세요.");
  const agent = new LocalAgent(data, parser, testProtection());
  const source = await agent.grant(root, "explicit_user_request");
  const clean = async () => {
    await agent.stop(); agent.close();
    assert(inside(os.tmpdir(), temp) && path.basename(temp).startsWith("sigongnote-local-test-"));
    await rm(temp, { recursive: true, force: true });
  };
  return { agent, root, data, source, clean };
}

test("local agent persists real file evidence, search, revision history and read-only hashes", async () => {
  const f = await fixture();
  try {
    const before = sha256(await readFile(path.join(f.root, "납품.txt")));
    await f.agent.start();
    const doc = f.agent.search("자재").documents[0]; assert(doc);
    assert.equal(doc.hash, before); assert.equal(doc.revision, 1);
    await f.agent.start();
    assert.equal(f.agent.document(doc.id).revision, 1);
    assert.equal(sha256(await readFile(path.join(f.root, "납품.txt"))), before);
    await writeFile(path.join(f.root, "납품.txt"), "수정: 자재 7개를 준비해 주세요.");
    await f.agent.start();
    assert.equal(f.agent.document(doc.id).revision, 2);
    assert.equal(f.agent.db.prepare("SELECT count(*) AS n FROM revisions").get()?.n, 2);
    const reopened = new LocalAgent(f.data, parse, testProtection());
    assert.equal(reopened.search("7개").total, 1); reopened.close();
  } finally { await f.clean(); }
});
test("local agent refuses overlapping/generated/output roots and skips links", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.agent.grant(f.data, "native_picker"), /INVALID_ROOT/);
    await mkdir(path.join(f.root, "nested"));
    await assert.rejects(f.agent.grant(path.join(f.root, "nested"), "native_picker"), /OVERLAPPING_ROOT/);
    await mkdir(path.join(f.root, "generated"));
    await writeFile(path.join(f.root, "generated", "sigongnote-generated.json"), "{}");
    await writeFile(path.join(f.root, "generated", "견적.txt"), "must not ingest");
    await symlink(f.data, path.join(f.root, "junction"), process.platform === "win32" ? "junction" : "dir");
    await f.agent.start(); assert.equal(f.agent.search().total, 1);
    const id = f.agent.search().documents[0]?.id; assert(id);
    f.agent.db.prepare("UPDATE documents SET relative_path=? WHERE id=?").run("../private/index.sqlite", id);
    await assert.rejects(f.agent.sourcePath(f.agent.document(id)), /OUTSIDE_SCOPE/);
  } finally { await f.clean(); }
});
test("revoke during parsing prevents publishing and blocks reading cached evidence", async () => {
  let release: (() => void) | undefined;
  const f = await fixture(async file => { await new Promise<void>(resolve => { release = resolve; }); return parse(file, ""); });
  try {
    await f.agent.inventory(f.source);
    const doc = f.agent.search().documents[0]; assert(doc);
    const running = f.agent.capture(doc.id);
    while (!release) await new Promise(resolve => setTimeout(resolve, 5));
    f.agent.setEnabled(f.source.id, false); release(); await running;
    assert.equal(f.agent.search().total, 0); assert.equal(f.agent.document(doc.id).hash, null);
    await assert.rejects(f.agent.snapshot(doc.id), /SCOPE_REVOKED/);
  } finally { await f.clean(); }
});
test("copy approvals are bounded, revision-scoped, replay safe and never alter originals", async () => {
  const f = await fixture();
  try {
    await f.agent.start(); const doc = f.agent.search().documents[0]; assert(doc);
    const plan = f.agent.planCopies([doc.id]);
    assert.equal(plan.items[0]?.site, null); // Unknown site does not become a fake project.
    await f.agent.executeCopies(plan.id);
    assert.equal((await f.agent.executeCopies(plan.id)).replay, true);
    assert.equal(sha256(await readFile(path.join(plan.destination, plan.items[0]?.destination ?? ""))), doc.hash);
    assert.equal(sha256(await readFile(path.join(f.root, doc.name))), doc.hash);
    const stale = f.agent.planCopies([doc.id]);
    f.agent.answerSite(doc.id, doc.revision, "테스트 현장");
    await assert.rejects(f.agent.executeCopies(stale.id), /STALE_PLAN/);
    assert.throws(() => f.agent.answerSite(doc.id, 0, "다른 현장"), /STALE_DOCUMENT/);
    assert.throws(() => f.agent.answerSite(doc.id, doc.revision, "../outside"), /INVALID_LABEL/);
    const revoked = f.agent.planCopies([doc.id]);
    f.agent.setEnabled(f.source.id, false); f.agent.setEnabled(f.source.id, true);
    await assert.rejects(f.agent.executeCopies(revoked.id), /STALE_PLAN/);
  } finally { await f.clean(); }
});
test("local HTTP API requires paired cookie, strict loopback Host and same-origin write", async () => {
  const f = await fixture();
  const ai = new LocalAi(f.agent, { dailyCalls: 0 });
  const app = createLocalServer(f.agent, ai, { port: 5174, pairToken: "test-only-pair-token", webDir: f.data });
  const headers = { host: "127.0.0.1:5174", "x-sigongnote-local": "1" };
  try {
    assert.equal((await app.inject({ url: "/api/status", headers })).statusCode, 401);
    assert.equal((await app.inject({ url: "/api/status", headers: { ...headers, host: "attacker.invalid" } })).statusCode, 403);
    const paired = await app.inject({ method: "POST", url: "/api/pair", headers, payload: { token: "test-only-pair-token" } });
    assert.equal(paired.statusCode, 200);
    const cookie = String(paired.headers["set-cookie"]).split(";")[0] ?? "";
    assert.equal((await app.inject({ url: "/api/status", headers: { ...headers, cookie } })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/api/scan", headers: { ...headers, cookie, origin: "https://attacker.invalid" }, payload: {} })).statusCode, 403);
    assert.equal((await app.inject({ url: "/api/status", headers: { host: headers.host, cookie } })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: "/api/folders/pick", headers: { ...headers, cookie }, payload: { root: "arbitrary" } })).statusCode, 409);
    assert.equal((await app.inject({ url: "/.env", headers })).statusCode, 404);
  } finally { await app.close(); await f.clean(); }
});
test("external AI requires exact snapshot consent, relays only masked spans to the server Claude runtime and cannot execute writes", async () => {
  const f = await fixture(); let calls = 0;
  const request: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(String(url), "https://api.sigongnote.invalid/v1/ai/document-summary");
    const headers = options?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer test-token"); assert.equal(headers["X-Tenant-Id"], "00000000-0000-4000-8000-000000000002");
    const body = JSON.parse(String(options?.body));
    assert.equal(typeof body.document_id, "string"); assert.match(body.source_hash, /^[a-f0-9]{64}$/);
    assert.ok(Array.isArray(body.spans) && body.spans.length >= 1 && body.spans.length <= 40);
    assert.equal(body.key, undefined); assert.equal(body.tools, undefined);
    const spans = body.spans;
    return new Response(JSON.stringify({ state: "complete", receipt: "session-test", usage: { input_tokens: 100, output_tokens: 100, cost_krw: 2 }, proposal: {
      summary: "자재 준비 요청", question: "자재가 도착했나요?", category: "납품", evidence: [{ locator: spans[0].locator, quote: spans[0].text }],
    } }), { status: 200 });
  };
  try {
    await f.agent.start(); const doc = f.agent.search().documents[0]; assert(doc);
    assert.throws(() => new LocalAi(f.agent, { dailyCalls: 0 }).prepare(doc.id), /AI_NOT_CONFIGURED/);
    assert.throws(() => new LocalAi(f.agent, { dailyCalls: 1 }).prepare(doc.id), /AI_NOT_CONFIGURED/);
    const ai = new LocalAi(f.agent, { dailyCalls: 1, session }, request);
    assert.equal(ai.info().provider, "Claude (시공노트 서버)"); assert.equal(ai.info().model, "claude-sonnet-5");
    const consent = ai.prepare(doc.id);
    await assert.rejects(ai.send(consent.id, false), /EXTERNAL_AI_NOT_CONSENTED/);
    assert.equal(calls, 0);
    await ai.send(consent.id, true); assert.equal(calls, 1);
    await assert.rejects(ai.send(consent.id, true), /CONSENT_EXPIRED_OR_USED/);
    const cached=ai.prepare(doc.id);
    await ai.send(cached.id,true); assert.equal(calls,1);
    assert.equal(f.agent.db.prepare('SELECT status FROM ai_requests WHERE id=?').get(cached.id)?.status,'complete');
    assert.equal(f.agent.document(doc.id).site, null);
    assert.equal(sha256(await readFile(path.join(f.root, doc.name))), doc.hash);
  } finally { await f.clean(); }
});
test("external AI rejects server/provider limit violations without retries or unpaid assumptions", async () => {
  const f=await fixture(); let calls=0;
  try {
    await f.agent.start(); const doc=f.agent.search().documents[0]; assert(doc);
    const request:typeof fetch=async(_url,options)=>{
      calls++; const spans=JSON.parse(String(options?.body)).spans;
      const proposal={summary:calls===2?'a'.repeat(701):'자재',question:'도착했나요?',category:'납품',
        evidence:Array.from({length:calls===1?9:1},()=>({locator:spans[0].locator,quote:spans[0].text}))};
      return new Response(JSON.stringify({state:'complete',receipt:'session-test',usage:{input_tokens:100,output_tokens:100},proposal}));
    };
    const ai=new LocalAi(f.agent,{dailyCalls:2,session},request);
    for(let i=0;i<2;i++){
      const item=ai.prepare(doc.id);
      await assert.rejects(ai.send(item.id,true),/AI_FAILED_NO_AUTOMATIC_RETRY/);
      const row=f.agent.db.prepare('SELECT result_code,charged_micro,reserved_micro FROM ai_usage WHERE request_id=?').get(item.id);
      assert.equal(row?.result_code,'invalid_response');assert(Number(row?.reserved_micro)>0);
    }
    await assert.rejects(ai.send(ai.prepare(doc.id).id,true),/DAILY_CALL_LIMIT/);assert.equal(calls,2);
  } finally {await f.clean();}
});
test("external AI skips locators that cannot fit the response contract", async()=>{
  const f=await fixture(async file=>{const raw=await readFile(file);return {status:'complete',sourceHash:sha256(raw),parserVersion:'test/1',issues:[],spans:[{locator:'x'.repeat(301),text:'자재'}]};});
  try{await f.agent.start();const doc=f.agent.search().documents[0];assert(doc);
    const ai=new LocalAi(f.agent,{dailyCalls:1,session});
    assert.throws(()=>ai.prepare(doc.id),/NO_READABLE_TEXT/);
  }finally{await f.clean();}
});
test("external AI fails closed on stale consent and invented evidence", async () => {
  const f = await fixture(); let calls = 0;
  const request: typeof fetch = async () => { calls++; return new Response(JSON.stringify({ state: "complete", receipt: "session-test", usage: { input_tokens: 100, output_tokens: 100 }, proposal: { summary: "wrong", question: "wrong?", category: "돈", evidence: [{ locator: "line:1", quote: "invented" }] } })); };
  try {
    await f.agent.start(); const doc = f.agent.search().documents[0]; assert(doc);
    const ai = new LocalAi(f.agent, { dailyCalls: 3, session }, request);
    const old = ai.prepare(doc.id);
    f.agent.setEnabled(f.source.id, false); f.agent.setEnabled(f.source.id, true);
    await assert.rejects(ai.send(old.id, true), /STALE_CONSENT/); assert.equal(calls, 0);
    const invalid = ai.prepare(doc.id);
    await assert.rejects(ai.send(invalid.id, true), /AI_FAILED_NO_AUTOMATIC_RETRY/);
    assert.equal(f.agent.db.prepare("SELECT status FROM ai_requests WHERE id=?").get(invalid.id)?.status, "unknown");
  } finally { await f.clean(); }
});

test("changed files cannot expose or approve old excerpts after failed recapture", async () => {
  let fail = false;
  const f = await fixture(async (file, output) => { if (fail) throw new Error("test failure"); return parse(file, output); });
  try {
    await f.agent.start(); const doc = f.agent.search().documents[0]; assert(doc);
    const copies = f.agent.planCopies([doc.id]);
    const ai = new LocalAi(f.agent, { dailyCalls: 1, session });
    const consent = ai.prepare(doc.id);
    await writeFile(path.join(f.root, doc.name), "바뀐 내용이며 아직 읽히지 않았습니다."); fail = true;
    await f.agent.start();
    assert.equal(f.agent.search("자재").total, 0);
    await assert.rejects(f.agent.snapshot(doc.id), /NOT_READ_YET/);
    assert.throws(() => f.agent.answerSite(doc.id, doc.revision, "테스트 현장"), /STALE_DOCUMENT/);
    assert.throws(() => f.agent.planCopies([doc.id]), /NOT_READ_YET/);
    await assert.rejects(f.agent.executeCopies(copies.id), /STALE_PLAN/);
    await assert.rejects(ai.send(consent.id, true), /STALE_CONSENT/);
    assert.equal(f.agent.db.prepare("SELECT count(*) AS n FROM revisions").get()?.n, 1);
  } finally { await f.clean(); }
});
test("USB identity mismatch blocks reads at the same path without marking old evidence missing", async () => {
  const f = await fixture();
  try {
    await f.agent.start(); const doc = f.agent.search().documents[0]; assert(doc);
    f.agent.db.prepare("UPDATE sources SET root_ino='different-volume-simulation' WHERE id=?").run(f.source.id);
    await f.agent.inventory(f.agent.source(f.source.id));
    assert.equal(f.agent.source(f.source.id).problem, "DIFFERENT_DRIVE");
    assert.equal(f.agent.document(doc.id).available, 1);
    await assert.rejects(f.agent.sourcePath(f.agent.document(doc.id)), /DIFFERENT_DRIVE/);
    await assert.rejects(f.agent.grant(f.root, "native_picker"), /DIFFERENT_DRIVE/);
  } finally { await f.clean(); }
});
test("interrupted private copies recover atomically; unsupported formats keep metadata only", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, "audio.mp3"), "not really audio");
    await f.agent.inventory(f.source);
    const doc = f.agent.search("납품").documents[0]; assert(doc);
    const original = await readFile(path.join(f.root, doc.name));
    const copy = f.agent.copyPath(sha256(original), ".txt");
    await mkdir(path.dirname(copy), { recursive: true }); await writeFile(copy, "interrupted");
    await f.agent.capture(doc.id);
    assert.notEqual(sha256(await readFile(copy)), sha256(original));
    assert.equal(sha256(testProtection().decrypt(await readFile(copy))), sha256(original));
    const audio = f.agent.search("audio").documents[0]; assert(audio);
    assert.equal(audio.status, "unsupported"); assert.equal(audio.hash, null);
    const plan = f.agent.planCopies([doc.id]); const destination = path.join(plan.destination, plan.items[0]?.destination ?? "");
    await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, "interrupted output");
    await f.agent.executeCopies(plan.id);
    assert.equal(sha256(await readFile(destination)), sha256(original));
  } finally { await f.clean(); }
});
test("one folder answer covers future documents and metadata-only changes preserve the answer", async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.root, "테스트 현장"));
    await writeFile(path.join(f.root, "테스트 현장", "one.txt"), "준비 1");
    await writeFile(path.join(f.root, "테스트 현장", "two.txt"), "준비 2");
    await f.agent.start();
    assert.equal(f.agent.summary().folderQuestion,null);
    assert.equal(f.agent.search('one.txt').documents[0]?.site,'테스트 현장');
    assert.equal(f.agent.answerFolder(f.source.id, "테스트 현장", "site", "테스트 현장").changed, 2);
    await writeFile(path.join(f.root, "테스트 현장", "three.txt"), "준비 3");
    const doc = f.agent.search("one.txt").documents[0]; assert(doc);
    f.agent.answerSite(doc.id, doc.revision, "개별 예외 현장");
    await utimes(path.join(f.root, "테스트 현장", "one.txt"), new Date(), new Date(Date.now() + 2000));
    await f.agent.start();
    assert.equal(f.agent.document(doc.id).site, "개별 예외 현장");
    assert.equal(f.agent.search("three.txt").documents[0]?.site, "테스트 현장");
    assert.equal(f.agent.summary().folderQuestion, null);
  } finally { await f.clean(); }
});
test("device database v1 migration preserves revisions and requires renewed volume-aware consent", async () => {
  const f = await fixture();
  try {
    await f.agent.start(); const doc = f.agent.search().documents[0]; assert(doc);
    f.agent.db.exec("ALTER TABLE sources DROP COLUMN root_dev; ALTER TABLE sources DROP COLUMN root_ino; ALTER TABLE documents DROP COLUMN relative_dir; PRAGMA user_version=1;");
    const migrated = new LocalAgent(f.data, parse, testProtection());
    assert.equal(migrated.source(f.source.id).enabled, 0);
    assert.equal(migrated.source(f.source.id).problem, "RECONFIRM_REQUIRED");
    assert.equal(migrated.document(doc.id).hash, doc.hash);
    await migrated.grant(f.root, "explicit_user_request");
    assert.equal(migrated.search().total, 1);
    assert.equal(migrated.db.prepare("PRAGMA user_version").get()?.user_version, 2);
    migrated.close();
  } finally { await f.clean(); }
});

test("cache quota pauses new capture without deleting existing evidence", async () => {
  const f = await fixture();
  try {
    await f.agent.start(); const existing = f.agent.search().documents[0]; assert(existing);
    await writeFile(path.join(f.root, "new.txt"), "새 문서");
    f.agent.db.prepare("INSERT INTO local_blobs VALUES(?,?)").run("quota-test-only", 2 * 1024 ** 3);
    await f.agent.start();
    assert.equal(f.agent.source(f.source.id).problem, "CACHE_LIMIT");
    assert.equal(f.agent.document(existing.id).hash, existing.hash);
    assert.equal(sha256((await f.agent.snapshot(existing.id)).bytes), existing.hash);
    assert.equal(f.agent.search("new.txt").documents[0]?.status, "storage_wait");
    const capture = f.agent.capture.bind(f.agent); let attempts = 0;
    f.agent.capture = async id => { attempts++; return capture(id); };
    await f.agent.start(false); await f.agent.start(false);
    assert.equal(attempts, 0); assert.equal(f.agent.source(f.source.id).problem, "CACHE_LIMIT");
    f.agent.db.prepare("DELETE FROM local_blobs WHERE name='quota-test-only'").run();
    await f.agent.start(false);
    assert.equal(f.agent.search("new.txt").documents[0]?.status, "complete");
    assert.equal(f.agent.document(existing.id).hash, existing.hash);
  } finally { await f.clean(); }
});

test("large local inventory resumes across restart, keeps partial evidence and includes historical files", async () => {
  const f = await fixture();
  try {
    for (let base = 0; base < 10_000; base += 100) await Promise.all(Array.from({ length: 100 }, (_, offset) =>
      writeFile(path.join(f.root, `fixture-${String(base + offset).padStart(5, '0')}.txt`), "synthetic")));
    const old = path.join(f.root, "fixture-00000.txt");
    await utimes(old, new Date("2020-01-01"), new Date("2020-01-01"));
    await f.agent.inventory(f.source);
    assert.equal(f.agent.source(f.source.id).problem, "BACKLOG_PENDING");
    assert.equal(f.agent.search().total, 400);
    const first = f.agent.search().documents[0]; assert(first);
    await f.agent.capture(first.id);
    const resumed = new LocalAgent(f.data, parse, testProtection());
    const original = f.agent; f.agent = resumed;
    try {
    for (let batch = 0; batch < 40 && f.agent.source(f.source.id).problem === "BACKLOG_PENDING"; batch++) await f.agent.inventory(f.source);
    assert.equal(f.agent.search().total, 10_001);
    assert.equal(f.agent.source(f.source.id).problem, null);
    assert.equal(f.agent.document(first.id).revision, 1);
    assert.equal(f.agent.search("fixture-00000").documents[0]?.available, 1);
    assert.equal(f.agent.db.prepare("SELECT count(*) n FROM documents WHERE available=0").get()?.n, 0);
    } finally { resumed.close(); f.agent = original; }
  } finally { await f.clean(); }
});

test("local protected copies can exceed 2000 small files without deleting protected originals", async () => {
  const f = await fixture();
  try {
    const insert = f.agent.db.prepare("INSERT INTO local_blobs VALUES(?,1)");
    f.agent.db.exec("BEGIN");
    for (let n = 0; n < 2001; n++) insert.run(`synthetic-index-${n}`);
    f.agent.db.exec("COMMIT");
    await f.agent.start();
    assert.equal(f.agent.search().documents[0]?.status, "complete");
    assert.equal(f.agent.db.prepare("SELECT count(*) n FROM local_blobs WHERE name LIKE 'synthetic-index-%'").get()?.n, 2001);
  } finally { await f.clean(); }
});

test("local AI money budget reserves atomically, unknown calls remain charged and malformed model names are blocked", async()=>{
 const f=await fixture();let calls=0;
 try{
  await f.agent.start();const doc=f.agent.search().documents[0];assert(doc);
  assert.throws(()=>new LocalAi(f.agent,{model:'bad model name',dailyCalls:1,session}),/AI_MODEL_NOT_ALLOWED/);
  const ai=new LocalAi(f.agent,{dailyCalls:3,session},async()=>{calls++;throw new Error('network');});
  const first=ai.prepare(doc.id);await assert.rejects(ai.send(first.id,true),/NO_AUTOMATIC_RETRY/);assert.equal(calls,1);
  const reserved=Number(f.agent.db.prepare('SELECT reserved_micro n FROM ai_usage').get()?.n);assert(reserved>0&&reserved<=80000);
  assert(ai.budget().dailyRemainingMicro<1000000);
  f.agent.db.prepare('UPDATE ai_usage SET reserved_micro=1000000').run();
  await assert.rejects(ai.send(ai.prepare(doc.id).id,true),/AI_BUDGET_LIMIT/);assert.equal(calls,1);
 }finally{await f.clean();}
});
test("local consistent encrypted index backup restores counts and original references separately",async()=>{
 const f=await fixture();try{
  await f.agent.start();const {LocalBackup}=await import('../services/local-agent/src/backup.js');
  const backup=new LocalBackup(f.agent,testProtection()),saved=await backup.create();const restored=await backup.verify(saved.id);
  assert.equal(restored.integrity,'ok');assert.equal(restored.sourceReferencesChecked,1);assert.equal(restored.crossDeviceVerified,false);
  const sealed=await backup.read(saved.id);assert(testProtection().sealed(sealed));assert(!sealed.subarray(0,16).toString().includes('SQLite'));
 }finally{await f.clean();}
});
test('D19 local backup retains more than ten originals and detects a missing archived copy',async()=>{
 const f=await fixture();try{
  for(let i=0;i<12;i++)await writeFile(path.join(f.root,`fixture-${i}.txt`),`합성 자료 ${i}`);
  await f.agent.start();const {LocalBackup}=await import('../services/local-agent/src/backup.js');const backup=new LocalBackup(f.agent,testProtection()),saved=await backup.create();
  assert.equal(saved.sourceCount,13);
  await rm(path.join(f.data,'original-copies'),{recursive:true});
  assert.equal((await backup.verify(saved.id)).sourceReferencesChecked,13);
  const folder=path.join(f.data,'backups',saved.id);const files=await readdir(folder);await rm(path.join(folder,files.at(-1)!));
  await assert.rejects(()=>backup.verify(saved.id));
 }finally{await f.clean();}
});
test('D19 unavailable source is an incomplete backup, with remaining copies and index still restorable',async()=>{
 const f=await fixture();try{
  await writeFile(path.join(f.root,'available.txt'),'다른 합성 자료');await f.agent.start();
  const files=await readdir(path.join(f.data,'original-copies'));const missing=files.find(p=>!p.endsWith('.json'))!;await rm(path.join(f.data,'original-copies',missing));
  const {LocalBackup}=await import('../services/local-agent/src/backup.js');const backup=new LocalBackup(f.agent,testProtection()),saved=await backup.create();
  assert.equal(saved.status,'incomplete');assert.equal(saved.missing.length,1);assert.equal(saved.archivedCount,1);assert(testProtection().sealed(await backup.read(saved.id)));
  const verified=await backup.verify(saved.id);assert.equal(verified.status,'incomplete');assert.equal(verified.missingCount,1);assert.equal(verified.sourceReferencesChecked,1);assert.equal(verified.expectedReferences,2);
 }finally{await f.clean();}
});

test("deferred folder questions return after a day and can be explicitly reviewed",async()=>{
 const f=await fixture();try{
  await mkdir(path.join(f.root,'테스트 현장'));await writeFile(path.join(f.root,'테스트 현장','a.txt'),'자료 a');await writeFile(path.join(f.root,'테스트 현장','b.txt'),'자료 b');await f.agent.start();
  // Exercise an unresolved folder; recognisable single-site paths now classify automatically.
  f.agent.db.prepare("UPDATE documents SET site=NULL WHERE relative_dir='테스트 현장'").run();
  f.agent.answerFolder(f.source.id,'테스트 현장','later');assert.equal(f.agent.summary().folderQuestion,null);
  f.agent.db.prepare("UPDATE folder_answers SET created_at=datetime('now','-2 days')").run();assert(f.agent.summary().folderQuestion);
  f.agent.answerFolder(f.source.id,'테스트 현장','later');f.agent.reviewFolder(f.source.id,'테스트 현장');assert(f.agent.summary().folderQuestion);
 }finally{await f.clean();}
});

test("field outbox quarantines permanent failures while delivering later documents",async()=>{
 const f=await fixture();try{
  await writeFile(path.join(f.root,'second.txt'),'다른 자료');await f.agent.start();
  const {FieldBridge}=await import('../services/local-agent/src/field-bridge.js');let sends=0;
  const bridge=new FieldBridge(f.agent,{
   apiUrl:'http://127.0.0.1:3002',
   authUrl:'http://127.0.0.1:54321',
   publishableKey:'test', email:'test@example.invalid', password:'test',
   tenantId:randomUUID(), deviceId:randomUUID(),
   sources:{[f.source.id]:{id:randomUUID(),generation:1}},telemetryConsentVersion:1
  },async url=>{
   if(String(url).includes('/auth/'))return new Response(JSON.stringify({access_token:'test',expires_in:3600}));
   sends++;return sends===1?new Response(JSON.stringify({error:{code:'NOT_FOUND'}}),{status:404}):new Response(JSON.stringify({document_id:randomUUID()}));
  });
  for(const d of f.agent.search().documents)bridge.queue(d.id);
  await bridge.flush();assert.equal(sends,2);assert.equal(bridge.info().failed,1);assert.equal(bridge.info().pending,0);
  await bridge.flush();assert.equal(sends,2);
 }finally{await f.clean();}
});
