import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { reconcileInvoiceLinks } from "../packages/domain/src/invoice.ts";

const tenantId = randomUUID(), chargeCaseId = randomUUID(), chargeRevisionId = randomUUID();
const originalId = randomUUID(), reversalId = randomUUID(), reissueId = randomUUID();
const line = (id: string, grossMinor: string, reversesInvoiceLineId: string | null = null) => ({
  id, invoiceId: randomUUID(), tenantId, direction: "payable", stage: "other",
  supplyMinor: null, vatMinor: null, grossMinor, taxMode: "unknown", reversesInvoiceLineId,
});
const link = (invoiceLineId: string, grossMinor: string, reversesLinkId: string | null = null) => ({
  id: randomUUID(), tenantId, invoiceLineId, chargeCaseId, chargeRevisionId,
  supplyMinor: null, vatMinor: null, grossMinor, reversesLinkId,
});
const charge = { tenantId, caseId: chargeCaseId, revisionId: chargeRevisionId,
  confirmedMinor: "1100000", taxMode: "inclusive" as const };

test("C33 T72 monthly invoice reversal and reissue link N:M without new cost", () => {
  const original = link(originalId, "1100000");
  const reversed = link(reversalId, "-1100000", original.id);
  const reissued = link(reissueId, "990000");
  const result = reconcileInvoiceLinks([
    line(originalId,"1100000"), line(reversalId,"-1100000",originalId), line(reissueId,"990000"),
  ], [original,reversed,reissued], [charge]);
  assert.equal(result.chargeResults[0]?.linkedGrossMinor,"990000");
  assert.equal(result.chargeResults[0]?.unlinkedGrossMinor,"110000");
  assert.equal(result.newCostMinor,"0");
  assert.equal(result.lineResults.some(item => item.differenceException),false);
  const incomplete = reconcileInvoiceLinks([
    line(originalId,"1100000"),line(reversalId,"-1100000",originalId),line(reissueId,"990000"),
  ], [original,reversed,{...reissued,grossMinor:"1100000"}], [charge], true);
  assert.equal(incomplete.lineResults.find(item => item.invoiceLineId === reissueId)?.differenceException,true);
});

test("C33 unknown VAT is not zero and reversal must reference an original", () => {
  assert.throws(() => reconcileInvoiceLinks([{
    ...line(originalId,"1100000"),vatMinor:"0" }], [], [charge]),
  /UNKNOWN_VAT_CANNOT_BE_INFERRED/);
  assert.throws(() => reconcileInvoiceLinks([line(reversalId,"-100",randomUUID())], [], [charge]),
    /INVALID_INVOICE_LINE_REVERSAL/);
  const unknown = reconcileInvoiceLinks([line(originalId,"100")], [link(originalId,"100")],
    [{...charge,confirmedMinor:null,taxMode:"unknown"}]);
  assert.equal(unknown.chargeResults[0]?.unlinkedGrossMinor,null);
  assert.equal(unknown.chargeResults[0]?.basisUnknown,true);
});

test("C33 one monthly line can reference multiple charge revisions without creating costs", () => {
  const secondCaseId = randomUUID(), secondRevisionId = randomUUID();
  const firstLink = {...link(originalId,"400000"),grossMinor:"400000"};
  const secondLink = {...link(originalId,"500000"),chargeCaseId:secondCaseId,
    chargeRevisionId:secondRevisionId};
  const result = reconcileInvoiceLinks([line(originalId,"900000")], [firstLink,secondLink],
    [{...charge,confirmedMinor:"400000"}, {tenantId,caseId:secondCaseId,
      revisionId:secondRevisionId,confirmedMinor:"500000",taxMode:"inclusive"}]);
  assert.equal(result.lineResults[0]?.linkedGrossMinor,"900000");
  assert.equal(result.chargeResults.length,2);
  assert.equal(result.newCostMinor,"0");
});

test("C33 an older charge revision link is not silently omitted after adjustment", () => {
  const prior = link(originalId,"100");
  assert.throws(() => reconcileInvoiceLinks([line(originalId,"100")],[prior],
    [{...charge,revisionId:randomUUID(),confirmedMinor:"100"}]),
  /FOREIGN_OR_STALE_INVOICE_LINK/);
});
