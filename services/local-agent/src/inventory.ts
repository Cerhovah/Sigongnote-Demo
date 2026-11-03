import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

/** Durable discovery metadata. Re-enumeration uses path identity, never directory row offsets. */
export class LocalInventory {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS scan_runs(source_id TEXT PRIMARY KEY REFERENCES sources(id),
      generation INTEGER NOT NULL,grant_generation INTEGER NOT NULL,state TEXT NOT NULL,skipped INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS scan_directories(source_id TEXT NOT NULL,relative_path TEXT NOT NULL,
      depth INTEGER NOT NULL,state TEXT NOT NULL,PRIMARY KEY(source_id,relative_path));
      CREATE TABLE IF NOT EXISTS scan_entries(source_id TEXT NOT NULL,relative_path TEXT NOT NULL,
      generation INTEGER NOT NULL,PRIMARY KEY(source_id,relative_path));
      CREATE INDEX IF NOT EXISTS scan_directory_pending ON scan_directories(source_id,state,depth,relative_path);`);
  }
  pending(sourceId: string): boolean {
    return this.db.prepare("SELECT state FROM scan_runs WHERE source_id=?").get(sourceId)?.state === "running";
  }
  async batch(source: {id: string; root: string; generation: number}, permitted: () => void,
    accept: (relative: string, name: string) => Promise<boolean>, maximum = 400) {
    let run = this.db.prepare("SELECT * FROM scan_runs WHERE source_id=?").get(source.id);
    if (run?.state !== "running" || run.grant_generation !== source.generation) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const generation = Number(run?.generation ?? 0) + 1;
        this.db.prepare("INSERT OR REPLACE INTO scan_runs VALUES(?,?,?,'running',0)").run(source.id, generation, source.generation);
        this.db.prepare("DELETE FROM scan_directories WHERE source_id=?").run(source.id);
        this.db.prepare("INSERT INTO scan_directories VALUES(?,'',0,'todo')").run(source.id);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      run = this.db.prepare("SELECT * FROM scan_runs WHERE source_id=?").get(source.id);
    }
    if (!run) throw new Error("SCAN_RUN_MISSING");
    const generation = Number(run.generation);
    let processed = 0, visited = 0;
    while (processed < maximum && visited++ < 20) {
      permitted();
      const directory = this.db.prepare("SELECT * FROM scan_directories WHERE source_id=? AND state='todo' ORDER BY depth,relative_path LIMIT 1").get(source.id);
      if (!directory) break;
      const relativeDirectory = String(directory.relative_path), depth = Number(directory.depth);
      const absolute = path.join(source.root, relativeDirectory);
      try {
        // Check each route on every resumed batch; a replaced child junction must not escape the grant.
        if (depth > 32 || (await lstat(absolute)).isSymbolicLink() || path.resolve(await realpath(absolute)) !== path.resolve(absolute)) throw new Error("DIRECTORY_GAP");
        const entries = await readdir(absolute, { withFileTypes: true });
        let complete = true;
        if (!entries.some(entry => entry.name === "sigongnote-generated.json" || entry.name === '.git')) {
          for (const entry of entries) {
            permitted();
            if (processed >= maximum) { complete = false; break; }
            const relative = path.join(relativeDirectory, entry.name);
            if (this.db.prepare("SELECT generation FROM scan_entries WHERE source_id=? AND relative_path=?").get(source.id, relative)?.generation === generation) continue;
            if (!entry.isSymbolicLink() && !entry.name.startsWith(".") && !entry.name.startsWith("~$") &&
              !["$RECYCLE.BIN", "System Volume Information", "node_modules", "0.2 ver", "0.2 ver/"].includes(entry.name)) {
              if (entry.isDirectory()) this.db.prepare("INSERT OR IGNORE INTO scan_directories VALUES(?,?,?,'todo')").run(source.id, relative, depth + 1);
              else if (entry.isFile()) {
                try { if (!await accept(relative, entry.name)) this.skipped(source.id); }
                catch (error) {
                  if (error instanceof Error && ["SCOPE_REVOKED", "STOPPED"].includes(error.message)) throw error;
                  if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
                  this.db.prepare("INSERT OR REPLACE INTO scan_directories VALUES(?,?,?,'gap')").run(source.id, relative, depth + 1);
                  this.skipped(source.id);
                }
              }
            } else this.skipped(source.id);
            this.db.prepare("INSERT OR REPLACE INTO scan_entries VALUES(?,?,?)").run(source.id, relative, generation);
            processed++;
          }
        }
        if (complete) this.db.prepare("UPDATE scan_directories SET state='done' WHERE source_id=? AND relative_path=? AND state='todo'").run(source.id, relativeDirectory);
      } catch (error) {
        if (error instanceof Error && ["SCOPE_REVOKED", "STOPPED"].includes(error.message)) throw error;
        this.db.prepare("UPDATE scan_directories SET state='gap' WHERE source_id=? AND relative_path=?").run(source.id, relativeDirectory);
      }
    }
    permitted();
    const pending = !!this.db.prepare("SELECT 1 FROM scan_directories WHERE source_id=? AND state='todo' LIMIT 1").get(source.id);
    const gap = !!this.db.prepare("SELECT 1 FROM scan_directories WHERE source_id=? AND state='gap' LIMIT 1").get(source.id);
    if (!pending) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (!gap) this.db.prepare(`UPDATE documents SET available=0 WHERE source_id=? AND NOT EXISTS
          (SELECT 1 FROM scan_entries e WHERE e.source_id=documents.source_id AND e.relative_path=documents.relative_path AND e.generation=?)`).run(source.id, generation);
        this.db.prepare("UPDATE scan_runs SET state='finished' WHERE source_id=?").run(source.id);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
    return { pending, gap, processed, skipped: Number(this.db.prepare("SELECT skipped FROM scan_runs WHERE source_id=?").get(source.id)?.skipped ?? 0) };
  }
  private skipped(sourceId: string) { this.db.prepare("UPDATE scan_runs SET skipped=skipped+1 WHERE source_id=?").run(sourceId); }
}
