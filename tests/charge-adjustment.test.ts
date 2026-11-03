import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { allocateApprovedCost, applyChargeAdjustment, isAllocationCurrent } from "../packages/domain/src/charge-adjustment.ts";

const tenantId = randomUUID();
const chargeId = randomUUID();
const revisionId = randomUUID();
const a = randomUUID();
const b = randomUUID();
const baseAllocation = {
  chargeId, tenantId, amountMinor: "101", chargeVersion: 1, policy: "approved_weight", policyVersion: 1,
  approvalDecisionId: randomUUID(), evidenceIds: [randomUUID()],
  targets: [{ bundleId: a, weight: "1" }, { bundleId: b, weight: "1" }],
};
const state = { tenantId, chargeId, revisionId, version: 1, currentMinor: "150000" };
const baseAdjustment = {
  id: randomUUID(), tenantId, chargeId, parentRevisionId: revisionId, expectedVersion: 1,
  direction: "reversal", amountMinor: "30000", reason: "return", evidenceIds: [randomUUID()],
  approvalDecisionId: null, liability: "unknown",
};

test("C32 T14 common cost stays unallocated until approved, then largest remainder balances", () => {
  assert.deepEqual(allocateApprovedCost({ ...baseAllocation, approvalDecisionId: null }),
    { status: "unallocated", reason: "approval_missing" });
  const result = allocateApprovedCost(baseAllocation);
  assert.equal(result.status, "allocated");
  if (result.status === "allocated") {
    assert.equal(result.allocations.reduce((sum, row) => sum + BigInt(row.amountMinor), 0n), 101n);
    assert.deepEqual(result.allocations.map(row => row.amountMinor).sort(), ["50", "51"]);
    assert.equal(result.allocations.find(row => row.bundleId === [a, b].sort()[0])?.amountMinor, "51");
    assert.equal(isAllocationCurrent(result, 1), true);
    assert.equal(isAllocationCurrent(result, 2), false);
  }
  assert.throws(() => allocateApprovedCost({ ...baseAllocation,
    targets: [baseAllocation.targets[0], baseAllocation.targets[0]] }), /DUPLICATE_ALLOCATION_TARGET/);
});

test("C32 return and refund append a bounded reversal, not a negative cost row", () => {
  const result = applyChargeAdjustment(baseAdjustment, state);
  assert.equal(result.status, "proposed");
  assert.equal(result.currentMinor, "150000");
  assert.equal(result.proposedMinor, "120000");
  assert.equal(result.nextVersion, 1);
  assert.equal(result.customerChargeEligible, false);
  const approved = applyChargeAdjustment({ ...baseAdjustment, approvalDecisionId: randomUUID() }, state);
  assert.equal(approved.status, "applied");
  assert.equal(approved.nextVersion, 2);
  assert.throws(() => applyChargeAdjustment({ ...baseAdjustment, amountMinor: "150001" }, state), /OVER_REVERSAL/);
  assert.throws(() => applyChargeAdjustment({ ...baseAdjustment, direction: "increase" }, state), /RETURN_MUST_REVERSE/);
  assert.throws(() => applyChargeAdjustment({ ...baseAdjustment, expectedVersion: 0 }, state), /STALE_OR_FOREIGN_CHARGE_REVISION/);
});

test("C32 defect cost is retained while liability is unknown", () => {
  const result = applyChargeAdjustment({ ...baseAdjustment, direction: "increase", reason: "defect",
    amountMinor: "90000" }, state);
  assert.equal(result.proposedMinor, "240000");
  assert.equal(result.customerChargeEligible, false);
});
