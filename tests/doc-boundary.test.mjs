import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateActiveLinks, checkSpec } from '../scripts/check-spec.mjs';

test('active documentation rejects encoded archive links and retired entry paths',()=>{
 assert.match(validateActiveLinks('[old](../0.2%20ver/docs/AGENT_SPEC.md)','docs/AGENT_SPEC.md').join('\n'),/forbidden archive/);
 assert.match(validateActiveLinks('read docs/ARCHITECTURE.md','AGENTS.md').join('\n'),/retired document/);
 assert.match(validateActiveLinks('read 0.2 ver/docs/AGENT_SPEC.md','AGENTS.md').join('\n'),/forbidden archive path/);
 assert.deepEqual(validateActiveLinks('Do not read `0.2 ver/`.','AGENTS.md'),[]);
 assert.deepEqual(validateActiveLinks('[current](docs/AGENT_SPEC.md)','README.md'),[]);
 assert.match(checkSpec(),/Archive not consulted/);
});
