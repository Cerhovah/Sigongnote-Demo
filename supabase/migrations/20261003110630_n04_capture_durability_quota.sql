-- Decimal 100 GB per authenticated user across companies, including concurrent uploads.
-- The intent itself is the reservation; completed revisions remain charged once per content.
create function app.capture_storage_usage() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('limit_bytes',100000000000::bigint,
  'used_bytes',coalesce(sum(bytes) filter(where complete),0)::bigint,
  'reserved_bytes',coalesce(sum(bytes) filter(where not complete),0)::bigint)
 from (select tenant_id,claimed_sha256,claimed_byte_length bytes,bool_or(status='verified') complete
  from app.upload_intents where actor_id=auth.uid()
   and (status='verified' or (status='prepared' and expires_at>now()))
  group by tenant_id,claimed_sha256,claimed_byte_length) content
$$;
revoke all on function app.capture_storage_usage() from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.capture_storage_usage() to sigongnote_api;

create function app.guard_capture_storage_quota() returns trigger language plpgsql security definer set search_path='' as $$
declare used bigint;
begin
 if new.actor_id is distinct from auth.uid() then raise exception 'capture actor mismatch' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('capture-storage:'||new.actor_id::text,0));
 select coalesce(sum(bytes),0) into used from (
  select tenant_id,claimed_sha256,claimed_byte_length bytes from app.upload_intents
  where actor_id=new.actor_id and (status='verified' or (status='prepared' and expires_at>now()))
  group by tenant_id,claimed_sha256,claimed_byte_length
 ) current_content;
 if not exists(select 1 from app.upload_intents where actor_id=new.actor_id and tenant_id=new.tenant_id
  and claimed_sha256=new.claimed_sha256 and claimed_byte_length=new.claimed_byte_length
  and (status='verified' or (status='prepared' and expires_at>now()))) then used:=used+new.claimed_byte_length;end if;
 if used>100000000000 then raise exception 'capture storage quota reached' using errcode='P0001';end if;
 return new;
end $$;
revoke all on function app.guard_capture_storage_quota() from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;
create trigger capture_storage_quota before insert on app.upload_intents for each row execute function app.guard_capture_storage_quota();
