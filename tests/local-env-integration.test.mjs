import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmdirSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyLocalDevelopmentDb} from '../scripts/db-gate.mjs';
import {local,content} from './local-env-fixture.mjs';
test("live DB gate rejects a hosted-looking .env while local services are healthy", async () => {
  assert.notEqual(process.env.SIGONGNOTE_E2E_DB,'1');
  assert.equal((await verifyLocalDevelopmentDb()).status,'READY');
  const directory = mkdtempSync(join(tmpdir(), "sigongnote-c03-"));
  const path = join(directory, ".env");
  try {
    writeFileSync(path, content.replace(local.API_URL, "https://unrelated-project.supabase.co"));
    const result = await verifyLocalDevelopmentDb(path);
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.reason, "Application environment differs from local Supabase");
  } finally { unlinkSync(path); rmdirSync(directory); }
});
