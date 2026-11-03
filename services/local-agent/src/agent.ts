import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, stat, statfs, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Parser } from "./parser.js";
import { LocalInventory } from "./inventory.js";
import { ManagedSiteFolders } from "./site-folders.js";
import type { CopyProtection } from "./protection.js";
import { LocalJournal } from './journal.js';
import type {LocalCloudSync} from './cloud-sync.js';

const extensions = new Set([".hwp", ".hwpx", ".xls", ".xlsx", ".pdf", ".txt", ".csv", ".jpg", ".jpeg", ".png", ".webp", ".heic", ".dwg", ".mp3", ".m4a", ".wav"]);
const readableExtensions = new Set([".hwp", ".hwpx", ".xls", ".xlsx", ".pdf", ".txt", ".csv", ".jpg", ".jpeg", ".png", ".webp"]);
const currentStatuses = new Set(["complete", "partial", "encrypted", "unsupported"]);
const maxBytes = 50 * 1024 * 1024;
export interface Source { id: string; root: string; enabled: number; generation: number; last_scan: string | null; problem: string | null; skipped: number; root_dev: string | null; root_ino: string | null; intake_mode?:string }
export interface LocalDocument {
  id: string; source_id: string; relative_path: string; relative_dir: string; name: string; ext: string;
  size: number; mtime: number; hash: string | null; revision: number; status: string;
  excerpt: string; parsed: string; site: string | null; category: string; available: number;
}
const now = () => new Date().toISOString();
export const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
export function categoryFor(name: string): string {
  if (/견적|산출|내역/.test(name)) return "견적";
  if (/발주|주문/.test(name)) return "주문";
  if (/납품|인수|출고/.test(name)) return "납품";
  if (/정산|계산서|거래|매출|매입|장부/.test(name)) return "돈";
  if (/\.(jpg|jpeg|png|webp|heic)$/i.test(name)) return "사진";
  return "기타 자료";
}
export function safeLabel(label: string): string {
  const value = label.trim();
  if (!value || value.length > 80 || /[<>:"/\\|?*]/.test(value) || [...value].some(c => c.charCodeAt(0) < 32) || /[. ]$/.test(value)
    || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value) || value === "." || value === "..") throw new Error("INVALID_LABEL");
  return value;
}
function outputSite(site: string | null) { return safeLabel([...safeLabel(site ?? "현장 확인 전")].slice(0, 40).join("").trim()); }

async function atomicPrivateFile(destination: string, bytes: Buffer, hash: string) {
  const disk = await statfs(path.dirname(destination));
  if (disk.bavail * disk.bsize < bytes.length + 256 * 1024 * 1024) throw new Error("STORAGE_FULL");
  try {
    if ((await lstat(destination)).isSymbolicLink()) throw new Error("LINK_NOT_ALLOWED");
    if (sha256(await readFile(destination)) === hash) return;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    if (sha256(await readFile(temporary)) !== hash) throw new Error("COPY_CORRUPT");
    await rename(temporary, destination);
  } finally { await unlink(temporary).catch(() => {}); }
}

