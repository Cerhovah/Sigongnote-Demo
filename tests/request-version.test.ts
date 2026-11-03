import assert from 'node:assert/strict';
import {test} from 'node:test';
import Fastify from 'fastify';
import {execute, expectedVersion} from '../services/api/src/routes.js';

function revisionApp() {
  const app = Fastify();
  app.post('/revision', (request, reply) => execute(reply, async () => ({
    status: 200, body: {version: expectedVersion(request)},
  })));
  return app;
}

test('revision headers accept the exact PostgreSQL positive integer boundaries', async t => {
  const app = revisionApp();
  t.after(() => app.close());
  for (const version of [1, 2147483647]) {
    const response = await app.inject({method: 'POST', url: '/revision',
      headers: {'if-match': `"${version}"`}});
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {version});
  }
});

test('revision headers reject ambiguous tags and overflow through the public error contract', async t => {
  const app = revisionApp();
  t.after(() => app.close());
  const rejected = [undefined, '1', 'W/"1"', '*', '"0"', '"01"', '"-1"',
    '"1.0"', '"1e1"', '"1", "2"', '"2147483648"', '"9007199254740992"'];
  for (const header of rejected) {
    const response = await app.inject({method: 'POST', url: '/revision',
      headers: header === undefined ? {} : {'if-match': header}});
    assert.equal(response.statusCode, 400, String(header));
    assert.equal(response.json().error.code, 'INVALID_CONTRACT', String(header));
  }
});
