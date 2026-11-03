import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
const allowed = JSON.parse(readFileSync(new URL("../.githooks/allowed-assets.json", import.meta.url),"utf8"));
export function gitRead(args, cwd = process.cwd(), binary = false) {
 const result = spawnSync("git",args,{cwd,encoding:binary ? null : "utf8",maxBuffer:32*1024*1024});
 if(result.status !== 0) throw new Error("Cannot inspect Git content");
 return result.stdout;
}
export function inspectContent(path, bytes) {
 const hash = createHash("sha256").update(bytes).digest("hex");
 if(allowed[path] === hash) return [];
 if (/(^|\/)\.env(?:\..*)?$/.test(path) && !path.endsWith("/.env.example") && path !== ".env.example") return [{path,rule:"environment-file"}];
 if(bytes.subarray(0,8000).includes(0) || /\.(hwp|hwpx|xls|xlsx|pdf|zip|csv|tsv|docx?|png|jpe?g|heic|webp|gif|m4a|mp3|wav|amr|3gp|mp4|pfx|p12|jks|keystore)$/i.test(path)) return [{path,rule:"unapproved-source-or-binary"}];
 const body = bytes.toString("utf8");
 const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}/,
  /\bsb_secret_[A-Za-z0-9_-]{16,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /(?:postgres(?:ql)?|https?):\/\/[^\s/:]+:[^\s/@]+@/i,
  /^[ \t]*(?:SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE|AI_API_KEY|DATABASE_URL|WORKER_DATABASE_URL|MIGRATION_DATABASE_URL|DOCUMENT_WORKER_TOKEN)[ \t]*=[ \t]*["']?[^\s#"']/m,
  /[A-Z]:[\\/]Users[\\/][^\s"']+/i,
 ];
 return patterns.some(pattern => pattern.test(body)) ? [{path,rule:"sensitive-content"}] : [];
}
export function inspectStaged(cwd = process.cwd()) {
 const paths = gitRead(["diff","--cached","--name-only","--diff-filter=ACMR","-z"],cwd).split("\0").filter(Boolean);
 return paths.flatMap(path => inspectContent(path,gitRead(["show",`:${path}`],cwd,true)));
}
if(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 const findings=inspectStaged();
 if(findings.length) { console.error(`FAIL: staged privacy gate (${findings.length} files)`); process.exitCode=1; }
 else console.log("PASS");
}