/** Per-Windows-user local evidence index, not the financial ledger or a cloud tenant. */
export class LocalAgent {
  cloud?:LocalCloudSync;
  readonly db: DatabaseSync;
  readonly siteFolders: ManagedSiteFolders;
  readonly journal: LocalJournal;
  private running: Promise<void> | undefined;
  private readonly inventoryQueue: LocalInventory;
  private stopping = false;
  progress = { phase: "idle", inventoried: 0, processed: 0 };
  constructor(readonly dataDir: string, private readonly parse: Parser, private readonly protection: CopyProtection) {
    this.db = new DatabaseSync(path.join(dataDir, "index.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,root TEXT UNIQUE NOT NULL,enabled INTEGER NOT NULL,
        generation INTEGER NOT NULL DEFAULT 1,last_scan TEXT,problem TEXT,skipped INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES sources(id),
        relative_path TEXT NOT NULL,name TEXT NOT NULL,ext TEXT NOT NULL,size INTEGER NOT NULL,mtime REAL NOT NULL,
        hash TEXT,revision INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending',excerpt TEXT NOT NULL DEFAULT '',
        parsed TEXT NOT NULL DEFAULT '{}',site TEXT,category TEXT NOT NULL,available INTEGER NOT NULL DEFAULT 1,
        UNIQUE(source_id,relative_path));
      CREATE TABLE IF NOT EXISTS revisions(document_id TEXT NOT NULL REFERENCES documents(id),revision INTEGER NOT NULL,
        hash TEXT NOT NULL,parsed TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(document_id,revision));
      CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,kind TEXT NOT NULL,subject TEXT NOT NULL,detail TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY,items TEXT NOT NULL,created_at TEXT NOT NULL,completed_at TEXT);
      CREATE TABLE IF NOT EXISTS ai_requests(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,revision INTEGER NOT NULL,
        hash TEXT NOT NULL,source_generation INTEGER NOT NULL,model TEXT NOT NULL,payload TEXT NOT NULL,
        created_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'prepared',result TEXT);
      CREATE TABLE IF NOT EXISTS folder_answers(source_id TEXT NOT NULL REFERENCES sources(id),relative_dir TEXT NOT NULL,
        answer TEXT NOT NULL,site TEXT,created_at TEXT NOT NULL,PRIMARY KEY(source_id,relative_dir));
      CREATE TABLE IF NOT EXISTS local_blobs(name TEXT PRIMARY KEY,bytes INTEGER NOT NULL);`);
    const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (version < 2) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec("ALTER TABLE sources ADD COLUMN root_dev TEXT; ALTER TABLE sources ADD COLUMN root_ino TEXT; ALTER TABLE documents ADD COLUMN relative_dir TEXT NOT NULL DEFAULT '';");
        for (const row of this.db.prepare("SELECT id,relative_path FROM documents").all())
          this.db.prepare("UPDATE documents SET relative_dir=? WHERE id=?").run(path.dirname(String(row.relative_path)), String(row.id));
        // Old path-only grants are not silently extended to an unverified USB volume.
        this.db.exec("UPDATE sources SET enabled=0,generation=generation+1,problem='RECONFIRM_REQUIRED'; PRAGMA user_version=2; COMMIT;");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
    this.inventoryQueue = new LocalInventory(this.db);
    this.siteFolders = new ManagedSiteFolders(this);
    this.journal = new LocalJournal(this);
    if(!this.db.prepare('PRAGMA table_info(sources)').all().some(r=>r.name==='intake_mode'))this.db.exec("ALTER TABLE sources ADD COLUMN intake_mode TEXT NOT NULL DEFAULT 'organize'");
    this.db.exec('CREATE TABLE IF NOT EXISTS local_arrivals(source_id TEXT NOT NULL,relative_path TEXT NOT NULL,received_at TEXT NOT NULL,PRIMARY KEY(source_id,relative_path))');
    this.db.prepare("UPDATE documents SET status='pending' WHERE status='reading'").run();
    // A crashed paid request is never silently replayed.
    this.db.prepare("UPDATE ai_requests SET status='unknown' WHERE status='sending'").run();
  }
  audit(kind: string, subject: string, detail: unknown = {}) {
    this.db.prepare("INSERT INTO audit VALUES(?,?,?,?,?)").run(randomUUID(), kind, subject, JSON.stringify(detail), now());
  }
  async preserveAiResponse(id: string, body: unknown) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("INVALID_ID");
    const folder=path.join(this.dataDir,"ai-responses");await mkdir(folder,{recursive:true});
    await writeFile(path.join(folder,`${id}.encrypted`),this.protection.encrypt(Buffer.from(JSON.stringify(body))),{flag:"wx",mode:0o600});
  }
  async protectExistingCopies() {
    const folder = path.join(this.dataDir, "original-copies");
    await mkdir(folder, { recursive: true });
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.[a-z0-9]+(?:\.json)?$/.test(entry.name)) continue;
      const target = path.join(folder, entry.name);
      const bytes = await readFile(target);
      if (!this.protection.sealed(bytes)) {
        const sealed = this.protection.encrypt(bytes);
        await atomicPrivateFile(target, sealed, sha256(sealed));
      } else this.protection.decrypt(bytes); // Key loss/tampering fails startup, never replaces the key.
      this.db.prepare("INSERT OR REPLACE INTO local_blobs VALUES(?,?)").run(entry.name, (await stat(target)).size);
    }
    // Interrupted parser files are private derived temporaries, not source files.
    const work = path.join(this.dataDir, "parser-work");
    await mkdir(work, { recursive: true });
    for (const entry of await readdir(work, { withFileTypes: true })) {
      if (entry.isFile() && /^[a-f0-9-]{36}\.[a-z0-9]+(?:\.json)?$/.test(entry.name)) await unlink(path.join(work, entry.name));
    }
  }
  private async protectedCopy(file: string, bytes: Buffer, originalHash: string) {
    try {
      if ((await lstat(file)).isSymbolicLink()) throw new Error("LINK_NOT_ALLOWED");
      const existing = this.protection.decrypt(await readFile(file));
      if (sha256(existing) === originalHash) return;
    } catch (error) { if (error instanceof Error && error.message === "LINK_NOT_ALLOWED") throw error; }
    const sealed = this.protection.encrypt(bytes);
    const stored = Number(this.db.prepare("SELECT coalesce(sum(bytes),0) AS n FROM local_blobs").get()?.n ?? 0);
    const previous = Number(this.db.prepare("SELECT bytes FROM local_blobs WHERE name=?").get(path.basename(file))?.bytes ?? 0);
    if (stored - previous + sealed.length > 2 * 1024 ** 3) throw new Error("CACHE_LIMIT");
    await atomicPrivateFile(file, sealed, sha256(sealed));
    this.db.prepare("INSERT OR REPLACE INTO local_blobs VALUES(?,?)").run(path.basename(file), sealed.length);
  }
  sources(): Source[] { return this.db.prepare("SELECT * FROM sources ORDER BY rowid").all() as unknown as Source[]; }
  source(id: string): Source {
    const source = this.sources().find(x => x.id === id);
    if (!source) throw new Error("SOURCE_NOT_FOUND");
    return source;
  }
  noteArrival(sourceId:string,relative:string) {
    const source=this.source(sourceId),normalized=path.normalize(relative);
    if(path.isAbsolute(relative)||!inside(source.root,path.resolve(source.root,normalized))||this.siteFolders.isManagedPath(sourceId,normalized))return;
    this.db.prepare('INSERT INTO local_arrivals VALUES(?,?,?) ON CONFLICT(source_id,relative_path) DO UPDATE SET received_at=excluded.received_at').run(sourceId,normalized,now());
  }
  async grant(root: string, consent: "native_picker" | "explicit_user_request" | "automatic_discovery"): Promise<Source> {
    const resolved = await realpath(root);
    const identity = await stat(resolved, { bigint: true });
    if (!identity.isDirectory() || inside(resolved, this.dataDir) || inside(this.dataDir, resolved)
      || resolved === path.parse(resolved).root) throw new Error("INVALID_ROOT");
    const existing = this.sources().find(x => x.root.toLocaleLowerCase() === resolved.toLocaleLowerCase());
    if (existing) {
      if (existing.root_dev !== null && (existing.root_dev !== String(identity.dev) || existing.root_ino !== String(identity.ino))) throw new Error("DIFFERENT_DRIVE");
      this.db.prepare("UPDATE sources SET root_dev=?,root_ino=?,enabled=1,generation=generation+1,problem=NULL WHERE id=?")
        .run(String(identity.dev), String(identity.ino), existing.id);
      this.audit("folder_consent", existing.id, { consent, scope: "recursive_read_private_snapshot", policy: 2 });
      return this.source(existing.id);
    }
    if (this.sources().some(x => x.enabled && (inside(x.root, resolved) || inside(resolved, x.root)))) throw new Error("OVERLAPPING_ROOT");
    const id = randomUUID();
    this.db.prepare("INSERT INTO sources(id,root,enabled,root_dev,root_ino,intake_mode) VALUES(?,?,1,?,?,?)").run(id, resolved, String(identity.dev), String(identity.ino),consent==='automatic_discovery'?'new_only':'organize');
    this.audit("folder_consent", id, { consent, scope: "recursive_read_private_snapshot", policy: 1 });
    return this.source(id);
  }
  setEnabled(id: string, enabled: boolean) {
    this.source(id);
    this.db.prepare("UPDATE sources SET enabled=?,generation=generation+1 WHERE id=?").run(enabled ? 1 : 0, id);
    this.audit(enabled ? "folder_resumed" : "folder_revoked", id);
  }
  private permitted(source: Source) {
    const current = this.source(source.id);
    if (!current.enabled || current.generation !== source.generation) throw new Error("SCOPE_REVOKED");
  }
  private async identityMatches(source: Source) {
    const identity = await stat(source.root, { bigint: true });
    if (source.root_dev !== String(identity.dev) || source.root_ino !== String(identity.ino)) throw new Error("DIFFERENT_DRIVE");
  }
  private assertCurrent(doc: LocalDocument) {
    if (!doc.hash || !currentStatuses.has(doc.status)) throw new Error("NOT_READ_YET");
  }
  async sourcePath(document: LocalDocument): Promise<string> {
    const source = this.source(document.source_id);
    this.permitted(source);
    await this.identityMatches(source);
    const target = path.resolve(source.root, document.relative_path);
    if (!inside(source.root, target)) throw new Error("OUTSIDE_SCOPE");
    // Reject every symlink/junction in the route, including a replaced USB root.
    for (let cursor = target; ; cursor = path.dirname(cursor)) {
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error("LINK_NOT_ALLOWED");
      if (cursor === path.parse(cursor).root) break;
    }
    if (!inside(source.root, await realpath(target))) throw new Error("OUTSIDE_SCOPE");
    return target;
  }
  document(id: string): LocalDocument {
    const document = this.db.prepare("SELECT * FROM documents WHERE id=?").get(id) as unknown as LocalDocument | undefined;
    if (!document) throw new Error("DOCUMENT_NOT_FOUND");
    return document;
  }
  search(query = "", limit = 50, offset = 0) {
    const escaped = query.replace(/[\\%_]/g, "\\$&");
    const where = "d.source_id=s.id AND s.enabled=1 AND (d.name LIKE ? ESCAPE '\\' OR d.excerpt LIKE ? ESCAPE '\\' OR d.site LIKE ? ESCAPE '\\')";
    const args = [`%${escaped}%`, `%${escaped}%`, `%${escaped}%`];
    const visible=(this.db.prepare(`SELECT d.* FROM documents d,sources s WHERE ${where} ORDER BY (d.hash IS NOT NULL) DESC,d.name`).all(...args) as unknown as LocalDocument[]).filter(row=>(this.cloud?.visible(row.id)??true)&&!this.cloud?.nativeRecording(row));
    return {
      total: visible.length,
      documents: visible.slice(offset,offset+limit).map(row => {
          const doc = row as unknown as LocalDocument;
          return { ...doc, parsed: undefined, excerpt: doc.excerpt.slice(0, 220) };
        }),
    };
  }
  summary() {
    return { sources: this.sources().map(source => ({ ...source, managed: this.siteFolders.get(source.id) ?? null })), progress: this.progress,
      folderQuestion: this.db.prepare(`SELECT d.source_id,d.relative_dir,count(*) AS count FROM documents d
        JOIN sources s ON d.source_id=s.id LEFT JOIN folder_answers a ON a.source_id=d.source_id AND a.relative_dir=d.relative_dir
        WHERE s.enabled=1 AND d.available=1 AND d.site IS NULL AND d.status IN ('complete','partial')
        AND (a.answer IS NULL OR (a.answer='later' AND julianday(a.created_at)<=julianday('now','-1 day')))
        AND (d.relative_dir LIKE '%현장%' OR d.relative_dir LIKE '%아파트%' OR d.relative_dir LIKE '%공사%' OR d.relative_dir LIKE '%빌라%')
        GROUP BY d.source_id,d.relative_dir HAVING count(*)>=2 ORDER BY count(*) DESC LIMIT 1`).get() ?? null,
      counts: this.db.prepare("SELECT status,count(*) AS count FROM documents d JOIN sources s ON d.source_id=s.id WHERE s.enabled=1 GROUP BY status").all(),
      total: Number(this.db.prepare("SELECT count(*) AS n FROM documents d JOIN sources s ON d.source_id=s.id WHERE s.enabled=1").get()?.n ?? 0),
      duplicates: Number(this.db.prepare("SELECT count(*) AS n FROM (SELECT hash FROM documents d JOIN sources s ON d.source_id=s.id WHERE s.enabled=1 AND hash IS NOT NULL GROUP BY hash HAVING count(*)>1)").get()?.n ?? 0),
      sites: this.db.prepare("SELECT site,count(*) AS count FROM documents d JOIN sources s ON d.source_id=s.id WHERE s.enabled=1 AND site IS NOT NULL GROUP BY site ORDER BY site").all(),
      copyCount: Number(this.db.prepare("SELECT count(*) AS n FROM plans WHERE completed_at IS NOT NULL").get()?.n ?? 0) };
  }
  async inventory(source: Source) {
    this.permitted(source);
    try {
      await this.identityMatches(source);
      if ((await realpath(source.root)) !== source.root || (await lstat(source.root)).isSymbolicLink()) throw new Error("ROOT_CHANGED");
      const result = await this.inventoryQueue.batch(source, () => {
        this.permitted(source); if (this.stopping) throw new Error("STOPPED");
      }, async (relative, name) => {
        const ext = path.extname(name).toLowerCase();
        if (!extensions.has(ext)) return false;
        const file = await stat(path.join(source.root, relative));
        const current = this.db.prepare("SELECT * FROM documents WHERE source_id=? AND relative_path=?").get(source.id, relative) as unknown as LocalDocument | undefined;
        const arrival=this.db.prepare('SELECT received_at FROM local_arrivals WHERE source_id=? AND relative_path=?').get(source.id,relative);
        const baseline = source.last_scan === null && source.intake_mode==='new_only' && !arrival;
        const initialStatus = !readableExtensions.has(ext) ? "unsupported" : file.size > maxBytes ? "too_large" : baseline ? 'indexed' : "pending";
        if (!current) {
          const id=randomUUID();
          this.db.prepare("INSERT INTO documents(id,source_id,relative_path,relative_dir,name,ext,size,mtime,status,category,received_at,baseline) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
            .run(id, source.id, relative, path.dirname(relative), name, ext, file.size, file.mtimeMs, initialStatus, categoryFor(name),arrival?String(arrival.received_at):now(),baseline?1:0);
          this.cloud?.bind(id);
          this.journal.classify(id);
        } else if (current.size !== file.size || current.mtime !== file.mtimeMs) {
          this.db.prepare("UPDATE documents SET size=?,mtime=?,status=?,available=1,excerpt='',parsed='{}',baseline=0,received_at=?,duplicate_of=NULL WHERE id=?")
            .run(file.size, file.mtimeMs, !readableExtensions.has(ext)?'unsupported':file.size>maxBytes?'too_large':'pending', now(),current.id);
          this.journal.classify(current.id);
        } else if (!current.available) this.db.prepare("UPDATE documents SET available=1 WHERE id=?").run(current.id);
        else if (!readableExtensions.has(ext) && current.status === "pending") this.db.prepare("UPDATE documents SET status='unsupported' WHERE id=?").run(current.id);
        this.progress.inventoried++;
        this.db.prepare('DELETE FROM local_arrivals WHERE source_id=? AND relative_path=?').run(source.id,relative);
        return true;
      });
      this.db.prepare("UPDATE sources SET last_scan=CASE WHEN ? THEN last_scan ELSE ? END,problem=?,skipped=? WHERE id=?")
        .run(result.pending ? 1 : 0, now(), result.gap ? "SCAN_GAP" : result.pending ? "BACKLOG_PENDING" : null, result.skipped, source.id);
    } catch (error) {
      const code = error instanceof Error && ["SCOPE_REVOKED", "STOPPED", "ROOT_CHANGED", "DIFFERENT_DRIVE"].includes(error.message) ? error.message : "FOLDER_UNAVAILABLE";
      this.db.prepare("UPDATE sources SET problem=? WHERE id=?").run(code, source.id);
    }
  }
  async capture(id: string): Promise<void> {
    const doc = this.document(id);
    const source = this.source(doc.source_id);
    this.permitted(source);
    if (doc.size > maxBytes || !readableExtensions.has(doc.ext)) return;
    let temp: string | undefined;
    let parsingCopy: string | undefined;
    try {
      const disk = await statfs(this.dataDir);
      if (disk.bavail * disk.bsize < maxBytes + 256 * 1024 * 1024) throw new Error("STORAGE_FULL");
      const used = Number(this.db.prepare("SELECT coalesce(sum(bytes),0) n FROM local_blobs").get()?.n ?? 0);
      if (used + doc.size + 128 > 2 * 1024 ** 3) throw new Error("CACHE_LIMIT");
      const sourceFile = await this.sourcePath(doc);
      const before = await stat(sourceFile);
      if (before.size > maxBytes || before.size !== doc.size || before.mtimeMs !== doc.mtime) throw new Error("SOURCE_CHANGED");
      this.db.prepare("UPDATE documents SET status='reading' WHERE id=?").run(id);
      const handle = await open(sourceFile, constants.O_RDONLY);
      let bytes: Buffer;
      try {
        const buffer = Buffer.alloc(before.size + 1);
        let count = 0;
        while (count < buffer.length) {
          const read = await handle.read(buffer, count, buffer.length - count, count);
          if (!read.bytesRead) break;
          count += read.bytesRead;
        }
        if (count !== before.size) throw new Error("SOURCE_CHANGED");
        bytes = buffer.subarray(0, count);
      } finally { await handle.close(); }
      const after = await stat(await this.sourcePath(doc));
      if (bytes.length > maxBytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("SOURCE_CHANGED");
      this.permitted(source);
      const hash = sha256(bytes);
      const copy = this.copyPath(hash, doc.ext);
      await mkdir(path.dirname(copy), { recursive: true });
      const stored = this.db.prepare("SELECT coalesce(sum(bytes),0) AS bytes,sum(CASE WHEN name NOT LIKE '%.json' THEN 1 ELSE 0 END) AS count FROM local_blobs").get();
      if ((Number(stored?.bytes) + bytes.length > 2 * 1024 ** 3)
        && !this.db.prepare("SELECT name FROM local_blobs WHERE name=?").get(path.basename(copy))) throw new Error("CACHE_LIMIT");
      await this.protectedCopy(copy, bytes, hash);
      const work = path.join(this.dataDir, "parser-work");
      await mkdir(work, { recursive: true });
      parsingCopy = path.join(work, `${randomUUID()}${doc.ext}`);
      await writeFile(parsingCopy, bytes, { flag: "wx", mode: 0o600 });
      temp = `${parsingCopy}.json`;
      const parsed = await this.parse(parsingCopy, temp);
      this.permitted(source);
      if (parsed.sourceHash && parsed.sourceHash !== hash) throw new Error("HASH_MISMATCH");
      const revision = doc.hash === hash ? doc.revision : doc.revision + 1;
      const serialized = JSON.stringify(parsed);
      // Retain previous versions and correction history, never count a file as money.
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("INSERT OR REPLACE INTO revisions VALUES(?,?,?,?,?)").run(id, revision, hash, serialized, now());
        const rule = this.db.prepare("SELECT site FROM folder_answers WHERE source_id=? AND relative_dir=? AND answer='site'").get(doc.source_id, doc.relative_dir);
        const origin = this.db.prepare("SELECT kind FROM document_site_origins WHERE document_id=?").get(id)?.kind;
        const site = doc.hash === hash || origin === "manual" ? doc.site : rule?.site ?? this.siteFolders.get(doc.source_id)?.site ?? null;
        if (origin !== "manual" && site !== null) this.db.prepare("INSERT OR REPLACE INTO document_site_origins VALUES(?,?)").run(id, rule?.site ? "folder_rule" : "folder_default");
        this.db.prepare("UPDATE documents SET hash=?,revision=?,status=?,parsed=?,excerpt=?,site=? WHERE id=?")
          .run(hash, revision, parsed.status, serialized, parsed.spans.map(s => s.text).join("\n"), site, id);
        this.audit("document_read", id, { hash, revision, status: parsed.status });
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      this.journal.classify(id);
      try { const full = await readFile(temp); await this.protectedCopy(`${copy}.json`, full, sha256(full)); }
      catch { /* Search evidence remains durable in the private SQLite index. */ }
    } catch (error) {
      const code = error instanceof Error && ["SOURCE_CHANGED", "SCOPE_REVOKED", "COPY_CORRUPT", "HASH_MISMATCH", "LINK_NOT_ALLOWED", "OUTSIDE_SCOPE", "STORAGE_FULL", "CACHE_LIMIT"].includes(error.message) ? error.message : "READ_FAILED";
      this.db.prepare("UPDATE documents SET status=?,excerpt='',parsed=? WHERE id=?").run(["CACHE_LIMIT", "STORAGE_FULL"].includes(code) ? "storage_wait" : "failed", JSON.stringify({ issues: [code], spans: [] }), id);
      if (code === "STORAGE_FULL") { this.stopping = true; this.db.prepare("UPDATE sources SET problem='DISK_LOW' WHERE id=?").run(source.id); }
      if (code === "CACHE_LIMIT") { this.db.prepare("UPDATE sources SET problem='CACHE_LIMIT' WHERE id=?").run(source.id); }
    } finally {
      if (temp) await unlink(temp).catch(() => {});
      if (parsingCopy) await unlink(parsingCopy).catch(() => {});
      this.progress.processed++;
    }
  }
  copyPath(hash: string, ext: string) {
    if (!/^[a-f0-9]{64}$/.test(hash) || !extensions.has(ext)) throw new Error("INVALID_COPY");
    return path.join(this.dataDir, "original-copies", `${hash}${ext}`);
  }
  async snapshot(id: string) {
    this.cloud?.assertVisible(id);
    const doc = this.document(id);
    this.permitted(this.source(doc.source_id));
    this.assertCurrent(doc);
    const file = this.copyPath(doc.hash as string, doc.ext);
    const bytes = this.protection.decrypt(await readFile(file));
    if (sha256(bytes) !== doc.hash) throw new Error("COPY_CORRUPT");
    return { doc, bytes };
  }
  private async resumeStorageWait() {
    const waiting = this.db.prepare("SELECT d.id,d.size,d.source_id FROM documents d JOIN sources s ON s.id=d.source_id WHERE d.status='storage_wait' AND s.enabled=1").all();
    if (!waiting.length) return;
    const disk = await statfs(this.dataDir);
    const used = Number(this.db.prepare("SELECT coalesce(sum(bytes),0) n FROM local_blobs").get()?.n ?? 0);
    if (disk.bavail * disk.bsize < maxBytes + 256 * 1024 * 1024) return;
    for (const row of waiting) if (used + Number(row.size) + 128 <= 2 * 1024 ** 3) {
      this.db.prepare("UPDATE documents SET status='pending' WHERE id=? AND status='storage_wait'").run(String(row.id));
      this.db.prepare("UPDATE sources SET problem=NULL WHERE id=? AND problem IN ('CACHE_LIMIT','DISK_LOW')").run(String(row.source_id));
    }
  }
  start(scan = true): Promise<void> {
    if (this.running) return this.running;
    this.stopping = false;
    this.running = (async () => {
      this.progress = { phase: "inventory", inventoried: 0, processed: 0 };
      await this.resumeStorageWait();
      for (const source of this.sources().filter(s => s.enabled))
        if (scan || this.inventoryQueue.pending(source.id)) await this.inventory(source);
      this.progress.phase = "reading";
      const deadline = Date.now() + 30_000;
      while (!this.stopping && this.progress.processed < 100 && Date.now() < deadline) {
        const next = this.db.prepare("SELECT d.id FROM documents d JOIN sources s ON d.source_id=s.id WHERE s.enabled=1 AND (s.problem IS NULL OR s.problem IN ('BACKLOG_PENDING','SCAN_GAP','CACHE_LIMIT')) AND d.available=1 AND d.status='pending' ORDER BY CASE WHEN d.ext IN ('.hwp','.hwpx','.xls','.xlsx') THEN 0 WHEN d.ext='.pdf' THEN 1 WHEN d.ext IN ('.txt','.csv') THEN 2 ELSE 3 END,d.mtime DESC,d.rowid LIMIT 1").get();
        if (!next) break;
        await this.capture(String(next.id));
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      if (this.progress.processed || this.progress.inventoried) for (const source of this.sources().filter(s => s.enabled))
        await this.siteFolders.refresh(source.id).catch(() => { /* The connection shows the retained original and one repair action. */ });
      if (this.progress.processed || this.progress.inventoried) await this.journal.publish();
    })().finally(() => { this.progress.phase = "idle"; this.running = undefined; });
    return this.running;
  }
  async stop() { this.stopping = true; await this.running; }
  answerSite(id: string, revision: number, site: string) {
    this.cloud?.assertVisible(id);
    const doc = this.document(id);
    this.permitted(this.source(doc.source_id));
    if (doc.revision !== revision || !doc.hash || !currentStatuses.has(doc.status)) throw new Error("STALE_DOCUMENT");
    const label = safeLabel(site);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE documents SET site=? WHERE id=?").run(label, id);
      this.db.prepare("INSERT OR REPLACE INTO document_site_origins VALUES(?,'manual')").run(id);
      this.audit("site_answer", id, { revision, before: doc.site, after: label });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  answerFolder(sourceId: string, directory: string, answer: "site" | "mixed" | "later", site?: string) {
    const source = this.source(sourceId);
    this.permitted(source);
    if (!this.db.prepare("SELECT id FROM documents WHERE source_id=? AND relative_dir=? LIMIT 1").get(sourceId, directory)) throw new Error("DOCUMENT_NOT_FOUND");
    const label = answer === "site" ? safeLabel(site ?? "") : null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO folder_answers VALUES(?,?,?,?,?) ON CONFLICT(source_id,relative_dir) DO UPDATE SET answer=excluded.answer,site=excluded.site,created_at=excluded.created_at")
        .run(sourceId, directory, answer, label, now());
      const targets = answer === "site" ? this.db.prepare("SELECT id FROM documents WHERE source_id=? AND relative_dir=? AND status IN ('complete','partial') AND (site IS NULL OR id IN (SELECT document_id FROM document_site_origins WHERE kind IN ('folder_default','folder_rule','automatic')))").all(sourceId, directory) : [];
      for (const target of targets) {
        this.db.prepare("UPDATE documents SET site=? WHERE id=?").run(label, String(target.id));
        this.db.prepare("INSERT OR REPLACE INTO document_site_origins VALUES(?,'folder_rule')").run(String(target.id));
      }
      const changed = targets.length;
      this.audit("folder_answer", sourceId, { directory, answer, site: label, changed });
      this.db.exec("COMMIT");
      return { saved: true, changed: Number(changed) };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  reviewFolder(sourceId: string, directory: string) {
    this.permitted(this.source(sourceId));
    this.db.prepare("DELETE FROM folder_answers WHERE source_id=? AND relative_dir=? AND answer='later'").run(sourceId,directory);
    this.audit("folder_review_requested",sourceId);
  }
  planCopies(ids: string[]) {
    if (ids.length < 1 || ids.length > 100 || new Set(ids).size !== ids.length) throw new Error("INVALID_SELECTION");
    const id = randomUUID();
    const items = ids.map(documentId => {
      this.cloud?.assertVisible(documentId);
      const doc = this.document(documentId);
      const source = this.source(doc.source_id);
      this.permitted(source);
      this.assertCurrent(doc);
      return { id: doc.id, revision: doc.revision, hash: doc.hash, generation: source.generation,
        site: doc.site,
        destination: path.join(outputSite(doc.site), safeLabel(doc.category), `${[...path.basename(doc.name, doc.ext)].map(c => c.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(c) ? "_" : c).slice(0, 48).join("")}-${doc.id.slice(0, 8)}${doc.ext}`),
        name: doc.name };
    });
    this.db.prepare("INSERT INTO plans(id,items,created_at) VALUES(?,?,?)").run(id, JSON.stringify(items), now());
    return { id, items, destination: path.join(this.dataDir, "organized-copies", id) };
  }
  async executeCopies(id: string) {
    const plan = this.db.prepare("SELECT * FROM plans WHERE id=?").get(id);
    if (!plan) throw new Error("PLAN_NOT_FOUND");
    if (plan.completed_at) return { copied: true, replay: true };
    if (Date.now() - Date.parse(String(plan.created_at)) > 30 * 60_000) throw new Error("PLAN_EXPIRED");
    const items = JSON.parse(String(plan.items)) as { id: string; revision: number; hash: string; generation: number; site: string | null; destination: string; name: string }[];
    // Validate all approvals before any writes. Only the fixed private output root is writable.
    for (const item of items) {
      const doc = this.document(item.id);
      const source = this.source(doc.source_id);
      this.permitted(source);
      if (doc.hash !== item.hash || doc.revision !== item.revision || source.generation !== item.generation
        || doc.site !== item.site
        || !currentStatuses.has(doc.status)) throw new Error("STALE_PLAN");
      await this.snapshot(doc.id);
    }
    const output = path.join(this.dataDir, "organized-copies", id);
    for (const item of items) {
      const source = this.source(this.document(item.id).source_id);
      if (!source.enabled || source.generation !== item.generation) throw new Error("SCOPE_REVOKED");
      const destination = path.resolve(output, item.destination);
      if (!inside(output, destination)) throw new Error("OUTSIDE_SCOPE");
      await mkdir(path.dirname(destination), { recursive: true });
      for (let cursor = path.dirname(destination); inside(this.dataDir, cursor); cursor = path.dirname(cursor)) {
        if ((await lstat(cursor)).isSymbolicLink()) throw new Error("LINK_NOT_ALLOWED");
        if (cursor === this.dataDir) break;
      }
      try { if ((await lstat(destination)).isSymbolicLink()) throw new Error("LINK_NOT_ALLOWED"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await atomicPrivateFile(destination, (await this.snapshot(item.id)).bytes, item.hash);
      if (sha256(await readFile(destination)) !== item.hash) throw new Error("COPY_CORRUPT");
    }
    await writeFile(path.join(output, "sigongnote-generated.json"), JSON.stringify({ policy: "copy-only", items }, null, 2), { mode: 0o600 });
    this.db.prepare("UPDATE plans SET completed_at=? WHERE id=?").run(now(), id);
    this.audit("copies_approved", id, { count: items.length });
    return { copied: true, replay: false };
  }
  close() { this.db.close(); }
}
