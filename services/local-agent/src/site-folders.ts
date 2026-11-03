import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LocalAgent, LocalDocument } from "./agent.js";
import { inside, sha256, safeLabel } from "./agent.js";

export const siteCategories = ["약속", "도면·자재", "납품·작업", "청구·지급", "점검·하자", "발행문서"] as const;
export function siteCategory(doc: Pick<LocalDocument, "name" | "ext" | "category">): typeof siteCategories[number] {
  if (/하자|검수|보완|점검/.test(doc.name)) return "점검·하자";
  if (/계산서|청구|지급|정산|수금|매입|매출|거래명세/.test(doc.name) || doc.category === "돈") return "청구·지급";
  if (/도면|실측|규격|색상|자재승인|자재제출/.test(doc.name) || doc.ext === ".dwg") return "도면·자재";
  if (/납품|인수|출역|시공|작업/.test(doc.name) || /\.(jpg|jpeg|png|webp|heic)$/.test(doc.ext)) return "납품·작업";
  return "약속";
}
const html = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
type Manifest = { version: 1; id: string; sourceId: string; files: Record<string, string>; pending?: Record<string, string>; allowed?: Record<string, string[]> };

/** Approved indexes link to originals. The managed area never becomes an ingestion source. */
export class ManagedSiteFolders {
  private readonly operations = new Map<string, Promise<unknown>>();
  constructor(private readonly agent: LocalAgent) {
    agent.db.exec(`CREATE TABLE IF NOT EXISTS site_roots(source_id TEXT PRIMARY KEY REFERENCES sources(id),
      id TEXT NOT NULL,site TEXT,project_id TEXT,status TEXT NOT NULL DEFAULT 'pending',error TEXT);
      CREATE TABLE IF NOT EXISTS document_site_origins(document_id TEXT PRIMARY KEY REFERENCES documents(id),kind TEXT NOT NULL);`);
  }
  get(sourceId: string) { return this.agent.db.prepare("SELECT * FROM site_roots WHERE source_id=?").get(sourceId); }
  isManagedPath(sourceId: string, relative: string) {
    return !!this.get(sourceId) && inside("시공노트", path.normalize(relative));
  }
  connect(sourceId: string, site: string | null, approved: boolean) {
    return this.serial(sourceId, () => this.connectOnce(sourceId, site, approved));
  }
  private async serial<T>(sourceId: string, work: () => Promise<T>): Promise<T> {
    const prior = this.operations.get(sourceId) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(work); this.operations.set(sourceId, next);
    try { return await next; } finally { if (this.operations.get(sourceId) === next) this.operations.delete(sourceId); }
  }
  private async connectOnce(sourceId: string, site: string | null, approved: boolean) {
    if (!approved) throw new Error("MANAGED_FOLDER_APPROVAL_REQUIRED");
    const source = this.agent.source(sourceId);
    if (!source.enabled) throw new Error("SCOPE_REVOKED");
    await this.checkIdentity(sourceId);
    site = site === null ? null : safeLabel(site);
    const previous = this.get(sourceId);
    if (previous && previous.site !== site) throw new Error("SITE_MAPPING_CONFLICT");
    if (!previous) {
      const root = path.join(source.root, "시공노트");
      await this.checkRoute(source.root);
      let id: string = randomUUID();
      try {
        await lstat(root); await this.checkRoute(root);
        const marker = path.join(root, "sigongnote-generated.json"); await this.checkFile(marker);
        const existing = JSON.parse(await readFile(marker, "utf8")) as Manifest;
        // Resume only a directory whose creation receipt is in this private index.
        const receipt = this.agent.db.prepare("SELECT detail FROM audit WHERE kind='site_folder_creation' AND subject=? ORDER BY created_at DESC LIMIT 1").get(sourceId);
        if (!receipt || existing.sourceId !== sourceId || JSON.parse(String(receipt.detail)).id !== existing.id) throw new Error("MANAGED_FOLDER_EXISTS");
        id = existing.id;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        try { await lstat(root); throw new Error("MANAGED_FOLDER_EXISTS"); }
        catch (absent) { if ((absent as NodeJS.ErrnoException).code !== "ENOENT") throw absent; }
        // Build the marker before publishing the directory. A crash before rename leaves only our temporary.
        const temporary = path.join(source.root, `.sigongnote-${id}`);
        await mkdir(temporary);
        await writeFile(path.join(temporary, "sigongnote-generated.json"), JSON.stringify({ version: 1, id, sourceId, files: {} }), { flag: "wx" });
        this.agent.audit("site_folder_creation", sourceId, { id });
        await rename(temporary, root);
      }
      this.agent.db.prepare("INSERT INTO site_roots(source_id,id,site) VALUES(?,?,?)").run(sourceId, id, site);
    }
    if (site) {
      this.agent.db.exec("BEGIN IMMEDIATE");
      try {
        this.agent.db.prepare("INSERT OR REPLACE INTO document_site_origins SELECT id,'folder_default' FROM documents WHERE source_id=? AND site IS NULL").run(sourceId);
        this.agent.db.prepare("UPDATE documents SET site=? WHERE source_id=? AND site IS NULL").run(site, sourceId);
        this.agent.db.exec("COMMIT");
      } catch (error) { this.agent.db.exec("ROLLBACK"); throw error; }
    }
    this.agent.audit("site_folder_connected", sourceId, { common: site === null });
    await this.refreshOnce(sourceId);
    return this.get(sourceId);
  }
  refresh(sourceId: string) { return this.serial(sourceId, () => this.refreshOnce(sourceId)); }
  private async refreshOnce(sourceId: string) {
    const binding = this.get(sourceId); if (!binding) return;
    const source = this.agent.source(sourceId); if (!source.enabled) return;
    const generation = source.generation;
    const root = path.join(source.root, "시공노트"), marker = path.join(root, "sigongnote-generated.json");
    try {
      await this.checkIdentity(sourceId);
      await this.checkRoute(root); await this.checkFile(marker);
      const manifest = JSON.parse(await readFile(marker, "utf8")) as Manifest;
      if (manifest.version !== 1 || manifest.id !== binding.id || manifest.sourceId !== sourceId) throw new Error("MANAGED_FOLDER_CHANGED");
      const docs = this.agent.db.prepare("SELECT * FROM documents WHERE source_id=? AND available=1 ORDER BY mtime DESC,name").all(sourceId) as unknown as LocalDocument[];
      const planned: Record<string, string> = {};
      for (const category of siteCategories) {
        const directory = path.join(root, category);
        try { await mkdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        await this.checkRoute(directory);
        const links = docs.filter(doc => siteCategory(doc) === category).map(doc => {
          const original = path.resolve(source.root, doc.relative_path);
          if (!inside(source.root, original) || inside(root, original)) return "";
          const href = path.relative(directory, original).split(path.sep).map(part => part === ".." ? part : encodeURIComponent(part)).join("/");
          return `<li><a href="${html(href)}">${html(doc.name)}</a></li>`;
        }).join("\n");
        planned[`${category}/자료목록.html`] = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${html(String(binding.site ?? "회사 공통"))} · ${category}</title><style>body{font:20px/1.7 sans-serif;max-width:850px;margin:32px auto;padding:0 20px}a{color:#175844}li{margin:12px 0}</style><h1>${html(String(binding.site ?? "회사 공통"))} · ${category}</h1><p>자료 이름을 누르면 원래 위치에서 열어요. 원본은 옮기지 않았어요. 이 목록 폴더에 새로 넣은 파일은 읽지 않아요.</p><ul>${links || "<li>아직 모인 자료가 없어요.</li>"}</ul></html>`;
      }
      // Journal old/new hashes so an interrupted refresh can safely resume without overwriting edits.
      for (const name of Object.keys(planned)) {
        const file = path.join(root, name);
        try {
          await this.checkFile(file); const hash = sha256(await readFile(file));
          if (hash !== manifest.files[name] && hash !== manifest.pending?.[name] && !manifest.allowed?.[name]?.includes(hash)) throw new Error("MANAGED_FILE_CHANGED");
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      const hashes = Object.fromEntries(Object.entries(planned).map(([name, body]) => [name, sha256(body)]));
      if (!manifest.pending && Object.entries(hashes).every(([name, hash]) => manifest.files[name] === hash)) {
        this.agent.db.prepare("UPDATE site_roots SET status='ready',error=NULL WHERE source_id=?").run(sourceId); return;
      }
      const assertCurrent = () => {
        const current = this.agent.source(sourceId);
        if (!current.enabled || current.generation !== generation) throw new Error("SCOPE_REVOKED");
      };
      assertCurrent();
      const allowed = Object.fromEntries(Object.keys(planned).map(name => [name,
        [...new Set([manifest.files[name], manifest.pending?.[name], ...(manifest.allowed?.[name] ?? []), hashes[name]].filter((hash): hash is string => !!hash))]]));
      await this.replace(marker, JSON.stringify({ ...manifest, pending: hashes, allowed }));
      for (const [name, body] of Object.entries(planned)) {
        assertCurrent(); const file = path.join(root, name); await this.checkRoute(path.dirname(file));
        try {
          await this.checkFile(file); const existing = sha256(await readFile(file));
          if (existing === hashes[name]) continue;
          if (existing !== manifest.files[name] && existing !== manifest.pending?.[name] && !manifest.allowed?.[name]?.includes(existing)) throw new Error("MANAGED_FILE_CHANGED");
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await this.replace(file, body);
      }
      assertCurrent(); await this.replace(marker, JSON.stringify({ version: 1, id: binding.id, sourceId, files: hashes }));
      this.agent.db.prepare("UPDATE site_roots SET status='ready',error=NULL WHERE source_id=?").run(sourceId);
    } catch (error) {
      this.agent.db.prepare("UPDATE site_roots SET status='needs_attention',error=? WHERE source_id=?").run(error instanceof Error && /^MANAGED_|SCOPE_REVOKED/.test(error.message) ? error.message : "MANAGED_FOLDER_UNAVAILABLE", sourceId);
      throw error;
    }
  }
  private async checkIdentity(sourceId: string) {
    const source = this.agent.source(sourceId), identity = await stat(source.root, { bigint: true });
    if (source.root_dev !== String(identity.dev) || source.root_ino !== String(identity.ino)) throw new Error("DIFFERENT_DRIVE");
  }
  private async checkRoute(target: string) {
    for (let cursor = target; ; cursor = path.dirname(cursor)) {
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error("MANAGED_FOLDER_CHANGED");
      if (cursor === path.parse(cursor).root) break;
    }
  }
  private async checkFile(file: string) { if (!(await lstat(file)).isFile() || (await lstat(file)).isSymbolicLink()) throw new Error("MANAGED_FILE_CHANGED"); }
  private async replace(file: string, body: string) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, body, { flag: "wx" }); await rename(temporary, file); }
    finally { await unlink(temporary).catch(() => {}); }
  }
}
