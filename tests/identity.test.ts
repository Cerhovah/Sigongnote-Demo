import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { analyzeIdentity, type FormObservation } from "../packages/domain/src/identity.ts";

const TENANT = randomUUID();
const AT = "2026-10-29T09:00:00Z";

function form(formId: string, overrides: Partial<FormObservation> = {}): FormObservation {
  return {
    tenantId: TENANT, revisionId: randomUUID(), formId,
    recordedAt: "2026-10-29T08:00:00Z", blobSha256: "a".repeat(64),
    representationFingerprint: "b".repeat(64),
    quantity: { value: "25", unitCode: "ea", semantic: "ordered" },
    ...overrides,
  };
}

test("C25 T02 repeated 25EA representation is one review candidate, not 75 actual", () => {
  const result = analyzeIdentity(TENANT, AT, [
    form("table-1"), form("table-2", { blobSha256: "c".repeat(64) }),
    form("pdf-version", { blobSha256: "d".repeat(64) }),
  ]);
  assert.equal(result.logicalForms.length, 1);
  assert.deepEqual(result.logicalForms[0]?.candidateQuantity, { value: "25", unitCode: "ea", semantic: "ordered" });
  assert.equal(result.logicalForms[0]?.actualReceived, null);
  assert.equal(result.logicalForms[0]?.confirmedTransactionId, null);
  assert.equal(result.logicalForms[0]?.formIds.length, 3);
  assert.equal(result.relations.filter(item => item.kind === "same_representation_candidate").length, 3);
});

test("C25 T12 same amount with distinct transport references stays distinct", () => {
  const transaction = { recordedAt: "2026-10-29T08:00:00Z", partyRef: "supplier", dateRaw: "2026-10-29", specification: "WD-5", amountMinor: "300000" };
  const result = analyzeIdentity(TENANT, AT, [
    form("first", { representationFingerprint: "1".repeat(64), transaction: { ...transaction, transportRef: "truck-A" } }),
    form("second", { representationFingerprint: "2".repeat(64), transaction: { ...transaction, transportRef: "truck-B" } }),
  ]);
  assert.equal(result.relations[0]?.kind, "distinct_transaction");
  assert.equal(result.logicalForms.length, 2);
});

test("C25 different transport IDs override identical representation fingerprints", () => {
  const first = form("truck-a", { transaction: { recordedAt: "2026-10-29T08:00:00Z", transportRef: "A", amountMinor: "300000" } });
  const second = form("truck-b", { transaction: { recordedAt: "2026-10-29T08:00:00Z", transportRef: "B", amountMinor: "300000" } });
  const result = analyzeIdentity(TENANT, AT, [first, second]);
  assert.equal(result.relations[0]?.kind, "distinct_transaction");
  assert.equal(result.logicalForms.length, 2);
});

test("C25 later transaction reference is invisible at historical as-of; offset is instant", () => {
  const first = form("first", { representationFingerprint: "1".repeat(64),
    transaction: { recordedAt: "2026-10-29T09:05:00Z", transportRef: "A" } });
  const second = form("second", { representationFingerprint: "2".repeat(64),
    transaction: { recordedAt: "2026-10-29T08:00:00Z", transportRef: "B" } });
  const earlier = analyzeIdentity(TENANT, "2026-10-29T17:59:00+09:00", [first, second]);
  assert.equal(earlier.relations[0]?.kind, "unresolved");
  assert.equal(analyzeIdentity(TENANT, "2026-10-29T18:06:00+09:00", [first, second])
    .relations[0]?.kind, "distinct_transaction");
  assert.throws(() => analyzeIdentity(TENANT, "2026-10-29T09:00:00", [first]));
});

test("C25 T10 as-of excludes later evidence and revisions preserve predecessor", () => {
  const first = form("old", { representationFingerprint: "1".repeat(64) });
  const later = form("later", { recordedAt: "2026-10-29T09:05:00Z",
    representationFingerprint: "2".repeat(64), predecessorRevisionId: first.revisionId });
  const before = analyzeIdentity(TENANT, AT, [first, later]);
  assert.deepEqual(before.visibleFormIds, ["old"]);
  assert.deepEqual(before.excludedLaterFormIds, ["later"]);
  const after = analyzeIdentity(TENANT, "2026-10-29T09:06:00Z", [first, later]);
  assert.equal(after.relations[0]?.kind, "revision_successor");
});

test("C25 one blob can contain independent forms; foreign tenant is absent", () => {
  const result = analyzeIdentity(TENANT, AT, [
    form("one", { representationFingerprint: "1".repeat(64) }),
    form("two", { representationFingerprint: "2".repeat(64) }),
    form("foreign", { tenantId: randomUUID(), representationFingerprint: "3".repeat(64) }),
  ]);
  assert.deepEqual(result.visibleFormIds, ["one", "two"]);
  assert.equal(result.relations[0]?.kind, "unresolved");
});
