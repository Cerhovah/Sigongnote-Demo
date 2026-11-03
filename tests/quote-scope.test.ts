import assert from "node:assert/strict";
import {test} from "node:test";
import {allocateScopeSupply,applyContractOperation} from "../packages/domain/src/quote-scope.ts";

test("C41 T73 replacement changes 30 to 35, not 65, and leaves other lines untouched",()=>{
  const before=new Map([["waterproof",{quantityValue:"20",supplyMinor:"200000"}],
    ["tile",{quantityValue:"30",supplyMinor:"300000"}]]);
  const after=new Map(before);
  after.set("tile",applyContractOperation(before.get("tile")??null,"replace","35","350000"));
  after.set("grout",applyContractOperation(null,"add","20","200000"));
  assert.deepEqual([...after.values()].map(item=>item.quantityValue),["20","35","20"]);
  assert.deepEqual(before.get("tile"),{quantityValue:"30",supplyMinor:"300000"});
  assert.equal(applyContractOperation(before.get("tile")??null,"delta","5","50000").quantityValue,"35");
});
test("C41 supply allocation is exact and operation quantities use decimal integers",()=>{
  const allocated=allocateScopeSupply([{id:"a",costMinor:"1"},{id:"b",costMinor:"1"}],"3");
  assert.deepEqual([...allocated.values()], ["2","1"]);
  assert.equal(applyContractOperation({quantityValue:"30.5",supplyMinor:"305"},"delta",
    "-0.5","5").quantityValue,"30");
  assert.throws(()=>applyContractOperation({quantityValue:"30",supplyMinor:"30"},
    "replace","0","0"),/INVALID_SCOPE_OPERATION/);
});
