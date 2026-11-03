import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveEntityLinks, type EntityAlias, type EntityLinkInput, type EntityReference }
  from "../packages/domain/src/entity-links.ts";

function base(): EntityLinkInput {
  return {
    tenantId: "company-a", revisionId: "revision-current", documentScope: "project",
    effectiveAt: "2026-10-03T00:00:00Z", context: {}, aliases: [], references: [],
    evidence: [{ id: "chunk-1", tenantId: "company-a", revisionId: "revision-current",
      locator: "sheet:0/cell:A1", text: "가람 현장\n김 가명\n창호 공사\n문틀 교체\nWD-5\nWD-5 1010×2140\n기본형", active: true }],
    mentions: [{ id: "mention-1", targetKind: "project", text: "가람 현장", evidenceIds: ["chunk-1"] }],
  };
}
function reference(id: string, targetKind: EntityReference["targetKind"], displayName: string,
  scope: Partial<EntityReference> = {}): EntityReference {
  return { tenantId: "company-a", id, targetKind, displayName, ...scope };
}
function alias(id: string, targetId: string, overrides: Partial<EntityAlias> = {}): EntityAlias {
  return { tenantId: "company-a", id, targetKind: "project", targetId, text: "가람 현장",
    scope: "company", scopeId: "company-a", status: "active", evidenceIds: ["chunk-1"], ...overrides };
}
function first(input: EntityLinkInput) { return resolveEntityLinks(input).links[0]!; }

test("N05 unique exact evidence-backed project links; existing ID disambiguates duplicate names", () => {
  const input = base();
  input.references = [reference("project-1", "project", "가람 현장")];
  assert.equal(first(input).status, "linked");
  assert.equal(first(input).targetId, "project-1");
  input.references.push(reference("project-2", "project", "가람 현장"));
  const ambiguous = first(input);
  assert.equal(ambiguous.status, "candidate_only");
  assert.equal(ambiguous.targetId, null);
  assert.deepEqual(ambiguous.candidates.map(candidate => candidate.targetId), ["project-1", "project-2"]);
  input.mentions[0]!.existingId = "project-2";
  assert.equal(first(input).targetId, "project-2");
  assert.deepEqual(first(input).candidates[0]!.matchedBy, ["existing_id"]);
});

test("N05 same-name people stay candidates until project, contract and role are unique", () => {
  const input = base();
  input.references = [reference("project-1", "project", "가람 현장"),
    reference("contract-1", "contract", "본 공사", { projectId: "project-1" }),
    reference("contract-2", "contract", "추가 공사", { projectId: "project-1" }),
    reference("party-1", "party", "김 가명", { projectId: "project-1", contractId: "contract-1", role: "supplier" }),
    reference("party-2", "party", "김 가명", { projectId: "project-1", contractId: "contract-2", role: "recipient" })];
  input.mentions = [{ id: "person", targetKind: "party", text: "김 가명", evidenceIds: ["chunk-1"] }];
  input.context = { projectId: "project-1" };
  assert.equal(first(input).status, "candidate_only");
  assert.equal(first(input).candidates.length, 2);
  input.context.contractId = "contract-2";
  assert.equal(first(input).status, "candidate_only");
  assert.ok(first(input).reasons.includes("missing_role"));
  input.context.role = "recipient";
  assert.equal(first(input).targetId, "party-2");
  assert.equal(first(input).status, "linked");
});

test("N05 two contracts in one site remain distinct; selecting a work bundle needs its contract", () => {
  const input = base();
  input.context = { projectId: "project-1" };
  input.references = [reference("project-1", "project", "가람 현장"),
    reference("contract-1", "contract", "창호 공사", { projectId: "project-1" }),
    reference("contract-2", "contract", "창호 공사", { projectId: "project-1" }),
    reference("bundle-1", "bundle", "문틀 교체", { projectId: "project-1", contractId: "contract-1" }),
    reference("bundle-2", "bundle", "문틀 교체", { projectId: "project-1", contractId: "contract-2" })];
  input.mentions = [{ id: "contract", targetKind: "contract", text: "창호 공사", evidenceIds: ["chunk-1"] },
    { id: "work", targetKind: "bundle", text: "문틀 교체", evidenceIds: ["chunk-1"] }];
  assert.deepEqual(resolveEntityLinks(input).links.map(link => link.status), ["candidate_only", "candidate_only"]);
  input.context.contractId = "contract-2";
  assert.deepEqual(resolveEntityLinks(input).links.map(link => link.targetId), ["contract-2", "bundle-2"]);
});

