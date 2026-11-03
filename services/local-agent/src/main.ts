import { LocalBackup } from "./backup.js";
import { FieldBridge, type FieldConfig } from "./field-bridge.js";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { LocalAgent } from "./agent.js";
import { LocalAi } from "./ai.js";
import { DocumentParser } from "./parser.js";
import { loadCopyProtection } from "./protection.js";
import { createLocalServer } from "./server.js";
import {LocalCloudSync} from './cloud-sync.js';

const exec = promisify(execFile);
const repo = process.env.SIGONGNOTE_REPO ?? fileURLToPath(new URL("../../../", import.meta.url));
const requestedData = process.env.SIGONGNOTE_LOCAL_DATA ?? path.join(process.env.LOCALAPPDATA ?? os.homedir(), "Sigongnote", "local-agent");
await mkdir(requestedData, { recursive: true, mode: 0o700 });
const dataDir = await realpath(requestedData);
if (process.platform === "win32") {
  const { stdout: identity } = await exec("whoami.exe", [], { windowsHide: true });
  // Fail closed if the private index/launch credential cannot be restricted to this user.
  await exec("icacls.exe", [dataDir, "/inheritance:r", "/grant:r", `${identity.trim()}:(OI)(CI)F`], { windowsHide: true });
}
try { process.loadEnvFile(path.join(dataDir, ".env")); } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("LOCAL_ENV_INVALID");
}
const lock = path.join(dataDir, "agent.pid");
try {
  const pid = Number(await readFile(lock, "utf8"));
  if (Number.isInteger(pid) && pid > 0) {
    try { process.kill(pid, 0); console.log("ALREADY_RUNNING"); process.exit(0); } catch { /* stale process */ }
  }
  await unlink(lock);
} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
const parser = new DocumentParser(repo);
const protection = await loadCopyProtection(repo, dataDir);
const agent = new LocalAgent(dataDir, parser.parse, protection);
agent.cloud=new LocalCloudSync(agent);
const backup = new LocalBackup(agent, protection);
await agent.protectExistingCopies();
// AI summaries are relayed to the server's Claude runtime with the same account session the journal uses; no key on the PC.
const dailyCalls = Number(process.env.SIGONGNOTE_AI_DAILY_CALLS ?? 10);
if (!Number.isInteger(dailyCalls) || dailyCalls < 0 || dailyCalls > 200) throw new Error("INVALID_AI_DAILY_CALLS");
const ai = new LocalAi(agent, {
  ...(process.env.SIGONGNOTE_AI_MODEL ? { model: process.env.SIGONGNOTE_AI_MODEL } : {}), dailyCalls,
  session: () => agent.cloud?.currentSession() ?? Promise.resolve(null),
});
const port = Number(process.env.SIGONGNOTE_LOCAL_PORT ?? 5174);
const pairToken = randomBytes(32).toString("hex");
const pickFolder = async () => {
  if (process.platform !== "win32") throw new Error("FOLDER_PICKER_UNAVAILABLE");
  const helper=process.env.SIGONGNOTE_WINDOWS_HELPER;
  const { stdout } = await exec(helper??process.env.SIGONGNOTE_POWERSHELL ?? "pwsh.exe", helper?['--select-local-folder']:["-NoProfile", "-STA", "-File", path.join(repo, "scripts/select-local-folder.ps1")], { windowsHide: true, timeout: 120_000, maxBuffer: 8192 });
  return stdout.trim() || null;
};
let field: FieldBridge | undefined;
try { field = new FieldBridge(agent, JSON.parse(await readFile(path.join(dataDir, "field.json"), "utf8")) as FieldConfig); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("FIELD_CONFIG_INVALID"); }
const app = createLocalServer(agent, ai, { port, pairToken, pickFolder, backup, webDir: process.env.SIGONGNOTE_WEB_DIR ?? path.join(repo, "apps/web/dist"), ...(field ? {field} : {}) });
await app.listen({ port, host: "127.0.0.1" });
const launchUrl = `http://127.0.0.1:${port}/?work=local#pair=${pairToken}`;
await writeFile(path.join(dataDir, "launch.json"), JSON.stringify({ url: launchUrl, port, pid: process.pid }), { mode: 0o600 });
const grantIndex = process.argv.indexOf("--grant-authorized-folder");
if (grantIndex >= 0) {
  const root = process.argv[grantIndex + 1];
  if (!root) throw new Error("FOLDER_REQUIRED");
  await agent.grant(root, "explicit_user_request");
}
// Local reception starts without an account or a source-folder wizard. Existing files
// enter the metadata baseline; only later arrivals are automatically read.
let discoveryRoots = process.env.SIGONGNOTE_LOCAL_DISABLE_AUTODISCOVERY==='1'?[]:process.env.SIGONGNOTE_DISCOVERY_ROOTS?.split(path.delimiter).filter(Boolean);
if (!discoveryRoots) {
  discoveryRoots = [path.join(os.homedir(),'Documents'),path.join(os.homedir(),'Desktop'),path.join(os.homedir(),'Downloads')];
  if(process.platform==='win32') {
    try {
      const {stdout}=await exec(process.env.SIGONGNOTE_POWERSHELL??'powershell.exe',['-NoProfile','-Command',"[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetFolderPath('MyDocuments'); [Environment]::GetFolderPath('Desktop')"],{windowsHide:true,timeout:10000});
      discoveryRoots.unshift(...stdout.trim().split(/\r?\n/).filter(Boolean));
    } catch { /* Conventional local locations still work. */ }
  }
}
if(process.env.SIGONGNOTE_LOCAL_DISABLE_AUTODISCOVERY!=='1')discoveryRoots.push(...(process.env.SIGONGNOTE_EXTRA_DISCOVERY_ROOTS?.split(path.delimiter).filter(Boolean)??[]));
for(const root of [...new Set(discoveryRoots)]) {
  if(agent.sources().some(s=>path.resolve(s.root).toLocaleLowerCase()===path.resolve(root).toLocaleLowerCase()))continue;
  try {await agent.grant(root,'automatic_discovery');} catch { /* Missing, overlapping or unavailable folders do not block reception elsewhere. */ }
}
if (process.argv.includes("--open") && process.platform === "win32") {
  spawn("powershell.exe", ["-NoProfile", "-Command", "Start-Process $env:SIGONGNOTE_OPEN_URL"], {
    windowsHide: true, stdio: "ignore", env: { ...process.env, SIGONGNOTE_OPEN_URL: launchUrl },
  }).unref();
}
let dirty = true;
let lastInventory = 0;
let lastFlush = 0;
let lastCloudSync=0;
const watchers = new Map<string, FSWatcher>();
const tick = () => {
  if(Date.now()-lastCloudSync>=15000){lastCloudSync=Date.now();void agent.cloud?.sync();}
  const active = agent.sources().filter(source => source.enabled);
  for (const [id, watcher] of watchers) if (!active.some(source => source.id === id)) { watcher.close(); watchers.delete(id); }
  for (const source of active) if (!watchers.has(source.id)) {
    try {
      const watcher = watch(source.root, { recursive: true }, (_event, name) => { if (!name || !agent.siteFolders.isManagedPath(source.id, String(name))) {dirty = true;if(name)agent.noteArrival(source.id,String(name));} });
      watcher.on("error", () => { dirty = true; watcher.close(); watchers.delete(source.id); });
      watchers.set(source.id, watcher);
    } catch { /* USB missing or watcher unsupported: timed inventory remains authoritative. */ }
  }
  if (agent.progress.phase !== "idle") return;
  const inventory = dirty || Date.now() - lastInventory > 15 * 60_000;
  if (inventory) { lastInventory = Date.now(); dirty = false; }
  if (field && Date.now() - lastFlush >= 60_000) { lastFlush = Date.now(); void field.flush().catch(() => {}); }
  void agent.start(inventory).catch(() => { dirty = true; });
};
tick();
const timer = setInterval(tick, 3_000);
const shutdown = async () => {
  clearInterval(timer);
  clearInterval(stopTimer);
  for (const watcher of watchers.values()) watcher.close();
  await agent.stop(); await agent.cloud?.stop(); parser.close(); await app.close(); agent.close();
  await unlink(lock).catch(() => {});
  process.exit(0);
};
// A private local stop marker allows a normal shutdown on Windows without killing node processes.
const stopTimer = setInterval(() => { void readFile(path.join(dataDir, "stop-request"), "utf8").then(async value => {
  if (value.trim() === String(process.pid)) { clearInterval(stopTimer); await unlink(path.join(dataDir,"stop-request")); await shutdown(); }
}).catch(() => {}); }, 1000);
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
console.log(`LOCAL_AGENT_READY http://127.0.0.1:${port}/`);
