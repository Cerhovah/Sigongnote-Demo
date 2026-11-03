import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,readdir,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isolatedProcessingDatabase} from './isolated-processing-db.js';
import {processingFixture} from './processing-fixture.js';
import {createProductionApp} from '../services/api/src/production-app.js';
import {loadLocalApiConfig} from '../services/api/src/config.js';
import postgres from 'postgres';

test('release readiness requires every pinned migration, accepts cloud source names, and restricts registry access',async()=>{
 const isolated=await isolatedProcessingDatabase(),db=await processingFixture(isolated.name);
 const folder=await mkdtemp(join(tmpdir(),'sigongnote-migration-ready-')),file=pathToFileURL(join(folder,'release.json'));
 const names=(await readdir('supabase/migrations')).filter(n=>/^\d{14}_.+\.sql$/.test(n)).sort(),versions=names.map(n=>n.slice(0,14));
 const release={schema:1,source_sha:'a'.repeat(40),archive_sha256:'b'.repeat(64),migration_hash:'c'.repeat(64),migrations:versions,source_dirty:false};
 const url=new URL(loadLocalApiConfig().databaseUrl);url.pathname='/'+isolated.name;
 const api=postgres(url.href,{max:1,connection:{statement_timeout:15000}});
 const previous=process.env.APP_ENV,app=createProductionApp({db:api,verifyToken:async()=>null},file);
 try{
  process.env.APP_ENV='production';await writeFile(file,JSON.stringify(release));
  for(const name of names)await db.admin`insert into supabase_migrations.schema_migrations(version,name) values(${name.slice(0,14)},${name.slice(15,-4)}) on conflict(version) do nothing`;
  const ready=await app.inject('/health/ready');assert.equal(ready.statusCode,200,ready.body);assert.equal(ready.json().migrations,'ready');
  const latest=versions.at(-1)!;await db.admin`delete from supabase_migrations.schema_migrations where version=${latest}`;
  const pending=await app.inject('/health/ready');assert.equal(pending.statusCode,503);assert.equal(pending.json().database,'migration_pending');
  assert.equal((await app.inject('/health/live')).statusCode,200);
  await db.admin`insert into supabase_migrations.schema_migrations(version,name) values('20990101000000',${names.at(-1)!.slice(0,-4)})`;
  assert.equal((await app.inject('/health/ready')).statusCode,200,'cloud-generated version retains the canonical source timestamp in name');
  for(const bad of [[],['bad'],[latest,latest],['20990102000000']])assert.equal((await db.api`select app.release_migrations_applied(${bad}::text[]) ok`)[0]!.ok,false);
  await assert.rejects(db.worker`select app.release_migrations_applied(${versions}::text[])`,/permission denied/);
  for(const role of ['anon','authenticated','service_role'])assert.equal((await db.admin`select has_function_privilege(${role},'app.release_migrations_applied(text[])','EXECUTE') ok`)[0]!.ok,false);
  await assert.rejects(db.api`select * from supabase_migrations.schema_migrations`,/permission denied/);
  await db.admin.unsafe(await readFile('supabase/tests/tenant_boundary.sql','utf8'));
  await db.admin`alter function app.release_migrations_applied(text[]) rename to release_gate_unavailable`;
  const absent=await app.inject('/health/ready');assert.equal(absent.statusCode,503);assert.equal(absent.json().database,'migration_pending');
  assert.equal((await app.inject('/health/live')).statusCode,200);
 }finally{
  if(previous===undefined)delete process.env.APP_ENV;else process.env.APP_ENV=previous;
  try{await app.close();}finally{try{await Promise.all([api.end(),db.admin.end(),db.api.end(),db.worker.end()]);}finally{await isolated.close();await rm(folder,{recursive:true,force:true});}}
 }
});
