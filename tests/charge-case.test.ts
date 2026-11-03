import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { calculateBillingAmount, inspectChargeCase, summarizeCharges } from "../packages/domain/src/charge-case.ts";

const tenantId = randomUUID();
const bundleId = randomUUID();
const approvedUnits = new Set(["day", "ea", "lump"]);

function charge(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(), tenantId, bundleId, category: "labor", partyId: randomUUID(),
    identityState: "confirmed_distinct", canonicalCaseId: null,
    scopeQuantity: { value: "80", unitCode: "ea", semantic: "scope" },
    billingQuantity: { value: "5", unitCode: "day", semantic: "billing" },
    billingRateMinor: "300000", billingRatePerUnit: "day", expectedMinor: null, contractedMinor: null,
    documentedMinor: null, confirmedActualMinor: "1500000", customerChargeMinor: null,
    paidMinor: null, evidenceIds: [randomUUID()], status: "confirmed", taxMode: "unknown",
    settlementParentId: null, ...overrides,
  };
}

test("C31 T06 uses billing days, never scope frames or elapsed calendar days", () => {
  const first = inspectChargeCase(charge(), approvedUnits);
  const second = inspectChargeCase(charge({ billingQuantity: { value: "4", unitCode: "day", semantic: "billing" },
    confirmedActualMinor: "1200000" }), approvedUnits);
  assert.equal(first.computedMinor, "1500000");
  assert.equal(second.computedMinor, "1200000");
  assert.equal(summarizeCharges([first.charge, second.charge]).confirmedKnownMinor, "2700000");
  assert.equal(first.charge.paidMinor, null);
  assert.throws(() => calculateBillingAmount(first.charge.scopeQuantity, "300000", "ea", approvedUnits), /INVALID_BILLING_BASIS/);
  assert.throws(() => inspectChargeCase(charge({ billingRatePerUnit: "ea" }), approvedUnits), /INVALID_BILLING_BASIS/);
});

test("C31 T07 parent lump is one cost while four task rows are references", () => {
  const parent = inspectChargeCase(charge({ scopeQuantity: null,
    billingQuantity: { value: "1", unitCode: "lump", semantic: "billing" },
    billingRateMinor: null, billingRatePerUnit: null, documentedMinor: "150000", confirmedActualMinor: "150000" }), approvedUnits).charge;
  const children = Array.from({ length: 4 }, () => inspectChargeCase(charge({
    identityState: "confirmed_same", canonicalCaseId: parent.id, settlementParentId: parent.id,
    billingQuantity: null, billingRateMinor: null, billingRatePerUnit: null, documentedMinor: null,
    confirmedActualMinor: null, status: "candidate",
  }), approvedUnits).charge);
  assert.equal(summarizeCharges([parent, ...children]).confirmedKnownMinor, "150000");
  assert.equal(parent.billingRateMinor, null);
  assert.throws(() => inspectChargeCase({ ...children[0], confirmedActualMinor: "150000" }, approvedUnits),
    /INVALID_CANONICAL_CHARGE_LINK/);
  assert.throws(() => inspectChargeCase({ ...children[0], customerChargeMinor: "150000" }, approvedUnits),
    /INVALID_CANONICAL_CHARGE_LINK/);
  assert.throws(() => inspectChargeCase({ ...children[0], paidMinor: "150000" }, approvedUnits),
    /INVALID_CANONICAL_CHARGE_LINK/);
});

test("C31 unknown is not zero, evidence identity and documented discrepancy stay separate", () => {
  const unknown = inspectChargeCase(charge({ partyId: null, identityState: "unresolved",
    confirmedActualMinor: null, documentedMinor: "150001", status: "candidate" }), approvedUnits);
  assert.equal(unknown.discrepancyMinor, "-1349999");
  assert.ok(unknown.confirmationBlockers.includes("actual_cost_unknown"));
  assert.deepEqual(summarizeCharges([unknown.charge]), { confirmedKnownMinor: "0", confirmedComparableMinor: "0",
    unknownCaseIds: [unknown.charge.id], candidateCaseIds: [unknown.charge.id],
    taxUnknownCaseIds: [], taxModes: [], mixedTaxMode: false, complete: false });
  assert.throws(() => inspectChargeCase({ ...unknown.charge, status: "confirmed" }, approvedUnits),
    /UNSAFE_CONFIRMED_CHARGE/);
  assert.throws(() => inspectChargeCase({ ...unknown.charge, billingQuantity: { value: "1", unitCode: "bogus", semantic: "billing" } }, approvedUnits), /UNAPPROVED_UNIT/);
});

test("C31 fixed decimal rounds half up without floating point", () => {
  assert.equal(calculateBillingAmount({ value: "0.333335", unitCode: "ea", semantic: "billing" },
    "300000", "ea", approvedUnits), "100001");
  assert.throws(() => calculateBillingAmount({ value: "-0.5", unitCode: "ea", semantic: "billing" },
    "3", "ea", approvedUnits));
});

test("C31 unknown or mixed tax basis cannot produce comparable confirmed total", () => {
  const unknown = inspectChargeCase(charge(), approvedUnits).charge;
  assert.equal(summarizeCharges([unknown]).confirmedComparableMinor, null);
  const exclusive = inspectChargeCase(charge({ taxMode: "exclusive" }), approvedUnits).charge;
  const inclusive = inspectChargeCase(charge({ taxMode: "inclusive" }), approvedUnits).charge;
  const summary = summarizeCharges([exclusive, inclusive]);
  assert.equal(summary.mixedTaxMode, true);
  assert.equal(summary.confirmedComparableMinor, null);
  assert.equal(summary.complete, false);
});
