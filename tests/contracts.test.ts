import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { MoneySchema, SourceDateSchema, UtcTimestampSchema, BridgeRequestSchema, schemas } from "../packages/contracts/src/schemas.ts";
import { parseMoney, knownMinor, parseQuantity, quantityMicros, canonicalQuantity } from "../packages/contracts/src/validation.ts";
import { makeApiError } from "../packages/contracts/src/errors.ts";

test("unknown and not-applicable are never zero; exact 20-digit money survives JSON", () => {
 for(const knowledge of ["unknown","not_applicable"]) {
  assert.equal(parseMoney({currency:"KRW",minor:null,knowledge}).minor,null);
  assert.throws(()=>knownMinor({currency:"KRW",minor:null,knowledge}));
  assert.equal(MoneySchema.safeParse({currency:"KRW",minor:"0",knowledge}).success,false);
 }
 const money={currency:"KRW",minor:"99999999999999999999",knowledge:"known"};
 assert.equal(knownMinor(JSON.parse(JSON.stringify(money))),99999999999999999999n);
 assert.equal(knownMinor({...money,minor:"0"}),0n);
 assert.equal(knownMinor({...money,minor:"-1100000"}),-1100000n);
 for(const minor of [null,0,0.1,NaN,Infinity,"1e6","01","+1","-0","100000000000000000000"]) assert.equal(MoneySchema.safeParse({...money,minor}).success,false);
 assert.equal(MoneySchema.safeParse({...money,currency:"USD"}).success,false);
 assert.equal(MoneySchema.safeParse({...money,approved:true}).success,false);
});
test("quantity keeps meaning, precise fractions and negative returns; unregistered units fail", () => {
 const item={value:"80",unit_code:"ea",raw_text:"80틀",semantic:"scope"};
 assert.equal(parseQuantity(item).semantic,"scope");
 assert.equal(quantityMicros({...item,value:"-0.000001",semantic:"returned"}),-1n);
 assert.equal(quantityMicros({...item,value:"99999999999999.999999"}),99999999999999999999n);
 for(const value of ["1e2","NaN","Infinity","0.0000001","100000000000000",1]) assert.throws(()=>parseQuantity({...item,value}));
 assert.throws(()=>parseQuantity({...item,unit_code:"banana"}));
 assert.throws(()=>parseQuantity({...item,unit_code:"m2/day"}));
 assert.equal(parseQuantity({...item,unit_code:"panel"},new Set(["panel"])).unit_code,"panel");
 assert.throws(()=>parseQuantity({...item,semantic:"paid"}));
 assert.equal(canonicalQuantity({...item,value:"-0.000000"}).value,"0");
 assert.equal(canonicalQuantity({...item,value:"1.500000"}).value,"1.5");
 assert.equal(canonicalQuantity({...item,value:"1.500000"}).raw_text,"80틀");
});

test("shared TS/Python wire vectors agree on full strings and ASCII digits", () => {
 const vectors=JSON.parse(readFileSync(new URL("../fixtures/synthetic/contract-validation.json",import.meta.url),"utf8")) as {name:keyof typeof schemas;value:unknown;accepted:boolean;label:string}[];
 for(const vector of vectors) assert.equal(schemas[vector.name].safeParse(vector.value).success,vector.accepted,vector.label);
});
test("source dates do not invent a year or silently normalize invalid dates", () => {
 const raw={raw:"6.02",date:null,precision:"unknown",inferred_components:[]};
 assert.deepEqual(SourceDateSchema.parse(raw),raw);
 assert.equal(SourceDateSchema.safeParse({...raw,date:"2026-06-02"}).success,false);
 for(const date of ["2026-02-29","2026-02-30","2026-13-01"]) assert.equal(SourceDateSchema.safeParse({...raw,date,precision:"day"}).success,false);
 assert.equal(SourceDateSchema.safeParse({...raw,date:"2024-02-29",precision:"day"}).success,true);
 assert.equal(UtcTimestampSchema.safeParse("2026-09-28T00:00:00Z").success,true);
 for(const date of ["2026-09-28T00:00:00","2026-09-28T09:00:00+09:00","2026-02-30T00:00:00Z"]) assert.equal(UtcTimestampSchema.safeParse(date).success,false);
});
test("safe errors expose only contract details and intended retry guidance", () => {
 const id="11111111-1111-4111-8111-111111111111";
 const error=makeApiError("VERSION_CONFLICT",id,{current_version:8,action:"refresh_diff"});
 assert.equal(error.status,409);
 assert.equal(error.body.error.retryable,false);
 assert.equal(makeApiError("TEMPORARILY_UNAVAILABLE",id).body.error.retryable,true);
 assert.throws(()=>makeApiError("FORBIDDEN","not-a-uuid"));
 assert.throws(()=>makeApiError("FORBIDDEN",id,{current_version:0}));
});
test("bridge v1 rejects arbitrary paths, methods and loose payloads", () => {
 const request={bridgeVersion:1,requestId:"11111111-1111-4111-8111-111111111111",method:"getQueueSummary",payload:{}};
 assert.equal(BridgeRequestSchema.safeParse(request).success,true);
 for(const invalid of [{...request,method:"shell"},{...request,bridgeVersion:2},{...request,payload:{path:"private-file"}},{...request,method:"openEvidence",payload:{}}]) assert.equal(BridgeRequestSchema.safeParse(invalid).success,false);
});
