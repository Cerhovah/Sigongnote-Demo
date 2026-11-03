-- C13: a user may create only the private object reserved by their live
-- upload intent. The server still verifies every byte before acknowledging it.
create function app.can_insert_original(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.upload_intents i
      join app.memberships m on m.tenant_id = i.tenant_id
        and m.user_id = i.actor_id
      left join app.capture_sources s on s.tenant_id = i.tenant_id
        and s.id = i.source_id
      left join app.devices d on d.tenant_id = s.tenant_id
        and d.id = s.device_id
    where i.storage_key = p_name and i.actor_id = auth.uid()
      and i.status = 'prepared' and i.expires_at > now()
      and m.active and m.revoked_at is null and m.role in ('owner','operator')
      and (i.source_id is null or (s.active and d.active
        and s.server_upload_consent and s.generation = i.source_generation))
  )
$$;
revoke all on function app.can_insert_original(text) from public, anon, service_role;
grant execute on function app.can_insert_original(text) to authenticated;
create policy original_upload_reserved on storage.objects
  for insert to authenticated
  with check (bucket_id = 'sigongnote-originals' and app.can_insert_original(name));
