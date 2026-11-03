import { spawnSync } from "node:child_process";
import { gitRead, inspectStaged } from "./check-staged.mjs";
import { checkExecutionState } from "./execution-state.mjs";
const unit = process.argv[process.argv.indexOf("--unit") + 1];
const commands = {
 C01: [["run","typecheck"],["run","lint"],["run","build"],["test"]],
 C02: [["run","contracts:check"],["run","build","--workspace","@sigongnote/contracts"],["run","contracts:package"],["run","typecheck"],["run","lint"],["run","test:contract"],["run","contracts:native"]],
 C03: [["run","check:db"],["run","test:tenant"],["run","test:local-env"],["run","typecheck"],["run","lint"]],
 C04: [["run","contracts:check"],["run","build","--workspace","@sigongnote/contracts"],["run","build","--workspace","@sigongnote/api"],["run","typecheck"],["run","lint"],["run","contracts:native"],["run","test:tenant"],["run","test:auth"]],
 C05: [["run","contracts:check"],["run","build","--workspace","@sigongnote/contracts"],["run","build","--workspace","@sigongnote/api"],["run","typecheck"],["run","lint"],["run","contracts:native"],["run","test:tenant"],["run","test:auth"],["run","test:ingestion"]],
 C06: [["run","contracts:check"],["run","build","--workspace","@sigongnote/contracts"],["run","build","--workspace","@sigongnote/api"],["run","typecheck"],["run","lint"],["run","contracts:native"],["run","test:tenant"],["run","test:ingestion"],["run","test:jobs"]],
 C07: [["run","contracts:check"],["run","build","--workspace","@sigongnote/contracts"],["run","build","--workspace","@sigongnote/api"],["run","typecheck"],["run","lint"],["run","contracts:native"],["run","test:tenant"],["run","test:auth"],["run","test:ingestion"],["run","test:jobs"],["run","test:capture-sources"]],
 C08: [["run","check:db"],["run","contracts:check"],["run","build"],["run","typecheck"],["run","lint"],["run","contracts:native"],["run","test:tenant"],["test"]],
 C09: [["run","contracts:check"],["run","build","--workspace","@sigongnote/contracts"],["run","typecheck"],["run","lint"],["run","contracts:native"]],
 C10: [],
 C11: [],
 C12: [],
};
if (!Object.hasOwn(commands, unit)) { console.error("FAIL: unit not implemented"); process.exit(2); }
if (inspectStaged().length) { console.error("FAIL: staged privacy gate"); process.exit(1); }
if (gitRead(["config","--get","core.hooksPath"]).trim() !== ".githooks") throw new Error("Git privacy hooks not installed");
checkExecutionState();
if (!process.env.npm_execpath) throw new Error("Run using npm run check:changed");
for (const args of commands[unit]) {
 const result = spawnSync(process.execPath,[process.env.npm_execpath,...args],{encoding:"utf8",maxBuffer:8*1024*1024});
 if(result.status !== 0) { console.error(`FAIL: ${args.join(" ")}`); console.error(result.error?.message ?? result.stdout + result.stderr); process.exit(result.status ?? 1); }
}
if (unit === "C01") {
 const native = [
  ["uv", ["sync", "--frozen", "--project", "services/document-worker"]],
  ["uv", ["build", "--project", "services/document-worker"]],
  ["dotnet", ["build", "apps/windows", "-p:RestoreLockedMode=true"]],
  process.platform === "win32"
   ? ["pwsh", ["-NoProfile", "-Command", "./apps/android/gradlew.bat -p apps/android help --no-daemon"]]
   : ["sh", ["apps/android/gradlew", "-p", "apps/android", "help", "--no-daemon"]],
 ];
 for (const [command, args] of native) {
  const result = spawnSync(command,args,{encoding:"utf8",maxBuffer:8*1024*1024});
  if (result.status !== 0) { console.error(`FAIL: ${command}`); console.error(result.error?.message ?? result.stdout + result.stderr); process.exit(result.status ?? 1); }
 }
}
if (unit === "C02") {
 const native = [
  ["uv",["run","--frozen","--project","services/document-worker","python","-m","unittest","discover","-s","services/document-worker/tests","-p","test_contracts.py"]],
 ];
 for (const [command,args] of native) {
  const result=spawnSync(command,args,{encoding:"utf8",maxBuffer:8*1024*1024});
  if(result.status!==0) { console.error(`FAIL: ${command}`); console.error(result.error?.message ?? result.stdout+result.stderr); process.exit(result.status??1); }
 }
}
if (["C09","C10","C11","C12"].includes(unit)) {
 const result = spawnSync("pwsh", ["-NoProfile", "-File", "scripts/check-android.ps1"],
  {encoding:"utf8",maxBuffer:8*1024*1024});
 if (result.status !== 0) { console.error("FAIL: Android local verification");
  console.error(result.error?.message ?? result.stdout + result.stderr); process.exit(result.status ?? 1); }
}
if (["C10","C11","C12"].includes(unit)) {
 const result = spawnSync("python", ["scripts/check-android-migration.py"],
  {encoding:"utf8",maxBuffer:8*1024*1024});
 if (result.status !== 0) { console.error("FAIL: Android Room migration");
  console.error(result.error?.message ?? result.stdout + result.stderr); process.exit(result.status ?? 1); }
}
console.log("PASS");
