import assert from "node:assert/strict";
import { test } from "node:test";
import {local,values,content} from "./local-env-fixture.mjs";
import { configureLocalContent } from "../scripts/configure-local-env.mjs";
import { localEnvironmentMatches } from "../scripts/db-gate.mjs";

test("local setup refuses existing hosted project values without changing them", () => {
  const hosted = content.replace(local.API_URL, "https://unrelated-project.supabase.co");
  assert.throws(() => configureLocalContent(hosted, values), /SUPABASE_URL differs/);
  assert.equal(localEnvironmentMatches(hosted, local), false);
  const remoteDb = new URL(local.DB_URL);
  remoteDb.hostname = "remote.example";
  const hostedDb = content.replace(/^DATABASE_URL=/m, `DATABASE_URL=${remoteDb}`);
  assert.throws(() => configureLocalContent(hostedDb, values), /DATABASE_URL is not the local/);
  assert.equal(localEnvironmentMatches(hostedDb, local), false);
  assert.equal(localEnvironmentMatches(content, local), true);
  const migrationAsRuntime = content.replace(/^DATABASE_URL=/m, `DATABASE_URL=${local.DB_URL}`);
  assert.equal(localEnvironmentMatches(migrationAsRuntime, local), false);
  for (const duplicate of [
    `${content}SUPABASE_URL=https://unrelated-project.supabase.co\n`,
    `${content}export SUPABASE_URL=https://unrelated-project.supabase.co\n`,
  ]) {
    assert.throws(() => configureLocalContent(duplicate, values), /Ambiguous/);
    assert.equal(localEnvironmentMatches(duplicate, local), false);
  }
});
