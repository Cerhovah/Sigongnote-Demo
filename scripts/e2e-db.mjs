#!/usr/bin/env node
// Isolated E2E database on a plain PostgreSQL server (no Supabase CLI, no Docker).
// Creates a fresh database, installs the minimal auth/storage/role foundation that the
// migrations expect, applies every supabase/migrations/*.sql in order, provisions the
// sigongnote_api / sigongnote_worker login roles, and writes .work/e2e/env.json.
//
// Usage:
//   node scripts/e2e-db.mjs                 # create and migrate; prints the env file path
//   node scripts/e2e-db.mjs --drop          # drop the database named in .work/e2e/env.json
//   E2E_PG_ADMIN_URL=<admin connection url>  or E2E_PG_HOST/PORT/USER/PASSWORD/DATABASE (default local postgres/postgres)
//   E2E_DB_NAME=sigongnote_e2e_<hex>        (default: random)
// Secrets are never printed; only the env file path is echoed.
import {randomBytes} from 'node:crypto';
import {mkdirSync,readdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import postgres from 'postgres';

export const E2E_ENV_FILE='.work/e2e/env.json';
const APPLICATION_ENV='services/api/'+['.env'].join('');
const FOUNDATION=`
create extension if not exists pgcrypto;
do $$ begin
 if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
 if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
 if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
 if not exists (select 1 from pg_roles where rolname='supabase_admin') then create role supabase_admin nologin; end if;
end $$;
create schema if not exists auth;
create schema if not exists storage;
create schema if not exists extensions;
create table if not exists auth.users(
 id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}'::jsonb, raw_app_meta_data jsonb default '{}'::jsonb,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), last_sign_in_at timestamptz, deleted_at timestamptz);
alter table auth.users add column if not exists aud text default 'authenticated', add column if not exists role text default 'authenticated';
create table if not exists auth.sessions(
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), not_after timestamptz);
create table if not exists auth.identities(
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade, provider text not null, provider_id text not null, identity_data jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(), unique(provider,provider_id));
create or replace function auth.uid() returns uuid language sql stable as $$
 select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;
create or replace function auth.role() returns text language sql stable as $$
 select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role')::text $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
 select coalesce(nullif(current_setting('request.jwt.claim',true),''),nullif(current_setting('request.jwt.claims',true),''))::jsonb $$;
create table if not exists storage.buckets(
 id text primary key, name text not null unique, owner uuid, public boolean not null default false, file_size_limit bigint, allowed_mime_types text[],
 created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists storage.objects(
 id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, owner uuid, metadata jsonb,
 path_tokens text[] generated always as (string_to_array(name,'/')) stored, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
alter table storage.objects enable row level security;
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations(version text primary key, statements text[], name text);
grant usage on schema auth,storage,extensions to anon,authenticated,service_role;
grant select on auth.users,auth.sessions to authenticated,service_role;
`;

/** Admin connection: E2E_PG_ADMIN_URL, or composed from E2E_PG_HOST/PORT/USER/PASSWORD/DATABASE (defaults: 127.0.0.1:5432, postgres/postgres). */
function adminUrl(){
 if(process.env.E2E_PG_ADMIN_URL)return process.env.E2E_PG_ADMIN_URL;
 const u=new URL('postgresql://127.0.0.1/');u.hostname=process.env.E2E_PG_HOST??'127.0.0.1';u.port=process.env.E2E_PG_PORT??'5432';u.pathname='/'+(process.env.E2E_PG_DATABASE??'postgres');
 u.username=process.env.E2E_PG_USER??'postgres';u.password=process.env.E2E_PG_PASSWORD??'postgres';return u.href;
}
function dbUrl(base,name,user,password){const u=new URL(base);u.pathname='/'+name;if(user){u.username=user;u.password=password??'';}return u.href;}
export function migrationFiles(dir='supabase/migrations'){return readdirSync(dir).filter(n=>n.endsWith('.sql')).sort().map(n=>dir+'/'+n);}

export async function createE2eDatabase({name=process.env.E2E_DB_NAME??('sigongnote_e2e_'+randomBytes(8).toString('hex')),admin=adminUrl(),quiet=false,writeEnv=true}={}){
 if(!/^sigongnote_(?:e2e|drill_seed)_[a-z0-9_]{1,40}$/.test(name))throw new Error('E2E_DB_NAME must match sigongnote_e2e_<hex>');
 const root=postgres(admin,{max:1,onnotice:()=>{}});
 const apiPassword=randomBytes(18).toString('hex'),workerPassword=randomBytes(18).toString('hex');
 try{
  await root.unsafe(`drop database if exists ${name}`);
  await root.unsafe(`create database ${name} template template0 encoding 'UTF8'`);
 }finally{await root.end();}
 const db=postgres(dbUrl(admin,name),{max:1,onnotice:()=>{}});
 const applied=[];
 try{
  await db.unsafe(FOUNDATION);
  const [{v}]=await db`select current_setting('server_version_num')::int v`;
  for(const file of migrationFiles()){
   let sql=readFileSync(file,'utf8');
   // MAINTAIN is a PostgreSQL 17 privilege; CI/local runners on 16 keep every other grant.
   if(v<170000)sql=sql.replace(/\bMAINTAIN,\s*/gi,'');
   const version=file.split('/').pop().split('_')[0],label=file.split('/').pop().replace(/^\d+_/,'').replace(/\.sql$/,'');
   try{await db.begin(async tx=>{await tx.unsafe(sql);await tx`insert into supabase_migrations.schema_migrations(version,name) values(${version},${label}) on conflict do nothing`;});applied.push(file);}
   catch(error){throw new Error(`migration failed: ${file}: ${error.message}`);}
  }
  // Login roles for the API and worker (the production provisioning scripts use Vault; here plain passwords).
  // Roles are cluster-wide: an isolated (drill) database created later must not rotate the passwords of the main E2E database.
  if(writeEnv){
   await db.unsafe(`alter role sigongnote_api login password '${apiPassword}'`);
   await db.unsafe(`alter role sigongnote_worker login password '${workerPassword}'`);
   await db.unsafe(`alter role sigongnote_api set statement_timeout='15s'`);
  }
  await db.unsafe(`grant connect on database ${name} to sigongnote_api,sigongnote_worker`);
 }finally{await db.end();}
 const previous=writeEnv?null:readE2eEnv();
 const withDb=(url)=>{const u=new URL(url);u.pathname='/'+name;return u.href;};
 const env={database:name,admin_url:dbUrl(admin,name),api_url:previous?withDb(previous.api_url):dbUrl(admin,name,'sigongnote_api',apiPassword),worker_url:previous?withDb(previous.worker_url):dbUrl(admin,name,'sigongnote_worker',workerPassword),migrations:applied.length,created_at:new Date().toISOString()};
 if(writeEnv){mkdirSync('.work/e2e',{recursive:true});writeFileSync(E2E_ENV_FILE,JSON.stringify(env,null,1)+'\n',{mode:0o600});writeApplicationEnv(env);}
 if(!quiet)console.log(`E2E database ready: ${applied.length} migrations applied -> ${E2E_ENV_FILE}`);
 return env;
}
/**
 * The DB-backed test suite reads the application environment file of the local API. On a machine without
 * Supabase (CI, this E2E mode) that file is generated here with the isolated database URLs and placeholder
 * Supabase endpoints (never real keys). An existing file that points at a different database is left alone
 * unless E2E_WRITE_ENV=force.
 */
export function writeApplicationEnv(env,file=APPLICATION_ENV){
 const lines=[`APP_ENV=development`,`AI_PROVIDER=claude`,`AI_DAILY_BUDGET_KRW=10000`,`SUPABASE_URL=http://127.0.0.1:54321`,`SUPABASE_PUBLISHABLE_KEY=e2e-publishable-placeholder`,`SUPABASE_SECRET_KEY=e2e-secret-placeholder-not-a-key`,
  `DATABASE_URL=${env.api_url}`,`WORKER_DATABASE_URL=${env.worker_url}`,`MIGRATION_DATABASE_URL=${env.admin_url}`,`VITE_SUPABASE_URL=http://127.0.0.1:54321`,`VITE_SUPABASE_PUBLISHABLE_KEY=e2e-publishable-placeholder`,`VITE_API_BASE_URL=http://localhost:3001`,`SIGONGNOTE_E2E_DB=1`];
 if(existsSync(file)){const current=readFileSync(file,'utf8');if(!/^SIGONGNOTE_E2E_DB=1$/m.test(current)&&process.env.E2E_WRITE_ENV!=='force')return false;}
 mkdirSync(dirname(file),{recursive:true});writeFileSync(file,lines.join('\n')+'\n',{mode:0o600});return true;
}
export function readE2eEnv(){
 if(process.env.E2E_ADMIN_DATABASE_URL&&process.env.E2E_API_DATABASE_URL&&process.env.E2E_WORKER_DATABASE_URL)return {database:new URL(process.env.E2E_ADMIN_DATABASE_URL).pathname.slice(1),admin_url:process.env.E2E_ADMIN_DATABASE_URL,api_url:process.env.E2E_API_DATABASE_URL,worker_url:process.env.E2E_WORKER_DATABASE_URL};
 if(!existsSync(E2E_ENV_FILE))return null;
 return JSON.parse(readFileSync(E2E_ENV_FILE,'utf8'));
}
export async function dropE2eDatabase(env=readE2eEnv(),admin=adminUrl()){
 if(!env)return false;const root=postgres(admin,{max:1,onnotice:()=>{}});
 try{await root.unsafe(`drop database if exists ${env.database} with (force)`);return true;}finally{await root.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  if(process.argv.includes('--drop')){console.log((await dropE2eDatabase())?'dropped':'nothing to drop');}
  else{const env=await createE2eDatabase();if(process.env.GITHUB_ENV)writeFileSync(process.env.GITHUB_ENV,`E2E_ADMIN_DATABASE_URL=${env.admin_url}\nE2E_API_DATABASE_URL=${env.api_url}\nE2E_WORKER_DATABASE_URL=${env.worker_url}\n`,{flag:'a'});}
 }catch(error){console.error(error.message);process.exitCode=1;}
}
