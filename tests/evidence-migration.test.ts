import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import postgres from 'postgres';
import {parseStrictLocalEnv} from '../scripts/local-env-values.mjs';
import {verifyLocalDevelopmentDb} from '../scripts/db-gate.mjs';
import {recoveryCommand} from '../scripts/recovery-drill.js';
import {LOCAL_CAPTURE_POLICY} from '../services/api/src/capture-scope.js';

const migration='20261003103653_n02_full_evidence_chunks.sql';
const tables=['evidence_chunk_indexes','evidence_chunks','evidence_retention_tasks'];
test('N02 isolated fresh schema, upgrade rollback/replay, backfill and restored chunk/RLS manifest',async()=>{
 assert.equal((await verifyLocalDevelopmentDb()).status,'READY');
 const env=parseStrictLocalEnv(await readFile('services/api/.env','utf8'));assert.equal(new URL(env.MIGRATION_DATABASE_URL!).hostname,'127.0.0.1');
 const admin=postgres(env.MIGRATION_DATABASE_URL!,{max:1,onnotice:()=>{}});
 const project=/^project_id\s*=\s*"([a-z0-9-]+)"/m.exec(await readFile('supabase/config.toml','utf8'))?.[1];assert.ok(project);
 const container='supabase_db_'+project,name='sigongnote_drill_seed_'+randomUUID().replaceAll('-',''),restoredName='sigongnote_drill_seed_'+randomUUID().replaceAll('-','');
 const connect=(database:string)=>{const url=new URL(env.MIGRATION_DATABASE_URL!);url.pathname='/'+database;return postgres(url.toString(),{max:1,onnotice:()=>{}});};
 let fresh:postgres.Sql|undefined,restored:postgres.Sql|undefined,created=false,restoredCreated=false;
 try{
  const base=await recoveryCommand(['exec',container,'pg_dump','-U','postgres','-d','postgres','--schema-only','--exclude-schema=app','--no-publications','--no-subscriptions']);
  // App migrations recreate storage policies that reference app functions after the schema exists.
  const foundation=base.toString('utf8').replace(/^CREATE POLICY [\s\S]*?;\r?\n/gm,statement=>statement.includes('app.')?'':statement);
  await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE template0`);created=true;
  await recoveryCommand(['exec','-i',container,'psql','-X','-q','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d',name],Buffer.from(foundation));
  fresh=connect(name);
  const previous=(await readdir('supabase/migrations')).filter(n=>n.endsWith('.sql')&&n<migration&&!/_n\d+_/.test(n)).sort();
  for(const file of previous)await fresh.unsafe(await readFile('supabase/migrations/'+file,'utf8'));
  assert.equal((await fresh`select to_regclass('app.evidence_chunks') object`)[0]?.object,null);
  const tenant=randomUUID(),user=randomUUID(),blob=randomUUID(),document=randomUUID(),revision=randomUUID(),job=randomUUID(),sourceText='합성 복원 근거';
  const sourceHash=createHash('sha256').update(sourceText).digest('hex');
  await fresh`insert into auth.users(id) values(${user}::uuid)`;
  await fresh`insert into app.tenants(id,display_name) values(${tenant}::uuid,'N02 migration fixture')`;
  await fresh`insert into app.memberships(tenant_id,user_id,role) values(${tenant}::uuid,${user}::uuid,'owner')`;
  await fresh`insert into app.evidence_blobs(tenant_id,id,sha256,byte_length,sniffed_mime,storage_key) values(${tenant}::uuid,${blob}::uuid,${sourceHash},20,'text/plain',${tenant+'/'+blob})`;
  await fresh`insert into app.documents(tenant_id,id) values(${tenant}::uuid,${document}::uuid)`;
  await fresh`insert into app.document_revisions(tenant_id,id,document_id,revision_number,blob_id,declared_mime) values(${tenant}::uuid,${revision}::uuid,${document}::uuid,1,${blob}::uuid,'text/plain')`;
  await fresh`insert into app.jobs(tenant_id,id,job_type,evidence_revision_id,processor_version,input_hash) values(${tenant}::uuid,${job}::uuid,'parse_original',${revision}::uuid,'document-python-v1',${sourceHash})`;
  const [lease]=await fresh`select * from app.claim_parse_job_for_tenant('n02-legacy',60,'document-python-v1',${tenant}::uuid)`;
  const output={status:'complete',sourceHash,parserVersion:'test',spans:[{text:sourceText,locator:'line:1'}],excerptTruncated:false,issues:[],processorVersion:'document-python-v1',schemaVersion:'parse-output-v1'};
  assert.equal((await fresh`select app.complete_parse_output(${tenant}::uuid,${job}::uuid,${lease!.lease_token}::uuid,${fresh.json(output)},${fresh.json(LOCAL_CAPTURE_POLICY)}) ok`)[0]?.ok,true);
  const sql=await readFile('supabase/migrations/'+migration,'utf8'),rollback=Error('intentional migration rollback');
  await assert.rejects(fresh.begin(async tx=>{await tx.unsafe(sql);throw rollback;}),e=>e===rollback);
  assert.equal((await fresh`select to_regclass('app.evidence_chunks') object`)[0]?.object,null);
  await fresh.begin(async tx=>{await tx.unsafe(sql);});
  assert.equal((await fresh`select count(*)::int n from app.parse_results where tenant_id=${tenant}::uuid`)[0]?.n,1,'upgrade preserves legacy output');
  const [reindex]=await fresh`select * from app.claim_parse_job_for_tenant('n02-backfill',60,'document-evidence-v1',${tenant}::uuid)`;assert.ok(reindex);
  const manifest={schemaVersion:'evidence-chunks-v1',chunkCount:1,parserVersion:'test',sourceStatus:'complete',coverage:{lines_read:1},completeExtractedText:true};
  const chunks=[{ordinal:0,text:sourceText,locator:'line:1',position:{character_start:0,character_end:sourceText.length},contentHash:sourceHash}];
  assert.equal((await fresh`select app.begin_evidence_index(${tenant}::uuid,${reindex.job_id}::uuid,${reindex.lease_token}::uuid,${fresh.json(manifest)},${fresh.json(LOCAL_CAPTURE_POLICY)}) ok`)[0]?.ok,true);
  assert.equal((await fresh`select app.stage_evidence_chunks(${tenant}::uuid,${reindex.job_id}::uuid,${reindex.lease_token}::uuid,${fresh.json(chunks)},${fresh.json(LOCAL_CAPTURE_POLICY)}) ok`)[0]?.ok,true);
  const full={...output,processorVersion:'document-evidence-v1',evidence:manifest};
  assert.equal((await fresh`select app.complete_parse_output(${tenant}::uuid,${reindex.job_id}::uuid,${reindex.lease_token}::uuid,${fresh.json(full)},${fresh.json(LOCAL_CAPTURE_POLICY)}) ok`)[0]?.ok,true);
  assert.equal((await fresh`select app.complete_parse_output(${tenant}::uuid,${reindex.job_id}::uuid,${reindex.lease_token}::uuid,${fresh.json(full)},${fresh.json(LOCAL_CAPTURE_POLICY)}) ok`)[0]?.ok,true);
  const snapshot=async(db:postgres.Sql)=>{const result:Record<string,unknown>={};for(const table of tables){const rows=await db`select to_jsonb(t)::text value from ${db('app.'+table)} t order by to_jsonb(t)::text`;result[table]={count:rows.length,sha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex')};}return result;};
  const before=await snapshot(fresh),dump=await recoveryCommand(['exec',container,'pg_dump','-U','postgres','-d',name,'-Fc']);
  await admin.unsafe(`CREATE DATABASE ${restoredName} TEMPLATE template0`);restoredCreated=true;
  await recoveryCommand(['exec','-i',container,'pg_restore','-U','supabase_admin','-d',restoredName,'--exit-on-error','--no-publications','--no-subscriptions'],dump);
  restored=connect(restoredName);assert.deepEqual(await snapshot(restored),before);
  await restored.begin(async tx=>{await tx`set local role sigongnote_api`;await tx`select set_config('request.jwt.claim.sub',${randomUUID()},true)`;for(const table of tables)assert.equal((await tx`select count(*)::int n from ${tx('app.'+table)}`)[0]?.n,0);});
  await restored.begin(async tx=>{await tx`set local role sigongnote_api`;await tx`select set_config('request.jwt.claim.sub',${user},true)`;assert.equal((await tx`select text from app.evidence_chunks`)[0]?.text,sourceText);});
 }finally{
  if(restored)await restored.end();if(fresh)await fresh.end();
  if(restoredCreated)await admin.unsafe(`DROP DATABASE ${restoredName}`);if(created)await admin.unsafe(`DROP DATABASE ${name}`);await admin.end();
 }
});
