import { z } from "zod";

const whole = z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/);
const id = z.uuid();
const allocationSchema = z.object({
  chargeId: id, tenantId: id, amountMinor: whole, chargeVersion: z.number().int().positive(),
  policy: z.enum(["approved_weight", "direct"]), policyVersion: z.number().int().positive(),
  approvalDecisionId: id.nullable(), evidenceIds: z.array(id).min(1),
  targets: z.array(z.object({ bundleId: id, weight: whole }).strict()).min(1),
}).strict();

export type Allocation = { bundleId: string; amountMinor: string };
export function allocateApprovedCost(input: unknown):
  { status: "unallocated"; reason: "approval_missing" } |
  { status: "allocated"; allocations: Allocation[]; totalMinor: string;
    chargeVersion: number; policyVersion: number } {
  const value = allocationSchema.parse(input);
  if (!value.approvalDecisionId) return { status: "unallocated", reason: "approval_missing" };
  const targets = [...value.targets].sort((a, b) => a.bundleId.localeCompare(b.bundleId, "en"));
  if (new Set(targets.map(target => target.bundleId)).size !== targets.length)
    throw new Error("DUPLICATE_ALLOCATION_TARGET");
  if (value.policy === "direct" && targets.length !== 1) throw new Error("DIRECT_ALLOCATION_REQUIRES_ONE_TARGET");
  const weights = targets.map(target => BigInt(target.weight));
  const weightSum = weights.reduce((sum, part) => sum + part, 0n);
  if (weightSum === 0n) throw new Error("ZERO_ALLOCATION_WEIGHT");
  const amount = BigInt(value.amountMinor);
  const amounts = weights.map(weight => amount * weight / weightSum);
  let remaining = amount - amounts.reduce((sum, part) => sum + part, 0n);
  const rank = targets.map((target, index) => ({ index, bundleId: target.bundleId,
    remainder: amount * BigInt(target.weight) % weightSum }))
    .sort((a, b) => a.remainder === b.remainder ? a.bundleId.localeCompare(b.bundleId, "en") :
      a.remainder > b.remainder ? -1 : 1);
  for (const entry of rank) {
    if (remaining === 0n) break;
    amounts[entry.index] = (amounts[entry.index] ?? 0n) + 1n;
    remaining--;
  }
  return { status: "allocated", totalMinor: value.amountMinor, chargeVersion: value.chargeVersion,
    policyVersion: value.policyVersion,
    allocations: targets.map((target, index) => ({ bundleId: target.bundleId,
      amountMinor: (amounts[index] ?? 0n).toString() })) };
}
export function isAllocationCurrent(allocation: { status: string; chargeVersion?: number },
  currentChargeVersion: number): boolean {
  return allocation.status === "allocated" && allocation.chargeVersion === currentChargeVersion;
}

const adjustmentSchema = z.object({
  id, tenantId: id, chargeId: id, parentRevisionId: id, expectedVersion: z.number().int().nonnegative(),
  direction: z.enum(["increase", "reversal"]), amountMinor: whole,
  reason: z.enum(["change", "return", "refund", "defect", "correction"]),
  evidenceIds: z.array(id).min(1), approvalDecisionId: id.nullable(),
  liability: z.enum(["unknown", "company", "customer", "supplier"]),
}).strict();
export type ChargeAdjustment = z.infer<typeof adjustmentSchema>;

export function applyChargeAdjustment(input: unknown, state: {
  tenantId: string; chargeId: string; revisionId: string; version: number; currentMinor: string;
}): { adjustment: ChargeAdjustment; status: "proposed" | "applied";
  currentMinor: string; proposedMinor: string; nextVersion: number;
  customerChargeEligible: boolean } {
  const adjustment = adjustmentSchema.parse(input);
  if (adjustment.tenantId !== state.tenantId || adjustment.chargeId !== state.chargeId ||
      adjustment.parentRevisionId !== state.revisionId || adjustment.expectedVersion !== state.version)
    throw new Error("STALE_OR_FOREIGN_CHARGE_REVISION");
  const amount = BigInt(adjustment.amountMinor);
  const current = BigInt(whole.parse(state.currentMinor));
  if (amount === 0n) throw new Error("ZERO_ADJUSTMENT");
  if (adjustment.direction === "reversal" && amount > current) throw new Error("OVER_REVERSAL");
  if (adjustment.reason === "return" || adjustment.reason === "refund") {
    if (adjustment.direction !== "reversal") throw new Error("RETURN_MUST_REVERSE");
  }
  const approved = adjustment.approvalDecisionId !== null;
  return { adjustment, status: approved ? "applied" : "proposed", currentMinor: state.currentMinor,
    proposedMinor: (adjustment.direction === "reversal" ? current - amount : current + amount).toString(),
    nextVersion: approved ? state.version + 1 : state.version,
    customerChargeEligible: approved && adjustment.liability === "customer" };
}
