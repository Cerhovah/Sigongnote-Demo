import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";

export interface ParsedDocument {
  status: "complete" | "partial" | "failed" | "unsupported" | "encrypted";
  sourceHash?: string;
  parserVersion?: string;
  spans: { text: string; locator: string }[];
  issues: string[];
  excerptTruncated?: boolean;
  coverage?: Record<string, number>;
}
export type Parser = (copy: string, output: string) => Promise<ParsedDocument>;

/** A sequential persistent process. Hung parsers are killed, not retried forever. */
export class DocumentParser {
  private child: ChildProcessWithoutNullStreams | undefined;
  private pending: ((result: ParsedDocument) => void) | undefined;
  constructor(private readonly repo: string, private readonly timeoutMs = 60_000) {}
  parse: Parser = (copy, output) => {
    if (this.pending) throw new Error("PARSER_BUSY");
    if (!this.child) {
      const worker = path.join(this.repo, "services/document-worker");
      const python = process.env.SIGONGNOTE_PYTHON ?? path.join(worker,
        process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
      const child = spawn(python, ["-m", "sigongnote_worker"], {
        cwd: worker, windowsHide: true, stdio: "pipe",
        env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP,
          LOCALAPPDATA: process.env.LOCALAPPDATA, PROGRAMFILES: process.env.PROGRAMFILES,
          PYTHONPATH: path.join(worker, "src"), PYTHONIOENCODING: "utf-8" },
      });
      this.child = child;
      child.stderr.resume(); // Parser diagnostics may contain private source content.
      const lines = createInterface({ input: child.stdout });
      lines.on("line", line => {
        try { this.pending?.(JSON.parse(line) as ParsedDocument); }
        catch { this.pending?.({ status: "failed", spans: [], issues: ["parser_invalid_response"] }); }
      });
      const failed = () => {
        if (this.child !== child) return;
        this.child = undefined;
        this.pending?.({ status: "failed", spans: [], issues: ["parser_unavailable"] });
      };
      child.on("error", failed);
      child.on("exit", failed);
      child.stdin.on("error", failed);
    }
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending?.({ status: "failed", spans: [], issues: ["parser_timeout"] });
        this.close();
      }, this.timeoutMs);
      this.pending = result => { clearTimeout(timer); this.pending = undefined; resolve(result); };
      this.child?.stdin.write(`${JSON.stringify({ path: copy, output })}\n`);
    });
  };
  close() { const child = this.child; this.child = undefined; child?.kill(); }
}
