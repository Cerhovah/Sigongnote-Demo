import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {test} from "node:test";
import {evaluateCashApplications,matchCashObservation,type CashRecord} from "../packages/domain/src/cash.ts";

const tenantId=randomUUID(),accountToken="acct-synthetic-001",recordId=randomUUID(),evidenceId=randomUUID();
const record:CashRecord={id:recordId,tenantId,accountToken,direction:"incoming",amountMinor:"300000",
  occurredAt:"2026-09-01T12:00:00+09:00",normalizedMemo:"fixture",provider:null,providerTxnId:null,
  evidenceIds:[evidenceId],bankReconciled:false};
const observation=(overrides:Record<string,unknown>={})=>({id:randomUUID(),tenantId,accountToken,
  direction:"incoming",amountMinor:"300000",occurredAt:"2026-09-01T12:05:00+09:00",
  timePrecision:"instant",normalizedMemo:"fixture",provider:"bank-fixture",providerTxnId:"txn-1",
  source:"bank",evidenceId:randomUUID(),...overrides});

test("C34 T71 late bank ID searches existing manual cash even when ID exists",()=>{
  assert.deepEqual(matchCashObservation(observation(),[record]),{kind:"review",recordIds:[recordId]});
  const withId={...record,provider:"bank-fixture",providerTxnId:"txn-1"};
  assert.deepEqual(matchCashObservation(observation(),[withId]),{kind:"exact",recordIds:[recordId]});
  assert.deepEqual(matchCashObservation(observation({amountMinor:"300001"}),[record]),
    {kind:"new_candidate",recordIds:[]});
  assert.deepEqual(matchCashObservation(observation({accountToken:null}),[record]),
    {kind:"missing_basis",recordIds:[]});
});

test("C34 T09 shorthand payment date never becomes cash amount or reconciled transfer",()=>{
  assert.deepEqual(matchCashObservation(observation({amountMinor:null,occurredAt:null,
    timePrecision:"shorthand",source:"manual"}),[record]),{kind:"missing_basis",recordIds:[]});
});

test("C34 partial application and reversal cannot exceed cash or invoice",()=>{
  const invoice={id:randomUUID(),tenantId,approvedGrossMinor:"200000"};
  const base={id:randomUUID(),tenantId,cashRecordId:recordId,invoiceId:invoice.id,
    amountMinor:"150000",kind:"apply",reversesApplicationId:null};
  const partial=evaluateCashApplications([base],record,invoice);
  assert.deepEqual(partial,{appliedMinor:"150000",cashUnappliedMinor:"150000",
    invoiceRemainingMinor:"50000"});
  const reversal={...base,id:randomUUID(),kind:"reversal",amountMinor:"50000",
    reversesApplicationId:base.id};
  assert.equal(evaluateCashApplications([base,reversal],record,invoice).appliedMinor,"100000");
  assert.throws(()=>evaluateCashApplications([base,{...base,id:randomUUID(),amountMinor:"60000"}],record,invoice),
    /OVER_APPLIED_CASH/);
  assert.throws(()=>evaluateCashApplications([base,{...reversal,amountMinor:"150001"}],record,invoice),
    /OVER_APPLICATION_REVERSAL/);
  assert.throws(()=>evaluateCashApplications([base,reversal,
    {...reversal,id:randomUUID(),amountMinor:"100001"}],record,invoice),
    /OVER_APPLICATION_REVERSAL/);
});
