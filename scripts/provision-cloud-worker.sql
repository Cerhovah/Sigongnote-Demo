-- Operator-only, for the existing approved deployment. No plaintext credential output.
-- The password stays in administrator-only Vault until copied to the host secret store.
do $provision$
declare role_info record; credential text; existing integer;
begin
 if coalesce(current_setting('pgaudit.log',true),'none') <> 'none'
    or current_setting('pg_stat_statements.track',true)='all'
    or current_setting('auto_explain.log_nested_statements',true)='on' then
  raise exception 'Nested SQL logging requires operator review';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('sigongnote-worker-provision',0));
 select * into strict role_info from pg_roles where rolname='sigongnote_worker';
 if role_info.rolsuper or role_info.rolbypassrls or role_info.rolcreaterole or role_info.rolcreatedb
    or role_info.rolreplication or exists(select 1 from pg_auth_members where member=role_info.oid)
    or has_schema_privilege('sigongnote_worker','vault','USAGE') then
  raise exception 'Worker role privileges require operator review';
 end if;
 select count(*) into existing from vault.secrets where name='sigongnote_worker_runtime_password';
 if existing=0 and not role_info.rolcanlogin then
  credential:=encode(extensions.gen_random_bytes(48),'hex');
  begin
   perform vault.create_secret(credential,'sigongnote_worker_runtime_password','Dedicated worker runtime login; operator access only');
   execute format('alter role sigongnote_worker login password %L connection limit 4',credential);
  exception when others then
   credential:=null;raise exception 'Worker credential provisioning failed';
  end;
  credential:=null;
  alter role sigongnote_worker set statement_timeout='30s';
 elsif existing=1 and role_info.rolcanlogin and role_info.rolconnlimit=4
       and 'statement_timeout=30s'=any(coalesce(role_info.rolconfig,array[]::text[])) then null;
 else raise exception 'Worker credential state mismatch; no credential changed';
 end if;
end
$provision$;
