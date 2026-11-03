-- One pre-upgrade snapshot inside this existing database, not a disaster-recovery backup.
-- Captures app data, Storage metadata and Auth identifiers, never sessions/credentials.
-- Do not rerun with the same name: preserving the first snapshot is intentional.
create schema sigongnote_before_pilot_20261002;
revoke all on schema sigongnote_before_pilot_20261002 from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;
create table sigongnote_before_pilot_20261002.manifest(schema_name text,table_name text,row_count bigint,recorded_at timestamptz default now(),expires_at timestamptz default now()+interval '14 days');
do $snapshot$
declare t record; n bigint;
begin
 for t in select schemaname,tablename from pg_tables where schemaname in ('app','storage') order by schemaname,tablename loop
  execute format('create table sigongnote_before_pilot_20261002.%I as table %I.%I',t.schemaname||'__'||t.tablename,t.schemaname,t.tablename);
  execute format('select count(*) from %I.%I',t.schemaname,t.tablename) into n;
  insert into sigongnote_before_pilot_20261002.manifest(schema_name,table_name,row_count) values(t.schemaname,t.tablename,n);
 end loop;
end
$snapshot$;
-- An identity cross-reference only. Never restore Auth credentials from this snapshot.
create table sigongnote_before_pilot_20261002.auth__users as
 select id,created_at,updated_at from auth.users;
create table sigongnote_before_pilot_20261002.auth__identities as
 select id,user_id,provider,created_at,updated_at from auth.identities;
insert into sigongnote_before_pilot_20261002.manifest(schema_name,table_name,row_count)
 select 'auth','users',count(*) from auth.users union all
 select 'auth','identities',count(*) from auth.identities;
revoke all on all tables in schema sigongnote_before_pilot_20261002 from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;
