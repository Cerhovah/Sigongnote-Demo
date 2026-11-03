import { readFileSync } from "node:fs";
import { gitRead, inspectContent } from "./check-staged.mjs";
const zero = /^0+$/;
const target = process.argv[2];
const knownRemote = /^[A-Za-z0-9._-]+$/.test(target || "") &&
  gitRead(["remote"]).trim().split("\n").includes(target);
for(const line of readFileSync(0,"utf8").trim().split("\n").filter(Boolean)) {
 const [,local,,remote] = line.trim().split(/\s+/);
 if(!local || !remote || !/^[0-9a-f]{40,64}$/.test(local) || !/^[0-9a-f]{40,64}$/.test(remote)) throw new Error("Invalid push refs");
 if(zero.test(local)) continue;
 // A new branch contains commits already present on another ref of the
 // destination remote. Unknown or URL-only remotes fall back to full history.
 // Inspect only objects actually newly introduced to the remote; stale
 // Fresh tracking refs make this set precise; stale refs require a fetch.
 const args = zero.test(remote) && knownRemote
  ? ["rev-list",local,"--not",`--remotes=${target}`]
  : zero.test(remote) ? ["rev-list",local] : ["rev-list",`${remote}..${local}`];
 const commits = gitRead(args).trim().split("\n").filter(Boolean);
 for(const commit of commits) {
  const paths = gitRead(["ls-tree","-r","--name-only","-z",commit]).split("\0").filter(Boolean);
  for(const path of paths) {
   if(inspectContent(path,gitRead(["show",`${commit}:${path}`],undefined,true)).length) {
    console.error("FAIL: outgoing commit privacy gate"); process.exit(1);
   }
  }
 }
}
console.log("PASS");
