-- v1 sources keep their original consent. v2 grants carry the scope and the
-- server-selected processing policy; neither is editable in place by the API.
alter table app.capture_sources add column scope jsonb;
alter table app.capture_sources add column processing_policy jsonb;
alter table app.capture_sources add constraint capture_scope_version check (
 (consent_version=1 and scope is null and processing_policy is null) or
 (consent_version=2 and scope is not null and processing_policy is not null
  and jsonb_typeof(scope)='object' and jsonb_typeof(processing_policy)='object'
  and coalesce(scope->>'rule_version'='1'
   and scope->>'fingerprint_algorithm'='hmac-sha256-device-v1'
   and scope->>'scope_mode' in ('work_dedicated','selected_items','mixed_hold')
   and scope->>'history_mode' in ('all','since','selected')
   and ((scope->>'history_mode'='since')=(scope->>'history_since' is not null))
   and scope->>'processing_policy_id'=processing_policy->>'id'
   and processing_policy->>'purpose'='work_records'
   and (not external_ai_consent or processing_policy->>'external_processing'='true')
   and (scope->>'scope_mode'<>'mixed_hold' or not server_upload_consent)
   and case kind
    when 'folder' then scope->>'capture_method' in ('saf_tree','filesystem')
    when 'photos' then scope->>'capture_method' in ('saf_tree','filesystem','selected_media')
    when 'call_recording' then scope->>'capture_method' in ('saf_tree','filesystem')
    when 'notifications' then scope->>'capture_method'='notification'
    when 'manual_share' then scope->>'capture_method'='manual_share'
    else scope->>'capture_method'='sms_provider' end,false)));
alter table app.consent_grants add column scope jsonb;
alter table app.consent_grants add column processing_policy jsonb;
create function app.snapshot_capture_scope() returns trigger
language plpgsql set search_path='' as $$
begin
 select s.scope,s.processing_policy into new.scope,new.processing_policy
 from app.capture_sources s where s.tenant_id=new.tenant_id and s.id=new.source_id;
 if not found then raise exception 'Source missing' using errcode='23503'; end if;
 return new;
end;
$$;
revoke all on function app.snapshot_capture_scope() from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;
create trigger consent_scope_snapshot before insert on app.consent_grants
for each row execute function app.snapshot_capture_scope();

alter table app.upload_intents drop constraint upload_intents_rejection_reason_check;
alter table app.upload_intents add constraint upload_intents_rejection_reason_check
 check (rejection_reason in ('hash_mismatch','expired','stale_document','source_revoked','client_abandoned','scope_mismatch'));