test("N05 alias periods are half-open; overlapping targets or unknown time do not auto-link", () => {
  const input = base();
  input.references = [reference("project-1", "project", "이전 정식명"), reference("project-2", "project", "새 정식명")];
  input.aliases = [alias("alias-old", "project-1", { validUntil: "2026-10-03T00:00:00Z" }),
    alias("alias-new", "project-2", { validFrom: "2026-10-03T00:00:00Z" })];
  assert.equal(first(input).targetId, "project-2");
  input.effectiveAt = "2026-10-02T23:59:59Z";
  assert.equal(first(input).targetId, "project-1");
  input.aliases[0]!.validUntil = "2026-10-04T00:00:00Z";
  input.effectiveAt = "2026-10-03T00:00:00Z";
  assert.equal(first(input).status, "candidate_only");
  assert.equal(first(input).candidates.length, 2);
  input.effectiveAt = null;
  assert.equal(first(input).status, "candidate_only");
  assert.ok(first(input).reasons.includes("alias_time_unverified"));
});

test("N05 invalid dates and recorded alias conflicts stay candidates; retired aliases are ignored", () => {
  const input = base();
  input.references = [reference("project-1", "project", "정식명")];
  input.aliases = [alias("alias-1", "project-1", { validFrom: "2026-02-30T00:00:00Z" })];
  assert.equal(first(input).status, "candidate_only");
  assert.ok(first(input).reasons.includes("alias_period_invalid"));
  input.aliases = [alias("alias-1", "project-1", { status: "conflict" })];
  assert.equal(first(input).status, "candidate_only");
  input.aliases[0]!.status = "retired";
  assert.equal(first(input).status, "unassigned");
});

test("N05 company-common and product material cannot force site or physical instance", () => {
  const input = base();
  input.references = [reference("project-1", "project", "가람 현장"),
    reference("type-1", "item_type", "WD-5 1010×2140"),
    reference("instance-1", "item_instance", "WD-5 1010×2140", { itemTypeId: "type-1" })];
  input.mentions.push({ id: "type", targetKind: "item_type", text: "WD-5 1010×2140", evidenceIds: ["chunk-1"] },
    { id: "instance", targetKind: "item_instance", text: "WD-5 1010×2140", evidenceIds: ["chunk-1"] });
  for (const scope of ["common", "product"] as const) {
    input.documentScope = scope;
    assert.deepEqual(resolveEntityLinks(input).links.map(link => [link.status, link.targetId]),
      [["unassigned", null], ["linked", "type-1"], ["unassigned", null]]);
  }
});

test("N05 identical names in another company never enter candidates or evidence", () => {
  const input = base();
  input.references = [reference("project-1", "project", "가람 현장"),
    reference("foreign-project", "project", "가람 현장", { tenantId: "company-b" })];
  input.aliases = [alias("foreign-alias", "project-1", { tenantId: "company-b", status: "conflict" })];
  assert.equal(first(input).status, "linked");
  assert.deepEqual(first(input).candidates.map(candidate => candidate.targetId), ["project-1"]);
  input.mentions[0]!.existingId = "foreign-project";
  assert.equal(first(input).status, "blocked_scope");
  assert.deepEqual(first(input).candidates, []);
  assert.deepEqual(first(input).reasons, ["existing_id_unavailable"]);
});

test("N05 missing or inconsistent context ancestors block even an explicit entity ID", () => {
  const input = base();
  input.references = [reference("project-1", "project", "가람 현장"),
    reference("project-2", "project", "다른 현장"),
    reference("contract-2", "contract", "추가 공사", { projectId: "project-2" })];
  input.mentions[0]!.existingId = "project-1";
  for (const context of [{ projectId: "nonexistent" }, { projectId: "project-1", contractId: "contract-2" },
    { partyId: "foreign-party" }]) {
    input.context = context;
    assert.equal(first(input).status, "blocked_scope");
    assert.deepEqual(first(input).reasons, ["invalid_context"]);
    assert.deepEqual(first(input).candidates, []);
  }
});

test("N05 revoked, superseded, foreign, missing and ambiguous source evidence cannot link", () => {
  for (const change of ["withdrawn", "old_revision", "foreign", "missing", "no_locator", "duplicate"] as const) {
    const input = base();
    input.references = [reference("project-1", "project", "가람 현장")];
    if (change === "withdrawn") input.evidence[0]!.active = false;
    if (change === "old_revision") input.evidence[0]!.revisionId = "revision-old";
    if (change === "foreign") input.evidence[0]!.tenantId = "company-b";
    if (change === "missing") input.evidence = [];
    if (change === "no_locator") input.evidence[0]!.locator = " ";
    if (change === "duplicate") input.evidence.push({ ...input.evidence[0]!, active: false });
    assert.equal(first(input).status, "blocked_scope", change);
    assert.deepEqual(first(input).candidates, [], change);
    assert.deepEqual(first(input).evidenceIds, [], change);
  }
});

