import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

const magic = Buffer.from("SGNLOCAL1");
export class CopyProtection {
  constructor(private readonly key: Buffer) { if (key.length !== 32) throw new Error("INVALID_LOCAL_KEY"); }
  sealed(bytes: Buffer) { return bytes.subarray(0, magic.length).equals(magic); }
  encrypt(bytes: Buffer) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(magic);
    const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return Buffer.concat([magic, iv, cipher.getAuthTag(), body]);
  }
  decrypt(bytes: Buffer) {
    if (!this.sealed(bytes) || bytes.length < magic.length + 28) throw new Error("COPY_CORRUPT");
    const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(magic.length, magic.length + 12));
    decipher.setAAD(magic); decipher.setAuthTag(bytes.subarray(magic.length + 12, magic.length + 28));
    return Buffer.concat([decipher.update(bytes.subarray(magic.length + 28)), decipher.final()]);
  }
}
export async function loadCopyProtection(repo: string, dataDir: string) {
  if (process.platform !== "win32") throw new Error("WINDOWS_KEY_PROTECTION_REQUIRED");
  try {
    const helper=process.env.SIGONGNOTE_WINDOWS_HELPER;
    const { stdout } = await promisify(execFile)(helper??process.env.SIGONGNOTE_POWERSHELL ?? "pwsh.exe", helper?['--local-key',path.join(dataDir,'copy-key.protected')]:[
      "-NoProfile", "-File", path.join(repo, "scripts/local-agent-key.ps1"), "-KeyFile", path.join(dataDir, "copy-key.protected"),
    ], { windowsHide: true, maxBuffer: 2048 });
    return new CopyProtection(Buffer.from(stdout.trim(), "base64"));
  } catch { throw new Error("LOCAL_KEY_PROTECTION_FAILED"); } // execFile errors include stdout; never propagate key bytes.
}
