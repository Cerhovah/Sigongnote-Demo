import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { proposeAttribution, type AttributionInput } from "../packages/domain/src/attribution.ts";

function base(): AttributionInput {
  const tenantId = randomUUID();
  return {
    tenantId, revisionId: randomUUID(), documentScope: "project",
    observedAt: "2026-06-22T09:00:00Z", clues: [],
    projects: [], bundles: [], parties: [], itemTypes: [],
  };
}

test("C24 T04 filename/header/address disagreement stays unconfirmed", () => {
  const input = base();
  const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
  input.projects = [
    { tenantId: input.tenantId, id: a, displayName: "가람 현장", aliases: [] },
    { tenantId: input.tenantId, id: b, displayName: "새빛 현장", aliases: [] },
    { tenantId: input.tenantId, id: c, displayName: "한길 현장", aliases: [], addressHint: "가명로 12" },
  ];
  input.clues = [
    { source: "filename", text: "가람 현장 납품서", locator: "filename:0" },
    { source: "header", text: "새빛 현장", locator: "section:0/table:0" },
    { source: "address", text: "가명로 12", locator: "section:0/table:1" },
  ];
  const result = proposeAttribution(input);
  assert.equal(result.status, "conflict");
  assert.equal(result.projectConfirmed, null);
  assert.deepEqual(result.candidates.filter(item => item.targetKind === "project").map(item => item.targetId).sort(), [a, b, c].sort());
  assert.deepEqual(result.conflicts[0]?.targetIds, [a, b, c].sort());
});

test("C24 common material and expired alias never force a project", () => {
  const input = base();
  input.projects = [{ tenantId: input.tenantId, id: randomUUID(), displayName: "가람 현장",
    aliases: [{ text: "옛 별칭", validUntil: "2026-01-01T00:00:00Z" }] }];
  input.clues = [{ source: "body", text: "옛 별칭", locator: "section:0" }];
  assert.equal(proposeAttribution(input).status, "unassigned");
  input.documentScope = "product";
  input.clues = [{ source: "body", text: "가람 현장 제품 예시", locator: "section:0" }];
  assert.deepEqual(proposeAttribution(input).candidates, []);
  input.itemTypes = [{ tenantId: input.tenantId, id: randomUUID(),
    typeCode: "WD-5", specification: "1010*2140*40" }];
  input.clues.push({ source: "item_line", text: "WD-5 1010*2140*40", locator: "section:0/table:0" });
  const product = proposeAttribution(input);
  assert.equal(product.candidates.filter(item => item.targetKind === "project").length, 0);
  assert.equal(product.candidates.filter(item => item.targetKind === "item_type").length, 1);
});

test("C24 same-name people and item types remain distinct candidates", () => {
  const input = base();
  const projectId = randomUUID();
  input.projects = [{ tenantId: input.tenantId, id: projectId, displayName: "가람 현장", aliases: [] },
    { tenantId: randomUUID(), id: randomUUID(), displayName: "가람 현장", aliases: [] }];
  input.bundles = [{ tenantId: input.tenantId, id: randomUUID(), projectId, label: "문틀 교체" }];
  input.parties = ["기사", "인수자"].map(role => ({ tenantId: input.tenantId, id: randomUUID(),
    displayName: "김 가명", role }));
  input.itemTypes = ["1010*2140*40", "1011*2146*40"].map(specification => ({
    tenantId: input.tenantId, id: randomUUID(), typeCode: "WD-5", specification,
  }));
  input.clues = [
    { source: "body", text: "가람 현장 문틀 교체", locator: "text:0/char:0" },
    { source: "sender", text: "김 가명", locator: "text:0/char:1" },
    { source: "item_line", text: "WD-5 1010*2140*40", locator: "sheet:0/cell:A1" },
  ];
  const result = proposeAttribution(input);
  assert.equal(result.projectConfirmed, null);
  assert.equal(result.candidates.filter(item => item.targetKind === "project").length, 1);
  assert.equal(result.candidates.filter(item => item.targetKind === "bundle").length, 1);
  assert.equal(result.candidates.filter(item => item.targetKind === "party").length, 2);
  assert.ok(result.conflicts.some(conflict => conflict.code === "ambiguous_party_name"));
  assert.equal(result.candidates.filter(item => item.targetKind === "item_type").length, 1);
  assert.ok(result.candidates.every(item => item.targetKind !== ("item_instance" as string)));
});

test("C24 filename versus body conflicts without a header and unknown alias time stays unassigned", () => {
  const input = base();
  input.projects = [
    { tenantId: input.tenantId, id: randomUUID(), displayName: "가람 현장", aliases: [] },
    { tenantId: input.tenantId, id: randomUUID(), displayName: "새빛 현장", aliases: [] },
  ];
  input.clues = [
    { source: "filename", text: "가람 현장", locator: "filename:0" },
    { source: "body", text: "새빛 현장", locator: "text:0/char:0" },
  ];
  assert.equal(proposeAttribution(input).status, "conflict");
  input.observedAt = null;
  input.projects = [{ tenantId: input.tenantId, id: randomUUID(), displayName: "다른 현장",
    aliases: [{ text: "옛 별칭", validUntil: "2026-01-01T00:00:00Z" }] }];
  input.clues = [{ source: "body", text: "옛 별칭", locator: "text:0/char:0" }];
  const unknown = proposeAttribution(input);
  assert.equal(unknown.status, "unassigned");
  assert.deepEqual(unknown.issues, ["alias_time_unverified"]);
});