test("N05 alias support may use an earlier active revision but never withdrawn evidence", () => {
  const input = base();
  input.references = [reference("project-1", "project", "정식명")];
  input.evidence.push({ id: "chunk-old", tenantId: input.tenantId, revisionId: "revision-old",
    locator: "page:1", text: "가람 현장", active: true });
  input.aliases = [alias("alias-1", "project-1", { evidenceIds: ["chunk-old"] })];
  assert.equal(first(input).targetId, "project-1");
  assert.deepEqual(first(input).candidates[0]!.evidenceIds, ["chunk-1", "chunk-old"]);
  input.evidence[1]!.active = false;
  assert.equal(first(input).status, "unassigned");
});

test("N05 scoped alias cannot escape its company, party, contract or role", () => {
  const input = base();
  input.mentions = [{ id: "item", targetKind: "item_type", text: "기본형", evidenceIds: ["chunk-1"] }];
  input.references = [reference("party-1", "party", "공급사"), reference("party-2", "party", "다른 공급사"),
    reference("type-1", "item_type", "WD-5")];
  input.aliases = [alias("alias-1", "type-1", { targetKind: "item_type", text: "기본형",
    scope: "party", scopeId: "party-1", role: "supplier" })];
  assert.equal(first(input).status, "candidate_only");
  input.context = { partyId: "party-1", role: "supplier" };
  assert.equal(first(input).targetId, "type-1");
  input.context.role = "recipient";
  assert.equal(first(input).status, "unassigned");
  input.context = { partyId: "party-2", role: "supplier" };
  assert.equal(first(input).status, "unassigned");
  input.aliases = [alias("alias-wrong-company", "type-1", { targetKind: "item_type", text: "기본형", scopeId: "company-b" })];
  input.context = {};
  assert.equal(first(input).status, "unassigned");
});

test("N05 type and instance identifiers are separate and embedded names do not establish identity", () => {
  const input = base();
  input.references = [reference("project-1", "project", "가람 현장"), reference("type-1", "item_type", "WD-5")];
  input.mentions[0]!.text = "가람 현장일 수도 있으나 아직 미정";
  input.evidence[0]!.text = "가람 현장일 수도 있으나 아직 미정\nWD-5";
  assert.equal(first(input).status, "unassigned");
  input.mentions = [{ id: "instance", targetKind: "item_instance", text: "WD-5", evidenceIds: ["chunk-1"] }];
  assert.equal(first(input).status, "unassigned");
  input.mentions[0]!.existingId = "type-1";
  assert.equal(first(input).status, "blocked_scope");
});

test("N05 fabricated mentions and partial name prefixes cannot borrow a valid source location", () => {
  const input = base();
  input.references = [reference("project-1", "project", "가람 현장")];
  input.evidence[0]!.text = "다른 현장";
  assert.equal(first(input).status, "blocked_scope");
  assert.deepEqual(first(input).reasons, ["mention_not_in_evidence"]);
  input.evidence[0]!.text = "가람 현장별 참고자료";
  assert.equal(first(input).status, "blocked_scope");
  input.evidence[0]!.text = "[가람 현장]";
  assert.equal(first(input).status, "linked");
  input.mentions = [{ id: "item", targetKind: "item_type", text: "WD-5", evidenceIds: ["chunk-1"] }];
  input.references = [reference("type-1", "item_type", "WD-5")];
  input.evidence[0]!.text = "WD-50";
  assert.equal(first(input).status, "blocked_scope");
});

test("N05 authoritative existing IDs can resolve without a quoted name; forged aliases cannot", () => {
  const input = base();
  input.references = [reference("project-1", "project", "정식명")];
  input.mentions = [{ id: "bound-project", targetKind: "project", existingId: "project-1", evidenceIds: ["chunk-1"] }];
  input.evidence[0]!.text = "납품 자료";
  assert.equal(first(input).targetId, "project-1");
  input.mentions = [{ id: "named-project", targetKind: "project", text: "가람 현장", evidenceIds: ["chunk-1"] }];
  input.evidence[0]!.text = "가람 현장";
  input.evidence.push({ id: "unrelated", tenantId: input.tenantId, revisionId: "revision-old",
    locator: "page:1", text: "관련 없는 내용", active: true });
  input.aliases = [alias("forged", "project-1", { evidenceIds: ["unrelated"] })];
  assert.equal(first(input).status, "unassigned");
});
