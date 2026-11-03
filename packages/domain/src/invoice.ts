import { z } from "zod";

const id = z.uuid();
const signed = z.string().regex(/^-?(?:0|[1-9][0-9]{0,18})$/);
export const invoiceLineSchema = z.object({
  id, invoiceId: id, tenantId: id, direction: z.enum(["receivable", "payable"]),
  stage: z.enum(["advance", "progress", "final", "other"]),
  supplyMinor: signed.nullable(), vatMinor: signed.nullable(), grossMinor: signed,
  taxMode: z.enum(["unknown", "exclusive", "inclusive", "not_applicable"]),
  reversesInvoiceLineId: id.nullable(),
}).strict().superRefine((line, context) => {
  const gross = BigInt(line.grossMinor);
  if ((gross < 0n) !== (line.reversesInvoiceLineId !== null))
    context.addIssue({code:"custom",message:"SIGNED_INVOICE_REVISION_REQUIRED"});
  if (line.taxMode === "unknown" && line.vatMinor !== null)
    context.addIssue({code:"custom",message:"UNKNOWN_VAT_CANNOT_BE_INFERRED"});
  if (line.supplyMinor !== null && line.vatMinor !== null &&
      BigInt(line.supplyMinor) + BigInt(line.vatMinor) !== gross)
    context.addIssue({code:"custom",message:"INVOICE_TAX_SUM_MISMATCH"});
});
export type InvoiceLine = z.infer<typeof invoiceLineSchema>;
export const invoiceChargeLinkSchema = z.object({
  id, tenantId: id, invoiceLineId: id, chargeCaseId: id, chargeRevisionId: id,
  supplyMinor: signed.nullable(), vatMinor: signed.nullable(), grossMinor: signed,
  reversesLinkId: id.nullable(),
}).strict();
export type InvoiceChargeLink = z.infer<typeof invoiceChargeLinkSchema>;

export function reconcileInvoiceLinks(linesInput: unknown[], linksInput: unknown[],
  charges: { tenantId: string; caseId: string; revisionId: string; confirmedMinor: string | null;
    taxMode: InvoiceLine["taxMode"] }[], claimComplete = false) {
  const lines = linesInput.map(item => invoiceLineSchema.parse(item));
  const links = linksInput.map(item => invoiceChargeLinkSchema.parse(item));
  if (new Set(lines.map(item => item.id)).size !== lines.length ||
      new Set(links.map(item => item.id)).size !== links.length) throw new Error("DUPLICATE_INVOICE_OPERATION");
  const byLine = new Map(lines.map(item => [item.id, item]));
  const byLink = new Map(links.map(item => [item.id, item]));
  const byCharge = new Map(charges.map(item => [item.caseId, item]));
  if (byCharge.size !== charges.length) throw new Error("DUPLICATE_CHARGE_INPUT");
  const reversalByOriginal = new Map<string, bigint>();
  for (const line of lines) if (line.reversesInvoiceLineId) {
    const original = byLine.get(line.reversesInvoiceLineId);
    if (!original || original.tenantId !== line.tenantId || original.direction !== line.direction ||
        BigInt(original.grossMinor) <= 0n) throw new Error("INVALID_INVOICE_LINE_REVERSAL");
    reversalByOriginal.set(`line:${original.id}`,
      (reversalByOriginal.get(`line:${original.id}`) ?? 0n) - BigInt(line.grossMinor));
  }
  for (const link of links) {
    const line = byLine.get(link.invoiceLineId), charge = byCharge.get(link.chargeCaseId);
    if (!line || !charge || line.tenantId !== link.tenantId || charge.tenantId !== link.tenantId ||
        charge.revisionId !== link.chargeRevisionId || line.direction !== "payable")
      throw new Error("FOREIGN_OR_STALE_INVOICE_LINK");
    if (line.taxMode === "unknown" && link.vatMinor !== null) throw new Error("UNKNOWN_VAT_CANNOT_BE_INFERRED");
    const gross = BigInt(link.grossMinor);
    if (link.supplyMinor !== null && link.vatMinor !== null &&
        BigInt(link.supplyMinor) + BigInt(link.vatMinor) !== gross)
      throw new Error("INVOICE_LINK_TAX_SUM_MISMATCH");
    if (link.reversesLinkId) {
      const original = byLink.get(link.reversesLinkId);
      if (!original || BigInt(original.grossMinor) <= 0n || gross >= 0n ||
          original.tenantId !== link.tenantId || original.chargeCaseId !== link.chargeCaseId ||
          original.chargeRevisionId !== link.chargeRevisionId)
        throw new Error("INVALID_INVOICE_REVERSAL");
      reversalByOriginal.set(original.id, (reversalByOriginal.get(original.id) ?? 0n) - gross);
    } else if (gross < 0n) throw new Error("NEGATIVE_LINK_REQUIRES_REVERSAL");
  }
  for (const [originalId, reversed] of reversalByOriginal) {
    if (originalId.startsWith("line:")) {
      const original = byLine.get(originalId.slice(5));
      if (!original || reversed > BigInt(original.grossMinor)) throw new Error("OVER_INVOICE_REVERSAL");
      continue;
    }
    const original = byLink.get(originalId);
    if (!original || reversed > BigInt(original.grossMinor)) throw new Error("OVER_INVOICE_REVERSAL");
  }
  const lineResults = lines.map(line => {
    const attached = links.filter(link => link.invoiceLineId === line.id);
    const grossLinked = attached.reduce((sum, link) => sum + BigInt(link.grossMinor), 0n);
    const gross = BigInt(line.grossMinor);
    return { invoiceLineId: line.id, grossMinor: line.grossMinor,
      linkedGrossMinor: grossLinked.toString(), unmatchedGrossMinor: (gross - grossLinked).toString(),
      differenceException: claimComplete && gross !== grossLinked };
  });
  const chargeResults = charges.map(charge => {
    const attached = links.filter(link => link.chargeCaseId === charge.caseId);
    const linked = attached.reduce((sum, link) => sum + BigInt(link.grossMinor), 0n);
    const comparable = charge.confirmedMinor !== null && charge.taxMode !== "unknown";
    if (linked < 0n || comparable && linked > BigInt(charge.confirmedMinor ?? "0"))
      throw new Error("OVER_LINKED_CHARGE");
    return { chargeCaseId: charge.caseId, linkedGrossMinor: linked.toString(),
      unlinkedGrossMinor: comparable ? (BigInt(charge.confirmedMinor ?? "0") - linked).toString() : null,
      basisUnknown: !comparable };
  });
  return { lineResults, chargeResults, newCostMinor: "0" };
}
