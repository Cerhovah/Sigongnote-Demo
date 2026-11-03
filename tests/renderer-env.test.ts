import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {parserEnvironment, rendererEnvironment} from '../services/api/src/parse-worker.js';

function configure(t: TestContext, values: Record<string, string>) {
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('renderer receives the configured font while parsing and child credentials stay isolated', t => {
  configure(t, {SIGONGNOTE_PDF_FONT_PATH: '/synthetic/korean.ttf',
    WORKER_DATABASE_URL: 'synthetic-private-db', SUPABASE_SECRET_KEY: 'synthetic-private-storage'});
  const renderer = rendererEnvironment('/synthetic/worker');
  assert.equal(renderer.SIGONGNOTE_PDF_FONT_PATH, '/synthetic/korean.ttf');
  assert.equal(renderer.WORKER_DATABASE_URL, undefined);
  assert.equal(renderer.SUPABASE_SECRET_KEY, undefined);
  assert.equal(parserEnvironment('/synthetic/worker').SIGONGNOTE_PDF_FONT_PATH, undefined);
});

test('a per-job font override wins without modifying the parent configuration', t => {
  configure(t, {SIGONGNOTE_PDF_FONT_PATH: '/synthetic/default.ttf'});
  assert.equal(rendererEnvironment('/synthetic/worker', '/synthetic/job.ttf')
    .SIGONGNOTE_PDF_FONT_PATH, '/synthetic/job.ttf');
  assert.equal(process.env.SIGONGNOTE_PDF_FONT_PATH, '/synthetic/default.ttf');
});
