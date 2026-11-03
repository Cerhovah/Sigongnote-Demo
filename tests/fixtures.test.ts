import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { verifyFixtureCatalog } from "../scripts/fixture-catalog.mjs";
import { BASE_UNITS, parseQuantity } from "../packages/contracts/src/validation.ts";

test("C08 structural surrogates keep source lineage, locators and all 30 typed oracles", () => {
  const {structures,oracles,registries,sourceIndex,fixtureSha256}=verifyFixtureCatalog();
  assert.equal(structures.documents.length,8);
  assert.equal(oracles.cases.length,30);
  assert.equal(sourceIndex.cases.length,78);
  assert.match(fixtureSha256,/^[0-9a-f]{64}$/);
  assert.equal(oracles.execution_state,"NOT_RUN");
  assert.equal(oracles.cases.every(item=>!Object.hasOwn(item,"execution_state")),true);
  assert.deepEqual(new Set(registries.base),BASE_UNITS);
  const joineryUnits=new Set([...BASE_UNITS,...registries["joinery-v1"]]);
  for(const unit_code of ["panel","frame"]) {
    const quantity={value:"1",unit_code,raw_text:"합성 단위",semantic:"scope"};
    assert.throws(()=>parseQuantity(quantity));
    assert.equal(parseQuantity(quantity,joineryUnits).unit_code,unit_code);
  }
});

test("case selector reports NOT_RUN without treating fixture validity as acceptance", () => {
  const result=spawnSync(process.execPath,["scripts/run-case.mjs","T01","T30"],{
    encoding:"utf8"});
  assert.equal(result.status,2);
  const records=result.stdout.trim().split(/\r?\n/).map(line=>JSON.parse(line));
  assert.deepEqual(records.map(item=>item.case_id),["T01","T30"]);
  assert.equal(records.every(item=>item.status==="NOT_RUN" && item.actual===null),true);
  assert.ok(records[0].expected.document_quantity);
  const fixtureCheck=spawnSync(process.execPath,
    ["scripts/run-case.mjs","--verify-fixtures"],{encoding:"utf8"});
  assert.equal(fixtureCheck.status,0);
  assert.equal(fixtureCheck.stdout.trim(),"PASS");
});
