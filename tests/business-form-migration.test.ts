import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import postgres from 'postgres';
import {parseStrictLocalEnv} from '../scripts/local-env-values.mjs';
import {verifyLocalDevelopmentDb} from '../scripts/db-gate.mjs';
test('business form migration is repeatable, preserves renderer privileges and rolls back',async()=>{
 assert.equal((await verifyLocalDevelopmentDb()).status,'READY');const env=parseStrictLocalEnv(readFileSync('services/api/.env','utf8')),db=postgres(env.MIGRATION_DATABASE_URL!,{max:1});
 const migration=readFileSync('supabase/migrations/20261006013000_business_form_version.sql','utf8'),stop=Error('rollback');
 const definition=()=>db`select pg_get_functiondef(oid) body,proacl::text acl,prosecdef,proconfig from pg_proc where oid in ('app.complete_render_job(uuid,uuid,uuid,text,bytea,bytea)'::regprocedure,'app.queue_document_render()'::regprocedure,'app.claim_render_job(text,uuid)'::regprocedure,'app.render_job_input(uuid,uuid,uuid)'::regprocedure) order by oid`;
 try{const before=await definition();await assert.rejects(db.begin(async tx=>{await tx.unsafe(migration);await tx.unsafe(migration);const [row]=await tx`select has_function_privilege('sigongnote_worker','app.complete_render_job(uuid,uuid,uuid,text,bytea,bytea)','execute') worker,has_function_privilege('sigongnote_api','app.complete_render_job(uuid,uuid,uuid,text,bytea,bytea)','execute') api`;assert.deepEqual(row,{worker:true,api:false});throw stop;}),e=>e===stop);assert.deepEqual(await definition(),before);}finally{await db.end();}
});
