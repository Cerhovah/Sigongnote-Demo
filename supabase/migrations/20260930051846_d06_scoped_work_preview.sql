-- D06-D07 isolated integration worker scope; same queue and lease rules.
create function app.claim_parse_job_for_tenant(p_worker text, p_lease_seconds integer, p_processor text, p_tenant uuid)
returns table (tenant_id uuid, job_id uuid, lease_token uuid, revision_id uuid,
  expected_sha256 text, processor_version text, attempt_count integer)
language plpgsql security definer set search_path = '' as $$
begin
  if length(p_worker) not between 1 and 128 or p_lease_seconds not between 30 and 300 then
    raise exception 'Invalid worker lease request' using errcode = '23514';
  end if;
  update app.jobs j set state = 'dead', last_error_code = 'LEASE_EXHAUSTED',
    lease_expires_at = null, updated_at = now()
    where j.tenant_id=p_tenant and j.processor_version=p_processor and j.state = 'leased'
      and j.lease_expires_at <= now() and j.attempt_count >= 5;
  return query
    with chosen as (
      select j.tenant_id, j.id from app.jobs j
      where j.tenant_id=p_tenant and j.processor_version=p_processor and j.job_type = 'parse_original'
        and j.attempt_count < 5 and (
          (j.state in ('queued','retry_wait') and j.available_at <= now()) or
          (j.state = 'leased' and j.lease_expires_at <= now()))
      order by j.available_at, j.created_at, j.tenant_id, j.id
      for update skip locked limit 1
    )
    update app.jobs j set state = 'leased', attempt_count = j.attempt_count + 1,
      lease_owner = p_worker, lease_token = gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
    from chosen c where j.tenant_id = c.tenant_id and j.id = c.id
    returning j.tenant_id, j.id, j.lease_token, j.evidence_revision_id,
      j.input_hash, j.processor_version, j.attempt_count;
end;
$$;


revoke all on function app.claim_parse_job_for_tenant(text,integer,text,uuid) from public,anon,authenticated,service_role,sigongnote_api;
grant execute on function app.claim_parse_job_for_tenant(text,integer,text,uuid) to sigongnote_worker;
