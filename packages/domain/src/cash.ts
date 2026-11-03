import { z } from "zod";

const id = z.uuid();
const money = z.string().regex(/^[1-9][0-9]{0,18}$/);
export const cashObservationSchema = z.object({
  id, tenantId:id, accountToken:z.string().min(8).max(128).nullable(),
  counterpartyId:id.nullable().optional(),
  direction:z.enum(["incoming","outgoing"]), amountMinor:money.nullable(),
  occurredAt:z.iso.datetime({offset:true}).nullable(),
  timePrecision:z.enum(["instant","day","shorthand","unknown"]),
  normalizedMemo:z.string().max(200).nullable(),provider:z.string().max(80).nullable(),
  providerTxnId:z.string().max(180).nullable(),source:z.enum(["notification","bank","manual"]),
  evidenceId:id,
}).strict();
export type CashObservation = z.infer<typeof cashObservationSchema>;
export type CashRecord = { id:string; tenantId:string; accountToken:string; direction:CashObservation["direction"];
  counterpartyId?:string|null;
  amountMinor:string; occurredAt:string; normalizedMemo:string|null; provider:string|null;
  providerTxnId:string|null; evidenceIds:string[]; bankReconciled:boolean };

export function matchCashObservation(raw:unknown, records:CashRecord[]):
  {kind:"missing_basis"|"exact"|"review"|"new_candidate"; recordIds:string[]} {
  const observation=cashObservationSchema.parse(raw);
  if (!observation.accountToken || !observation.amountMinor || !observation.occurredAt ||
      observation.timePrecision==="shorthand" || observation.timePrecision==="unknown")
    return {kind:"missing_basis",recordIds:[]};
  const scoped=records.filter(record=>record.tenantId===observation.tenantId &&
    record.accountToken===observation.accountToken && record.direction===observation.direction);
  const exact=observation.provider && observation.providerTxnId ? scoped.filter(record=>
    record.provider===observation.provider && record.providerTxnId===observation.providerTxnId):[];
  if (exact.length>1) throw new Error("DUPLICATED_PROVIDER_TRANSACTION");
  if (exact.length===1 && exact[0]) return {kind:"exact",recordIds:[exact[0].id]};
  const observedTime=Date.parse(observation.occurredAt);
  const candidates=scoped.filter(record=>record.amountMinor===observation.amountMinor &&
    (!observation.counterpartyId || !record.counterpartyId ||
      observation.counterpartyId===record.counterpartyId) &&
    Math.abs(Date.parse(record.occurredAt)-observedTime)<=48*60*60*1000 &&
    (observation.normalizedMemo===null || record.normalizedMemo===null ||
      record.normalizedMemo===observation.normalizedMemo));
  return candidates.length ? {kind:"review",recordIds:candidates.map(item=>item.id).sort()}:
    {kind:"new_candidate",recordIds:[]};
}

export const cashApplicationSchema=z.object({
  id,tenantId:id,cashRecordId:id,invoiceId:id,amountMinor:money,
  kind:z.enum(["apply","reversal"]),reversesApplicationId:id.nullable(),
}).strict();
export type CashApplication=z.infer<typeof cashApplicationSchema>;
export function evaluateCashApplications(raw:unknown[],cash:{id:string;tenantId:string;amountMinor:string},
  invoice:{id:string;tenantId:string;approvedGrossMinor:string|null}) {
  const rows=raw.map(item=>cashApplicationSchema.parse(item));
  if (invoice.approvedGrossMinor===null) throw new Error("INVOICE_AMOUNT_UNKNOWN");
  if (new Set(rows.map(row=>row.id)).size!==rows.length) throw new Error("DUPLICATE_APPLICATION");
  const byId=new Map(rows.map(row=>[row.id,row]));
  let applied=0n;
  const reversedByOriginal=new Map<string,bigint>();
  for (const row of rows) {
    if (row.tenantId!==cash.tenantId || row.tenantId!==invoice.tenantId ||
        row.cashRecordId!==cash.id || row.invoiceId!==invoice.id) throw new Error("FOREIGN_APPLICATION");
    if (row.kind==="reversal") {
      const original=row.reversesApplicationId ? byId.get(row.reversesApplicationId):null;
      if (original?.kind!=="apply" || original.id===row.id)
        throw new Error("INVALID_APPLICATION_REVERSAL");
      reversedByOriginal.set(original.id,(reversedByOriginal.get(original.id)??0n)+BigInt(row.amountMinor));
      applied-=BigInt(row.amountMinor);
    } else {
      if (row.reversesApplicationId) throw new Error("INVALID_APPLICATION_REVERSAL");
      applied+=BigInt(row.amountMinor);
    }
  }
  for (const [originalId,reversed] of reversedByOriginal) {
    const original=byId.get(originalId);
    if (!original || reversed>BigInt(original.amountMinor)) throw new Error("OVER_APPLICATION_REVERSAL");
  }
  if (applied<0n || applied>BigInt(cash.amountMinor) || applied>BigInt(invoice.approvedGrossMinor))
    throw new Error("OVER_APPLIED_CASH");
  return {appliedMinor:applied.toString(),cashUnappliedMinor:(BigInt(cash.amountMinor)-applied).toString(),
    invoiceRemainingMinor:(BigInt(invoice.approvedGrossMinor)-applied).toString()};
}
