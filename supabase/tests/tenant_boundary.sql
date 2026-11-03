-- C03: run against a disposable LOCAL Supabase database. The transaction
-- rolls back synthetic users and business rows even when the assertions pass.
begin;

-- Pinned from reviewed migration definitions through N04. This is NOT populated
-- from the live catalog during tests; new signatures/roles require an explicit review.
create temporary table expected_app_definers(signature text primary key,api boolean,worker boolean,storage_client boolean) on commit drop;
insert into expected_app_definers values
 ('app.document_facts(uuid,uuid)',true,false,false),
 ('app.document_readiness_targets()',true,false,false),
 ('app.operational_facts(uuid,uuid,jsonb)',true,false,false),
 ('app.claim_agent_run(uuid)',true,false,false),
 ('app.agent_chain_usage(uuid,uuid)',true,false,false),
  ('app.purge_strategies(uuid,uuid)',true,false,false),
  ('app.release_migrations_applied(text[])',true,false,false),
 ('app.journal_document_context(uuid,uuid,uuid,bigint)',true,false,false),
 ('app.answer_organization(uuid,uuid,bigint,uuid)',true,false,false),
 ('app.audio_allowed(uuid,uuid,jsonb)',false,false,false),
 ('app.audio_budget(uuid,uuid,uuid,jsonb,integer,integer)',false,true,false),
 ('app.audio_load(uuid,uuid,uuid,jsonb)',false,true,false),
 ('app.audio_evidence_current(uuid,uuid,jsonb)',false,false,false),
 ('app.reindex_audio_correction(uuid,uuid,uuid)',true,false,false),
 ('app.stage_audio_corrections(uuid,uuid,uuid,jsonb)',false,true,false),
 ('app.audio_product_scope(uuid,uuid,uuid,jsonb)',false,true,false),
 ('app.audio_progress(uuid,uuid)',true,false,false),
 ('app.audio_record_receipt(uuid,uuid,uuid,integer,text)',false,true,false),
 ('app.audio_reserve(uuid,uuid,uuid,jsonb,integer,integer,integer,integer)',false,true,false),
 ('app.audio_save(uuid,uuid,uuid,jsonb,jsonb,integer)',false,true,false),
 ('app.begin_evidence_index(uuid,uuid,uuid,jsonb,jsonb)',false,true,false),
 ('app.begin_pdf_evidence_batch(uuid,uuid,uuid,integer,jsonb,jsonb)',false,true,false),
 ('app.pdf_parse_progress(uuid,uuid,uuid,jsonb)',false,true,false),
 ('app.checkpoint_pdf_parse(uuid,uuid,uuid,integer,jsonb,jsonb)',false,true,false),
 ('app.read_pdf_parse_progress(uuid,uuid)',true,false,false),
 ('app.fail_pdf_timeout(uuid,uuid,uuid,integer,jsonb)',false,true,false),
 ('app.resume_pdf_parse(uuid,uuid,uuid,integer)',true,false,false),
 ('app.record_capture_recovery(uuid,uuid,boolean)',true,false,false),
 ('app.capture_recovery_status(uuid)',true,false,false),
 ('app.bootstrap_workspace(uuid,uuid,text,text)',true,false,false),
 ('app.can_insert_original(text)',false,false,true),
 ('app.claim_parse_job_for_tenant(text,integer,text,uuid)',false,true,false),
 ('app.claim_parse_job(text,integer,text)',false,true,false),
 ('app.claim_parse_job(text,integer)',false,true,false),
 ('app.photo_sheet_authorized(uuid,uuid)',false,false,false),
 ('app.claim_delivery(uuid)',true,false,false),
 ('app.finish_delivery_tick(uuid,uuid,uuid,boolean)',true,false,false),
 ('app.wake_delivery(uuid,uuid,text)',true,false,false),
 ('app.claim_photo_sheet(text,uuid)',false,true,false),
 ('app.photo_sheet_input(uuid,uuid,uuid)',false,true,false),
 ('app.complete_photo_sheet(uuid,uuid,uuid,text,bytea,integer)',false,true,false),
 ('app.claim_render_job(text,uuid)',false,true,false),
 ('app.clean_organization_index()',false,false,false),
 ('app.clear_product_ai_source_results()',false,false,false),
 ('app.complete_parse_job_legacy(uuid,uuid,uuid,text)',false,false,false),
 ('app.complete_parse_job(uuid,uuid,uuid,text)',false,true,false),
 ('app.complete_parse_output_before_n02(uuid,uuid,uuid,jsonb,jsonb)',false,false,false),
 ('app.complete_parse_output(uuid,uuid,uuid,jsonb,jsonb)',false,true,false),
 ('app.complete_render_job(uuid,uuid,uuid,text,bytea,bytea)',false,true,false),
 ('app.evidence_chunk_batch(uuid,uuid,integer,integer,jsonb)',false,true,false),
 ('app.extend_parse_job_lease(uuid,uuid,uuid,integer)',false,true,false),
 ('app.fail_parse_job(uuid,uuid,uuid,text,boolean)',false,true,false),
 ('app.finish_product_ai(uuid,uuid,uuid,bigint,jsonb,text,jsonb)',true,true,false),
 ('app.guard_membership_change()',false,false,false),
 ('app.has_tenant_role(uuid,text[])',true,false,false),
 ('app.is_generated_document(uuid,text)',true,false,false),
 ('app.maintenance_status(uuid)',true,false,false),
 ('app.mirror_copy_allowed(uuid,uuid)',true,false,false),
 ('app.next_organization_input(uuid,jsonb)',false,true,false),
 ('app.entity_link_input(uuid,uuid,jsonb)',false,true,false),
 ('app.next_entity_link_input(uuid,jsonb)',false,true,false),
 ('app.save_entity_links(uuid,uuid,text,jsonb,jsonb)',false,true,false),
 ('app.read_entity_links(uuid,uuid,jsonb)',true,false,false),
 ('app.semantic_promotion_input(uuid,uuid,uuid,jsonb)',false,false,false),
 ('app.business_context_input(uuid,uuid,jsonb)',false,false,false),
 ('app.next_business_event_input(uuid,jsonb,jsonb)',false,true,false),
 ('app.save_business_event_projection(uuid,uuid,text,bigint,jsonb,jsonb,jsonb)',false,true,false),
 ('app.claim_business_outbox(uuid)',false,true,false),
 ('app.finish_business_outbox(uuid,uuid,uuid,boolean)',false,true,false),
 ('app.read_business_work(uuid,uuid,jsonb)',true,false,false),
 ('app.correct_folder_bindings(uuid,uuid,jsonb)',true,false,false),
 ('app.next_semantic_promotion(uuid,jsonb)',false,true,false),
 ('app.save_semantic_candidates(uuid,uuid,uuid,text,jsonb,jsonb)',false,true,false),
 ('app.next_semantic_input(jsonb,text,uuid,bigint,uuid[])',false,true,false),
 ('app.organization_failed(uuid,uuid)',false,true,false),
 ('app.organization_input(uuid,uuid,jsonb)',false,false,false),
 ('app.owner_policy_workspaces()',true,false,false),
 ('app.parse_job_input(uuid,uuid,uuid,jsonb)',false,true,false),
 ('app.parse_source_allowed(uuid,uuid,jsonb)',false,false,false),
 ('app.product_ai_scope_allowed(uuid,uuid,uuid,bigint,uuid,text,jsonb)',true,true,false),
 ('app.product_ai_summary()',true,false,false),
 ('app.purge_expired_activity()',true,true,false),
 ('app.improvement_workspaces()',true,false,false),
 ('app.purge_improvements()',true,true,false),
 ('app.improvement_budget_usage(uuid)',true,false,false),
 ('app.purge_learning_cases()',true,true,false),
 ('app.erase_learning_case(uuid,uuid)',true,false,false),
 ('app.record_sync_change()',false,false,false),
 ('app.render_authorized(uuid,uuid)',false,false,false),
 ('app.render_job_input(uuid,uuid,uuid)',false,true,false),
 ('app.reserve_product_ai(uuid,uuid,uuid,text,uuid,bigint,uuid,text,jsonb,bigint)',true,true,false),
 ('app.local_native_revision(uuid,uuid)',false,false,false),
 ('app.local_native_revision_for_read(uuid,uuid)',true,false,false),
 ('app.local_document_source_readable(uuid,uuid)',true,false,false),
 ('app.context_source_snapshot(uuid,text,uuid)',false,false,false),
 ('app.context_source_readable(uuid,text,uuid)',true,false,false),
 ('app.context_learning_source_version(uuid,text,uuid)',true,false,false),
 ('app.context_learning_source_family(uuid,text,uuid)',true,false,false),
 ('app.context_learning_case_current(uuid,uuid)',true,false,false),
 ('app.context_learning_procedure_current(uuid,uuid)',true,false,false),
 ('app.purge_context_learning(uuid)',true,false,false),
 ('app.revoke_context_learning()',false,false,false),
 ('app.work_event_readable(uuid,uuid)',true,false,false),
 ('app.correct_work_event(uuid,uuid,bigint,uuid,text,text)',true,false,false),
 ('app.set_local_context_consent(uuid,bigint,boolean,jsonb)',true,false,false),
 ('app.next_context_input(uuid,integer,boolean)',true,false,false),
 ('app.save_work_events(uuid,uuid,text,uuid,jsonb,uuid,text,text)',true,false,false),
 ('app.mark_work_followup(uuid,uuid,bigint,boolean)',true,false,false),
 ('app.retry_document_render(uuid,uuid)',true,false,false),
 ('app.revision_accessible(uuid,uuid)',true,false,false),
 ('app.field_metadata_readable(uuid,uuid)',true,false,false),
 ('app.save_organization(uuid,uuid,text,jsonb,jsonb)',false,true,false),
 ('app.session_is_active(uuid,uuid)',true,false,false),
 ('app.stage_evidence_chunks(uuid,uuid,uuid,jsonb,jsonb)',false,true,false),
 ('app.stop_capture_source(uuid,uuid,uuid,text)',true,false,false),
 ('app.stop_device_sources(uuid,uuid,uuid)',true,false,false),
 ('app.submit_product_ai(uuid,uuid,uuid)',true,true,false),
 ('app.track_document_order()',false,false,false),
 ('app.voice_used_seconds(uuid)',true,false,false),
 ('app.withdraw_source_evidence()',false,false,false),
 ('app.withdraw_product_ai_evidence()',false,false,false),
 ('app.capture_storage_usage()',true,false,false),
 ('app.guard_capture_storage_quota()',false,false,false);


