-- N23 trusted SMS activation; source consent and original bytes remain unchanged.
alter table app.capture_sources add column sms_activation jsonb;
create function app.guard_sms_activation() returns trigger language plpgsql set search_path='' as $body$
begin
 if (TG_OP='INSERT' and new.sms_activation is not null) or (TG_OP='UPDATE' and new.sms_activation is distinct from old.sms_activation) then
  if current_user not in ('postgres','supabase_admin') then raise insufficient_privilege using message='SMS activation requires independent operator evidence'; end if;
 end if;
 return new;
end $body$;
revoke all on function app.guard_sms_activation() from public,anon,authenticated;
create trigger guard_sms_activation before insert or update on app.capture_sources for each row execute function app.guard_sms_activation();
