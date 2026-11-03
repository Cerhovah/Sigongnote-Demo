import assert from "node:assert/strict";
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { loadLocalApiConfig } from "../services/api/src/config.ts";

test("local API chooses the guarded file over inherited process settings", () => {
  const directory = mkdtempSync(join(tmpdir(), "sigongnote-api-config-"));
  const path = join(directory, "local.env");
  const content = [
    "APP_ENV=development", "AI_PROVIDER=claude", "AI_DAILY_BUDGET_KRW=10000",
    "DATABASE_URL=postgresql://sigongnote_api@127.0.0.1:54322/postgres",
    "SUPABASE_URL=http://127.0.0.1:54321", "SUPABASE_PUBLISHABLE_KEY=fixture",
    "SUPABASE_SECRET_KEY=fixture-secret",
  ].join("\n");
  const previous = process.env.DATABASE_URL;
  try {
    process.env.DATABASE_URL = "postgresql://remote.example/postgres";
    writeFileSync(path, content);
    assert.equal(loadLocalApiConfig(pathToFileURL(path)).databaseUrl,
      "postgresql://sigongnote_api@127.0.0.1:54322/postgres");
    writeFileSync(path, content.replace("sigongnote_api@", "postgres@"));
    assert.throws(() => loadLocalApiConfig(pathToFileURL(path)), /incomplete/);
    writeFileSync(path, `${content}\nSUPABASE_URL=https://remote.example\n`);
    assert.throws(() => loadLocalApiConfig(pathToFileURL(path)), /Ambiguous/);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
    unlinkSync(path);
    rmdirSync(directory);
  }
});