do $$
declare item record;
begin
  for item in
    select c.oid, c.relname, c.relrowsecurity
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app' and c.relkind in ('r', 'p')
  loop
    if not item.relrowsecurity then
      raise exception 'RLS disabled on app.%', item.relname;
    end if;
    -- These existing support-account records have user scope, not business tenant scope.
    if item.relname in ('field_operators','field_operator_access') and not exists (
      select 1 from pg_attribute where attrelid=item.oid and attname='user_id' and attnotnull and not attisdropped
    ) then raise exception 'Support account key missing on app.%',item.relname; end if;
    if item.relname='field_operators' and has_table_privilege('sigongnote_api',item.oid,'insert,update,delete') then
      raise exception 'API can grant support operator access'; end if;
    if item.relname='field_operator_access' and has_table_privilege('sigongnote_api',item.oid,'select,update,delete') then
      raise exception 'Support access audit privileges expanded'; end if;
    if item.relname not in ('tenants','field_operators','field_operator_access') and not exists (
      select 1 from pg_attribute where attrelid = item.oid
        and attname = 'tenant_id' and not attisdropped
    ) then
      raise exception 'Tenant key missing on app.%', item.relname;
    end if;
    if has_table_privilege('anon', item.oid, 'select,insert,update,delete') or
       has_table_privilege('authenticated', item.oid, 'select,insert,update,delete') or
       has_table_privilege('service_role', item.oid, 'select,insert,update,delete') then
      raise exception 'Direct client/service privilege on app.%', item.relname;
    end if;
  end loop;
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app' and c.relkind = 'm'
  ) then raise exception 'App materialized views need an explicit tenant security design'; end if;
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app' and c.relkind = 'v'
      and (not (coalesce(c.reloptions, array[]::text[]) @> array['security_invoker=true'])
        or not exists (
          select 1 from pg_attribute a where a.attrelid = c.oid
            and a.attname = 'tenant_id' and not a.attisdropped
        )
        or has_table_privilege('anon', c.oid, 'select')
        or has_table_privilege('authenticated', c.oid, 'select')
        or has_table_privilege('service_role', c.oid, 'select'))
  ) then raise exception 'An app view bypasses tenant security'; end if;
  if exists (
    select 1 from pg_constraint fk
    join pg_class target on target.oid = fk.confrelid
    join pg_namespace target_ns on target_ns.oid = target.relnamespace
    join pg_class child on child.oid = fk.conrelid
    join pg_namespace child_ns on child_ns.oid = child.relnamespace
    where fk.contype = 'f' and target_ns.nspname = 'app'
      and child_ns.nspname = 'app' and target.relname not in ('tenants','field_operators')
      and not exists (
        select 1 from unnest(fk.conkey) as key(attnum)
        join pg_attribute a on a.attrelid = child.oid and a.attnum = key.attnum
        where a.attname = 'tenant_id'
      )
  ) then raise exception 'A cross-table app FK omits tenant_id'; end if;
  if exists (select 1 from expected_app_definers e where to_regprocedure(e.signature) is null) then
    raise exception 'Expected private function missing: apply matching migrations'; end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    left join expected_app_definers e on e.signature=p.oid::regprocedure::text
    where n.nspname='app' and p.prosecdef and (e.signature is null
      or not coalesce(p.proconfig @> array['search_path=""'],false)
      or has_function_privilege('anon',p.oid,'execute')
      or has_function_privilege('service_role',p.oid,'execute')
      or has_function_privilege('authenticated',p.oid,'execute') is distinct from e.storage_client
      or has_function_privilege('sigongnote_api',p.oid,'execute') is distinct from e.api
      or has_function_privilege('sigongnote_worker',p.oid,'execute') is distinct from e.worker))
  then raise exception 'Unreviewed private function signature, search path or EXECUTE privilege'; end if;
  if has_column_privilege('sigongnote_api','app.capture_sources',
       'server_upload_consent','update') or
     has_column_privilege('sigongnote_api','app.capture_sources',
       'active','update') or
     has_column_privilege('sigongnote_api','app.capture_sources',
       'permission','update') then
    raise exception 'API role can forge source consent or OS permission';
  end if;
