import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LocalAgent, inside, sha256 } from "../services/local-agent/src/agent.js";
import { CopyProtection } from "../services/local-agent/src/protection.js";
import { siteCategories } from "../services/local-agent/src/site-folders.js";

async function fixture() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "sigongnote-site-index-")), root = path.join(temp, "site"), data = path.join(temp, "private");
  await mkdir(root); await mkdir(data);
  const agent = new LocalAgent(data, async file => ({ status: "complete", sourceHash: sha256(await readFile(file)), parserVersion: "fixture", issues: [], spans: [] }), new CopyProtection(Buffer.alloc(32, 9)));
  const source = await agent.grant(root, "explicit_user_request");
  return { root, agent, source, clean: async () => { await agent.stop(); agent.close(); assert(inside(os.tmpdir(), temp)); await rm(temp, { recursive: true, force: true }); } };
}
test("site folder indexes preserve originals, escape labels and never re-ingest generated files", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.root, "견적 & 확인.txt"); await writeFile(file, "synthetic estimate");
    await f.agent.start(); const before = sha256(await readFile(file));
    await assert.rejects(f.agent.siteFolders.connect(f.source.id, "테스트 <현장>", true), /INVALID_/);
    await f.agent.siteFolders.connect(f.source.id, "테스트 현장", true);
    const managed = path.join(f.root, "시공노트");
    assert.deepEqual((await readdir(managed)).filter(name => name !== "sigongnote-generated.json").sort(), [...siteCategories].sort());
    const index = await readFile(path.join(managed, "약속", "자료목록.html"), "utf8");
    assert(index.includes("테스트 현장")); assert(index.includes("견적 &amp; 확인.txt"));
    assert(index.includes('href="../../')); assert(!index.includes("<script")); assert(!index.includes("file:"));
    assert.equal(sha256(await readFile(file)), before);
    await writeFile(path.join(f.root, "작업.txt"), "synthetic work"); await f.agent.start();
    assert.equal(f.agent.search().total, 2);
    assert.equal(f.agent.search("작업").documents[0]?.site, "테스트 현장");
    assert(f.agent.siteFolders.isManagedPath(f.source.id, path.join("시공노트", "약속", "자료목록.html")));
    assert(!f.agent.siteFolders.isManagedPath(f.source.id, path.join("시공노트처럼", "원본.txt")));
    assert((await readFile(path.join(managed, "납품·작업", "자료목록.html"), "utf8")).includes("작업.txt"));
  } finally { await f.clean(); }
});
test("existing user directory and edits to generated indexes are preserved", async () => {
  const f = await fixture();
  try {
    const managed = path.join(f.root, "시공노트"); await mkdir(managed); await writeFile(path.join(managed, "원본.txt"), "keep");
    await assert.rejects(f.agent.siteFolders.connect(f.source.id, null, true), /MANAGED_FOLDER_EXISTS/);
    assert.equal(await readFile(path.join(managed, "원본.txt"), "utf8"), "keep");
    assert.equal(f.agent.siteFolders.get(f.source.id), undefined);
  } finally { await f.clean(); }
  const g = await fixture();
  try {
    await g.agent.siteFolders.connect(g.source.id, null, true);
    const index = path.join(g.root, "시공노트", "약속", "자료목록.html"); await writeFile(index, "user edit");
    await assert.rejects(g.agent.siteFolders.refresh(g.source.id), /MANAGED_FILE_CHANGED/);
    assert.equal(await readFile(index, "utf8"), "user edit");
    assert.equal(g.agent.siteFolders.get(g.source.id)?.status, "needs_attention");
    g.agent.setEnabled(g.source.id, false);
    await assert.rejects(g.agent.siteFolders.connect(g.source.id, null, true), /SCOPE_REVOKED/);
  } finally { await g.clean(); }
});


test("concurrent connects serialize and creation receipt resumes an interrupted first connection", async () => {
  const f = await fixture();
  try {
    const root = path.join(f.root, "시공노트"); await mkdir(root);
    const id = "recovery-fixture";
    await writeFile(path.join(root, "sigongnote-generated.json"), JSON.stringify({version:1,id,sourceId:f.source.id,files:{}}));
    f.agent.audit("site_folder_creation", f.source.id, { id });
    await Promise.all([f.agent.siteFolders.connect(f.source.id, null, true),f.agent.siteFolders.connect(f.source.id, null, true),f.agent.siteFolders.refresh(f.source.id)]);
    assert.equal(f.agent.siteFolders.get(f.source.id)?.id, id);
    assert.equal(f.agent.siteFolders.get(f.source.id)?.status, "ready");
    const marker = path.join(root, "sigongnote-generated.json");
    const manifest = JSON.parse(await readFile(marker, "utf8"));
    const name = "약속/자료목록.html", middle = "interrupted app-generated version";
    await writeFile(path.join(root,name), middle);
    manifest.pending = {[name]:sha256("later interrupted version")};
    manifest.allowed = {[name]:[sha256(middle)]};
    await writeFile(marker,JSON.stringify(manifest));
    await Promise.all([f.agent.siteFolders.refresh(f.source.id), f.agent.siteFolders.refresh(f.source.id)]);
    assert.equal(f.agent.siteFolders.get(f.source.id)?.status,"ready");
    assert.equal(JSON.parse(await readFile(marker,"utf8")).pending,undefined);
  } finally { await f.clean(); }
});

test("manual site survives new contents and overrides an automatic folder default", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.root,"작업.txt"); await writeFile(file,"first synthetic record");
    await f.agent.start(); await f.agent.siteFolders.connect(f.source.id,"처음 현장",true);
    const doc = f.agent.search().documents[0]; assert(doc);
    assert.equal(f.agent.db.prepare("SELECT kind FROM document_site_origins WHERE document_id=?").get(doc.id)?.kind,"folder_default");
    f.agent.answerSite(doc.id,doc.revision,"직접 고른 현장");
    await writeFile(file,"changed synthetic record with more text"); await f.agent.start();
    assert.equal(f.agent.document(doc.id).site,"직접 고른 현장");
    assert.equal(f.agent.db.prepare("SELECT kind FROM document_site_origins WHERE document_id=?").get(doc.id)?.kind,"manual");
  } finally { await f.clean(); }
});
