-- An invalid stored candidate date cannot poison another document's search.
create function app.evidence_event_time(value text,fallback_time timestamptz) returns timestamptz language plpgsql immutable set search_path='' as $$
begin
 if value is null or value !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$' then return fallback_time;end if;
 return value::timestamptz;
exception when others then return fallback_time;
end $$;
revoke all on function app.evidence_event_time(text,timestamptz) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.evidence_event_time(text,timestamptz) to sigongnote_api;
create index fact_semantic_kind on app.fact_candidates(tenant_id,source_revision,(semantic->>'eventKind')) where semantic is not null;