end;
$$;

insert into auth.users (id, aud, role, email, created_at, updated_at) values
  ('11111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated', 'fixture-owner-a@example.invalid', now(), now()),
  ('22222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated', 'fixture-owner-b@example.invalid', now(), now()),
  ('33333333-3333-4333-8333-333333333333', 'authenticated', 'authenticated', 'fixture-viewer-a@example.invalid', now(), now());

insert into app.tenants (id, display_name) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'fixture tenant A'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'fixture tenant B');
insert into app.memberships (id, tenant_id, user_id, role) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'owner'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222', 'owner'),
  ('aaaaaaaa-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '33333333-3333-4333-8333-333333333333', 'viewer');
insert into app.projects (id, tenant_id, display_name) values
  ('aaaaaaaa-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'fixture site A'),
  ('bbbbbbbb-1111-4111-8111-111111111111', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'secret site B');
insert into app.work_orders (id, tenant_id, project_id, display_name) values
  ('bbbbbbbb-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'bbbbbbbb-1111-4111-8111-111111111111', 'secret job B');

do $$
begin
  if has_schema_privilege('anon', 'app', 'usage') or
     has_schema_privilege('authenticated', 'app', 'usage') or
     has_schema_privilege('service_role', 'app', 'usage') then
    raise exception 'Client or service role can access private app schema';
  end if;
  if has_table_privilege('authenticated', 'app.projects', 'select') then
    raise exception 'Client role can read business table';
  end if;
end;
$$;

set local role sigongnote_api;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
do $$
declare n integer;
begin
  select count(*) into n from app.projects;
  if n <> 1 then raise exception 'Owner A saw wrong project count: %', n; end if;
  select count(*) into n from app.projects
    where id = 'bbbbbbbb-1111-4111-8111-111111111111';
  if n <> 0 then raise exception 'Cross-tenant guessed ID leaked'; end if;
  select count(*) into n from app.projects where display_name ilike '%secret%';
  if n <> 0 then raise exception 'Cross-tenant search leaked'; end if;
  select count(*) into n from app.work_orders;
  if n <> 0 then raise exception 'Cross-tenant work order leaked'; end if;
  update app.projects set display_name = 'tampered'
    where id = 'bbbbbbbb-1111-4111-8111-111111111111';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'Cross-tenant update succeeded'; end if;
end;
$$;

do $$
begin
  begin
    insert into app.projects (tenant_id, display_name)
      values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'forged');
    raise exception 'Cross-tenant insert succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into app.work_orders (tenant_id, project_id, display_name)
      values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              'bbbbbbbb-1111-4111-8111-111111111111', 'forged relation');
    raise exception 'Cross-tenant composite FK accepted';
  exception when foreign_key_violation then null;
  end;
  begin
    update app.memberships set active = false, revoked_at = now()
      where id = 'aaaaaaaa-0000-4000-8000-000000000001';
    raise exception 'Last owner revocation succeeded';
  exception when check_violation then null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', true);
do $$
begin
  if (select count(*) from app.projects) <> 1 then
    raise exception 'Viewer A cannot read own company';
  end if;
  begin
    insert into app.projects (tenant_id, display_name)
      values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'viewer forged');
    raise exception 'Viewer inserted a project';
  exception when insufficient_privilege then null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
update app.memberships set active = false, revoked_at = now()
  where tenant_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    and user_id = '33333333-3333-4333-8333-333333333333';
select set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', true);
do $$
begin
  if (select count(*) from app.projects) <> 0 or
     (select count(*) from app.memberships) <> 0 then
    raise exception 'Revoked member retained tenant access';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
do $$
begin
  if (select count(*) from app.projects) <> 1 or
     (select count(*) from app.projects where display_name = 'secret site B') <> 1 then
    raise exception 'Owner B company scope failed';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000000', true);
do $$
begin
  if (select count(*) from app.projects) <> 0 or
     (select count(*) from app.tenants) <> 0 then
    raise exception 'Unknown user saw business data';
  end if;
end;
$$;

rollback;
