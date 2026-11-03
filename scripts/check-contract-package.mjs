import assert from "node:assert/strict";
import { knownMinor, parseMoney } from "@sigongnote/contracts";
assert.equal(knownMinor({currency:"KRW",minor:"99999999999999999999",knowledge:"known"}),99999999999999999999n);
assert.equal(parseMoney({currency:"KRW",minor:null,knowledge:"unknown"}).minor,null);
console.log("PASS");
