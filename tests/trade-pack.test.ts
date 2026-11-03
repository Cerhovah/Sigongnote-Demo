import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { evaluatePackExceptions, evaluatePackRule, parseTradePack, previewPackMigration, projectPackWork } from "../packages/domain/src/trade-pack.ts";

function pack(name: string) {
  return parseTradePack(JSON.parse(readFileSync(new URL(`../trade-packs/${name}/1.0.0.json`, import.meta.url), "utf8")));
}

test("C26 generic, joinery and wet-trade share the pack contract and keep unit dimensions", () => {
  const generic = pack("generic");
  const joinery = pack("joinery");
  const wet = pack("wet-trade");
  assert.deepEqual([generic.packId, joinery.packId, wet.packId], ["generic", "joinery", "wet-trade"]);
  assert.equal(wet.units.find(item => item.code === "m2")?.dimension, "area");
  assert.equal(wet.units.find(item => item.code === "day")?.dimension, "labor");
  assert.equal(joinery.units.find(item => item.code === "lump")?.dimension, "lump");
});

test("C26 tile area and labor have independent prerequisites; unknown fact blocks", () => {
  const wet = pack("wet-trade");
  const work = { bundleId: "tile-1", packId: wet.packId, packVersion: wet.version, packHash: wet.contentHash,
    facts: {}, completedNodeIds: ["substrate", "layout"] };
  assert.deepEqual(projectPackWork(work, [wet]).blockedNodeIds, ["install", "cure", "inspection"]);
  assert.deepEqual(projectPackWork({ ...work, facts: { substrate_ready: true, area_m2: "25", labor_day: "2" } }, [wet]).readyNodeIds, ["install"]);
  assert.throws(() => projectPackWork({ ...work, packVersion: "2.0.0" }, [wet]), /PINNED_PACK_VERSION_MISSING/);
  const altered = parseTradePack({ ...JSON.parse(readFileSync(new URL("../trade-packs/wet-trade/1.0.0.json", import.meta.url), "utf8")), labels: { ko: "변경" } });
  assert.throws(() => projectPackWork(work, [altered]), /PINNED_PACK_HASH_MISMATCH/);
});

test("C26 pack migration previews a changed graph without mutating a pinned work", () => {
  const old = pack("wet-trade");
  const { contentHash: _hash, ...oldJson } = old;
  const next = parseTradePack({ ...oldJson, version: "2.0.0", workflowNodes: old.workflowNodes.map(node =>
    node.id === "inspection" ? { ...node, after: ["cure", "approval"] } : node).concat([{ id: "approval", label: "승인", after: ["cure"] }]) });
  const work = { bundleId: "tile-1", packId: old.packId, packVersion: old.version, packHash: old.contentHash,
    facts: { substrate_ready: true }, completedNodeIds: ["substrate", "layout", "install", "cure"] };
  const before = projectPackWork(work, [old, next]);
  const preview = previewPackMigration(work, old, next);
  assert.equal(preview.decisionRequired, true);
  assert.deepEqual(preview.addedNodes, ["approval"]);
  assert.equal(projectPackWork(work, [old, next]).packVersion, "1.0.0");
  assert.deepEqual(projectPackWork(work, [old, next]), before);
});

test("C26 cyclic or executable pack rules are rejected", () => {
  const generic = pack("generic");
  const { contentHash: _hash, ...genericJson } = generic;
  assert.throws(() => parseTradePack({ ...genericJson, workflowNodes: [
    { id: "a", label: "A", after: ["b"] }, { id: "b", label: "B", after: ["a"] },
  ], requiredEvidence: [] }), /CYCLIC_PACK_WORKFLOW/);
  assert.throws(() => parseTradePack({ ...genericJson, prerequisiteRules: [
    { nodeId: "performed", rule: { op: "eval", script: "while(true){}" } },
  ] }), /INVALID_PACK_RULE/);
});

test("C26 unknown exception fact remains needs_check and mismatched units cannot compare", () => {
  const generic = pack("generic");
  const { contentHash: _hash, ...genericJson } = generic;
  const packWithException = parseTradePack({ ...genericJson, exceptionRules: [
    { code: "missing_count", rule: { op: "decimalCompare", field: "count", cmp: "gt", value: "30", unitCode: "ea" } },
  ] });
  assert.deepEqual(evaluatePackExceptions(packWithException, {}), [{ code: "missing_count", status: "needs_check" }]);
  const rule = packWithException.exceptionRules[0]?.rule;
  assert.ok(rule);
  assert.equal(evaluatePackRule(rule,
    { count: { value: "40", unitCode: "pack" } }), "unknown");
  assert.deepEqual(evaluatePackExceptions(packWithException, { count: { value: "40", unitCode: "ea" } }),
    [{ code: "missing_count", status: "triggered" }]);
  assert.throws(() => parseTradePack({ ...genericJson, exceptionRules: [
    { code: "invalid", rule: { op: "decimalCompare", field: "count", cmp: "gt", value: "30", unitCode: "m2" } },
  ] }), /INVALID_PACK_UNIT/);
});
