-- A release is ready only when every bundled migration is recorded in this database.
-- Cloud migration tools may prepend their own version and preserve the source version in name.
create function app.release_migrations_applied(required text[]) returns boolean
language sql stable security definer set search_path='' as $$
 select coalesce(cardinality(required) between 1 and 1000
 and not exists(select 1 from unnest(required) x where x is null or x !~ '^[0-9]{14}$')
 and cardinality(required)=(select count(distinct x) from unnest(required) x)
 and not exists(
  select 1 from unnest(required) x where not exists(
   select 1 from supabase_migrations.schema_migrations m
   where coalesce(substring(m.name from '^([0-9]{14})(?:_|$)'),m.version)=x
  )
 ),false)
$$;
revoke all on function app.release_migrations_applied(text[]) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.release_migrations_applied(text[]) to sigongnote_api;
