import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { schemas } from "../packages/contracts/src/schemas.js";
const expected = JSON.parse(readFileSync("fixtures/synthetic/contract-wire.json","utf8")) as {name:keyof typeof schemas;value:unknown}[];
const commands: [string,string[]][] = [
 ["dotnet",["run","--project","tests/contracts-native","-p:RestoreLockedMode=true","--verbosity","quiet","--","fixtures/synthetic/contract-wire.json"]],
 process.platform==="win32" ? ["pwsh",["-NoProfile","-Command","./apps/android/gradlew.bat -p apps/android :contracts:wireSmoke --quiet --no-daemon"]] : ["sh",["apps/android/gradlew","-p","apps/android",":contracts:wireSmoke","--quiet","--no-daemon"]],
];
for(const [command,args] of commands) {
 const result=spawnSync(command,args,{encoding:"utf8",maxBuffer:8*1024*1024});
 if(result.status!==0) throw new Error(`${command}: ${result.error?.message??result.stdout+result.stderr}`);
 const actual=result.stdout.split(/\r?\n/).filter(line=>line.startsWith("{")).map(line=>JSON.parse(line));
 assert.equal(actual.length,expected.length);
 for(let i=0;i<expected.length;i++) {
  const fixture=expected[i]; if(!fixture) throw new Error("Missing fixture");
  assert.equal(actual[i].name,fixture.name);
  schemas[fixture.name].parse(actual[i].value);
  assert.deepEqual(actual[i].value,fixture.value);
 }
}
console.log("PASS");
