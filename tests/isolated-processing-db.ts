import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import postgres from 'postgres';
import {parseStrictLocalEnv} from '../scripts/local-env-values.mjs';
import {verifyLocalDevelopmentDb} from '../scripts/db-gate.mjs';
import {recoveryCommand} from '../scripts/recovery-drill.js';

/** Fresh schema in the verified local cluster; running development workers cannot claim these jobs. */
export async function isolatedProcessingDatabase(){
 assert.equal((await verifyLocalDevelopmentDb()).status,'READY');
 if(process.env.SIGONGNOTE_E2E_DB==='1'){
  // Plain PostgreSQL (CI/E2E): a fresh database with the foundation shim and every migration, same role passwords as the main E2E database.
  const {createE2eDatabase,dropE2eDatabase}=await import('../scripts/e2e-db.mjs');
  const created=await createE2eDatabase({name:'sigongnote_drill_seed_'+randomUUID().replaceAll('-',''),quiet:true,writeEnv:false});
  return {name:created.database,close:async()=>{await dropE2eDatabase(created);}};
 }
 const env=parseStrictLocalEnv(await readFile('services/api/.env','utf8'));
 const admin=postgres(env.MIGRATION_DATABASE_URL!,{max:1,onnotice:()=>{}});
 const project=/^project_id\s*=\s*"([a-z0-9-]+)"/m.exec(await readFile('supabase/config.toml','utf8'))?.[1];assert.ok(project);
 const container='supabase_db_'+project,name='sigongnote_drill_seed_'+randomUUID().replaceAll('-','');
 let created=false;
 const close=async()=>{try{if(created)await admin.unsafe('DROP DATABASE '+name);}finally{await admin.end();}};
 try{
  const base=await recoveryCommand(['exec',container,'pg_dump','-U','postgres','-d','postgres','--schema-only','--exclude-schema=app','--no-publications','--no-subscriptions']);
  const foundation=base.toString('utf8').replace(/^CREATE POLICY [\s\S]*?;\r?\n/gm,s=>s.includes('app.')?'':s);
  await admin.unsafe('CREATE DATABASE '+name+' TEMPLATE template0');created=true;
  await recoveryCommand(['exec','-i',container,'psql','-X','-q','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d',name],Buffer.from(foundation));
  const url=new URL(env.MIGRATION_DATABASE_URL!);url.pathname='/'+name;const db=postgres(url.href,{max:1,onnotice:()=>{}});
  try{for(const file of (await readdir('supabase/migrations')).filter(n=>n.endsWith('.sql')).sort())await db.begin(async tx=>{await tx.unsafe(await readFile('supabase/migrations/'+file,'utf8'));});}
  finally{await db.end();}
  return {name,close};
 }catch(error){await close();throw error;}
}
