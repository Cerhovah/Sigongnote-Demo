import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateQuote, type QuoteCostLine } from "../packages/domain/src/quote.ts";

const source=(cost:string):QuoteCostLine=>({category:"labor",quantity:"1",unitCode:"day",
  rateMinor:cost,included:true,exclusionReason:null,rateFresh:true,sourceRateId:"fixture-rate"});
const rate=(cost:string)=>[source(cost)];

test("C40 margin is cost divided by one minus margin with won ceiling",()=>{
  assert.deepEqual(calculateQuote(rate("1000000"),2000,"exclusive"),{
    state:"draft_ready",baseCostMinor:"1000000",supplyMinor:"1250000",
    vatMinor:"125000",totalMinor:"1375000",missing:[],
    lines:[{...source("1000000"),costMinor:"1000000"}]});
  assert.equal(calculateQuote(rate("33333"),2000,"not_applicable").supplyMinor,"41667");
  assert.equal(calculateQuote(rate("70000"),3000,"not_applicable").supplyMinor,"100000");
  assert.equal(calculateQuote(rate("70000"),3000,"not_applicable").vatMinor,"0");
  assert.equal(calculateQuote(rate("70000"),3000,"inclusive").state,"needs_inputs");
});

test("C40 unknown or stale rate never becomes zero",()=>{
  const missing=calculateQuote([{...source("0"),rateMinor:null,sourceRateId:null}],2000,"exclusive");
  assert.equal(missing.state,"needs_inputs");
  assert.equal(missing.baseCostMinor,null);
  assert.equal(missing.lines[0]?.costMinor,null);
  assert.equal(calculateQuote([{...source("100"),rateFresh:false}],2000,
    "exclusive").supplyMinor,null);
  assert.throws(()=>calculateQuote([{...source("100"),included:false,
    exclusionReason:null}],2000,"exclusive"),/EXCLUSION_REASON_REQUIRED/);
});
