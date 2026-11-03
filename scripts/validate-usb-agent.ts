/** Run only with an explicitly authorized real root and a private source manifest.
 * Reports aggregate evidence to stdout; paths/content/hashes stay in the private report.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalAgent, inside, sha256 } from "../services/local-agent/src/agent.js";
import { DocumentParser } from "../services/local-agent/src/parser.js";
import { loadCopyProtection } from "../services/local-agent/src/protection.js";

const [root, manifestPath, dataDir, reportPath] = process.argv.slice(2);
if (!root || !manifestPath || !dataDir || !reportPath) throw new Error("ROOT_MANIFEST_PRIVATE_DATA_AND_REPORT_REQUIRED");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { id: string; path: string }[];
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const parser = new DocumentParser(fileURLToPath(new URL("../", import.meta.url)));
const agent = new LocalAgent(path.resolve(dataDir), parser.parse, await loadCopyProtection(fileURLToPath(new URL("../", import.meta.url)), path.resolve(dataDir)));
await agent.protectExistingCopies();
const evidence: { id: string; ext: string; status: string; spans: number; unchanged: boolean; revision: number }[] = [];
try {
  const source = await agent.grant(root, "explicit_user_request");
  await agent.inventory(source);
  assert.equal(agent.source(source.id).problem, null, "USB inventory incomplete");
  const inputs = [...manifest];
  for (const [index, row] of agent.db.prepare("SELECT relative_path FROM documents WHERE ext='.hwpx' LIMIT 2").all().entries()) {
    inputs.push({ id: `HWPX-${index + 1}`, path: path.join(source.root, String(row.relative_path)) });
  }
  for (const input of inputs) {
    assert(inside(source.root, path.resolve(input.path)), "outside authorized USB");
    const row = agent.db.prepare("SELECT id FROM documents WHERE source_id=? AND relative_path=?").get(source.id, path.relative(source.root, input.path));
    assert(row, `manifest source missing: ${input.id}`);
    const before = sha256(await readFile(input.path));
    const existing = agent.document(String(row.id));
    const previous = JSON.parse(existing.parsed);
    if (existing.hash !== before || !previous.spans?.length) await agent.capture(String(row.id));
    const document = agent.document(String(row.id));
    const parsed = JSON.parse(document.parsed);
    assert.equal(document.hash, before, `snapshot mismatch: ${input.id}`);
    assert.equal(sha256(await readFile(input.path)), before, `original changed: ${input.id}`);
    assert(parsed.spans.length > 0, `no readable evidence: ${input.id}`);
    // Prove this is searchable product data, not just a standalone parser invocation.
    assert(agent.search(parsed.spans[0].text.slice(0, 30)).total > 0, `search failed: ${input.id}`);
    const revision = document.revision;
    if (input.id === inputs[0]?.id) {
      await agent.capture(document.id); assert.equal(agent.document(document.id).revision, revision);
      const plan = agent.planCopies([document.id]);
      await agent.executeCopies(plan.id);
      assert.equal(sha256(await readFile(path.join(plan.destination, plan.items[0]?.destination ?? ""))), before);
      assert.equal((await agent.executeCopies(plan.id)).replay, true);
      assert.equal(sha256(await readFile(input.path)), before);
    }
    evidence.push({ id: input.id, ext: document.ext, status: document.status, spans: parsed.spans.length, unchanged: true, revision });
  }
  const summary = agent.summary();
  const report = { executedAt: new Date().toISOString(), inventory: summary.total, excluded: source.skipped,
    byFormat: agent.db.prepare("SELECT ext,count(*) AS count,sum(size) AS bytes FROM documents GROUP BY ext").all(),
    evidence, externalAi: "NOT_RUN_NO_KEY_OR_TRANSMISSION_CONSENT", copyApprovalAndReplay: "PASS", originalHashes: "PASS" };
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ inventory: report.inventory, byFormat: report.byFormat, cases: evidence, copyApprovalAndReplay: "PASS", originalHashes: "PASS" }));
} finally { parser.close(); agent.close(); }
