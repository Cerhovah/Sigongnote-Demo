import { z } from "zod";

const minor = z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/);
const quantity = z.object({ value: z.string().regex(/^(?:0|[1-9][0-9]{0,12})(?:\.[0-9]{1,6})?$/),
  unitCode: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), semantic: z.enum(["scope","billing"]) }).strict();
export const chargeCaseSchema = z.object({
  id: z.uuid(), tenantId: z.uuid(), bundleId: z.uuid(),
  category: z.enum(["material","labor","transport","equipment","revisit","defect","change","overhead"]),
  partyId: z.uuid().nullable(), identityState: z.enum(["unresolved","confirmed_distinct","confirmed_same"]),
  canonicalCaseId: z.uuid().nullable(),
  scopeQuantity: quantity.nullable(), billingQuantity: quantity.nullable(), billingRateMinor: minor.nullable(),
  billingRatePerUnit: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).nullable(),
  expectedMinor: minor.nullable(), contractedMinor: minor.nullable(), documentedMinor: minor.nullable(),
  confirmedActualMinor: minor.nullable(), customerChargeMinor: minor.nullable(), paidMinor: minor.nullable(),
  evidenceIds: z.array(z.uuid()).min(1), status: z.enum(["candidate","documented","confirmed","disputed","adjusted","reversed"]),
  taxMode: z.enum(["unknown","exclusive","inclusive","not_applicable"]),
  settlementParentId: z.uuid().nullable(),
}).strict();
export type ChargeCase = z.infer<typeof chargeCaseSchema>;

function micros(value: string): bigint {
  const [whole="0", fraction=""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6,"0"));
}
export function calculateBillingAmount(billingQuantity: ChargeCase["billingQuantity"],
  billingRateMinor: string | null, billingRatePerUnit: string | null,
  approvedUnits: ReadonlySet<string>): string | null {
  if (!billingQuantity || billingRateMinor === null) return null;
  if (!quantity.safeParse(billingQuantity).success || billingQuantity.semantic !== "billing" ||
      !approvedUnits.has(billingQuantity.unitCode) ||
      billingRatePerUnit !== billingQuantity.unitCode || !minor.safeParse(billingRateMinor).success)
    throw new Error("INVALID_BILLING_BASIS");
  const product = micros(billingQuantity.value) * BigInt(billingRateMinor);
  return ((product + 500_000n) / 1_000_000n).toString();
}

export function inspectChargeCase(input: unknown, approvedUnits: ReadonlySet<string>): {
  charge: ChargeCase; computedMinor: string | null; discrepancyMinor: string | null;
  confirmationBlockers: string[] } {
  const charge = chargeCaseSchema.parse(input);
  for (const basis of [charge.scopeQuantity, charge.billingQuantity]) {
    if (basis && !approvedUnits.has(basis.unitCode)) throw new Error("UNAPPROVED_UNIT");
  }
  if ((charge.billingRateMinor === null) !== (charge.billingRatePerUnit === null))
    throw new Error("INVALID_BILLING_BASIS");
  const computedMinor = calculateBillingAmount(charge.billingQuantity, charge.billingRateMinor,
    charge.billingRatePerUnit, approvedUnits);
  const discrepancyMinor = charge.documentedMinor !== null && computedMinor !== null ?
    (BigInt(charge.documentedMinor) - BigInt(computedMinor)).toString() : null;
  const blockers: string[] = [];
  if (charge.identityState === "unresolved") blockers.push("transaction_identity_unresolved");
  if (charge.identityState === "confirmed_same") blockers.push("duplicate_evidence_not_new_cost");
  if (!charge.partyId) blockers.push("party_unknown");
  if (!charge.billingQuantity && charge.documentedMinor === null) blockers.push("billing_basis_unknown");
  if (charge.confirmedActualMinor === null) blockers.push("actual_cost_unknown");
  if (charge.status === "confirmed" && blockers.length) throw new Error("UNSAFE_CONFIRMED_CHARGE");
  if ((charge.identityState === "confirmed_same") !== (charge.canonicalCaseId !== null) ||
      charge.canonicalCaseId === charge.id ||
      charge.identityState === "confirmed_same" && [charge.expectedMinor, charge.contractedMinor,
        charge.documentedMinor, charge.confirmedActualMinor, charge.customerChargeMinor,
        charge.paidMinor].some(value => value !== null)) {
    throw new Error("INVALID_CANONICAL_CHARGE_LINK");
  }
  if (charge.settlementParentId && charge.billingQuantity?.unitCode === "lump" &&
      charge.confirmedActualMinor !== null) throw new Error("DUPLICATED_PARENT_LUMP_COST");
  return { charge, computedMinor, discrepancyMinor, confirmationBlockers: blockers };
}

export function summarizeCharges(cases: ChargeCase[]): {
  confirmedKnownMinor: string; confirmedComparableMinor: string | null;
  unknownCaseIds: string[]; candidateCaseIds: string[];
  taxUnknownCaseIds: string[]; taxModes: string[]; mixedTaxMode: boolean; complete: boolean } {
  const ids = new Set<string>();
  let known = 0n;
  const unknownCaseIds: string[] = [];
  const candidateCaseIds: string[] = [];
  const taxUnknownCaseIds: string[] = [];
  const taxModes = new Set<string>();
  const byId = new Map(cases.map(item => [item.id, item]));
  for (const charge of cases) {
    if (ids.has(charge.id)) throw new Error("DUPLICATE_CHARGE_CASE_ID");
    ids.add(charge.id);
    if (charge.identityState === "confirmed_same") {
      const canonical = charge.canonicalCaseId ? byId.get(charge.canonicalCaseId) : null;
      if (!canonical || canonical.tenantId !== charge.tenantId || canonical.bundleId !== charge.bundleId ||
          canonical.identityState !== "confirmed_distinct" || charge.confirmedActualMinor !== null) {
        throw new Error("INVALID_CANONICAL_CHARGE_LINK");
      }
      continue;
    }
    if (charge.status === "confirmed" && charge.confirmedActualMinor !== null) {
      known += BigInt(charge.confirmedActualMinor);
      taxModes.add(charge.taxMode);
      if (charge.taxMode === "unknown") taxUnknownCaseIds.push(charge.id);
    }
    else if (charge.status !== "reversed") {
      if (charge.confirmedActualMinor === null) unknownCaseIds.push(charge.id);
      candidateCaseIds.push(charge.id);
    }
  }
  return { confirmedKnownMinor: known.toString(),
    confirmedComparableMinor: taxUnknownCaseIds.length || taxModes.size > 1 ? null : known.toString(),
    unknownCaseIds, candidateCaseIds,
    taxUnknownCaseIds, taxModes: [...taxModes].sort(), mixedTaxMode: taxModes.size > 1,
    complete: unknownCaseIds.length === 0 && candidateCaseIds.length === 0 &&
      taxUnknownCaseIds.length === 0 && taxModes.size <= 1 };
}
