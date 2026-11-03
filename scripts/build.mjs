import { spawnSync } from "node:child_process";
if (!process.env.npm_execpath) throw new Error("Run through npm");
for (const workspace of ["contracts","domain","ui","api","web"]) {
 const args=[process.env.npm_execpath,"run","build","--workspace",`@sigongnote/${workspace}`];
 if(["domain","ui"].includes(workspace)) args.push("--if-present");
 const result=spawnSync(process.execPath,args,{encoding:"utf8",maxBuffer:8*1024*1024});
 if(result.status!==0) { console.error(result.error?.message??result.stdout+result.stderr); process.exit(result.status??1); }
}
const release=spawnSync(process.execPath,['scripts/write-release.mjs'],{encoding:'utf8'});
if(release.status!==0){console.error('Release identity generation failed');process.exit(1);}
console.log("PASS");
