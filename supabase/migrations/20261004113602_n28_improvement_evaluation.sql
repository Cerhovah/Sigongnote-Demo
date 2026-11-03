SET local check_function_bodies = off;

CREATE TABLE "app"."improvement_datasets" (
  "tenant_id"   uuid                     NOT NULL,
  "id"          uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "owner_id"    uuid                     NOT NULL,
  "members"     jsonb                    NOT NULL,
  "criteria"    jsonb                    NOT NULL,
  "fingerprint" text                     NOT NULL,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "improvement_datasets_criteria_check" CHECK ((jsonb_typeof(criteria) = 'object'::text)),
  CONSTRAINT "improvement_datasets_fingerprint_check" CHECK ((fingerprint ~ '^[a-f0-9]{64}$'::text)),
  CONSTRAINT "improvement_datasets_members_check"
    CHECK (((jsonb_typeof(members) = 'array'::text) AND ((jsonb_array_length(members) >= 2) AND (jsonb_array_length(members) <= 50)))),
  CONSTRAINT "improvement_datasets_pkey" PRIMARY KEY (tenant_id, id),
  CONSTRAINT "improvement_datasets_tenant_id_fingerprint_key" UNIQUE (tenant_id, fingerprint)
);

ALTER TABLE "app"."improvement_datasets"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "app"."improvement_experiments" (
  "tenant_id"      uuid                     NOT NULL,
  "id"             uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "version_id"     uuid                     NOT NULL,
  "case_id"        uuid                     NOT NULL,
  "case_version"   integer                  NOT NULL,
  "phase"          text                     NOT NULL,
  "adapter"        text                     NOT NULL,
  "state"          text                     NOT NULL,
  "prediction"     jsonb,
  "reserved_minor" integer                  NOT NULL DEFAULT 0,
  "actual_minor"   integer,
  "created_at"     timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "improvement_experiments_actual_minor_check" CHECK ((actual_minor >= 0)),
  CONSTRAINT "improvement_experiments_adapter_check" CHECK (((length(adapter) >= 1) AND (length(adapter) <= 100))),
  CONSTRAINT "improvement_experiments_phase_check" CHECK ((phase = ANY (ARRAY['test'::text, 'shadow'::text, 'local_shadow'::text]))),
  CONSTRAINT "improvement_experiments_pkey" PRIMARY KEY (tenant_id, id),
  CONSTRAINT "improvement_experiments_reserved_minor_check" CHECK ((reserved_minor >= 0)),
  CONSTRAINT "improvement_experiments_state_check" CHECK ((state = ANY (ARRAY['submitted'::text, 'completed'::text, 'unknown'::text, 'rejected'::text]))),
  CONSTRAINT "improvement_experiments_tenant_id_version_id_case_id_case_v_key" UNIQUE (tenant_id, version_id, case_id, case_version, phase, adapter)
);

ALTER TABLE "app"."improvement_experiments"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "app"."improvement_heads" (
  "tenant_id"   uuid    NOT NULL,
  "owner_id"    uuid    NOT NULL,
  "active_id"   uuid,
  "previous_id" uuid,
  "version"     integer NOT NULL DEFAULT 1,
  "delegation"  jsonb   NOT NULL DEFAULT '{"scope": "quality_interpretation", "allowed": false, "max_calls": 100, "max_cost_minor": 0, "criteria_version": "work-eval-v1"}'::jsonb,
  CONSTRAINT "improvement_heads_pkey" PRIMARY KEY (tenant_id),
  CONSTRAINT "improvement_heads_version_check" CHECK ((version > 0))
);

ALTER TABLE "app"."improvement_heads"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "app"."improvement_versions" (
  "tenant_id"      uuid                     NOT NULL,
  "id"             uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "dataset_id"     uuid                     NOT NULL,
  "spec"           jsonb                    NOT NULL,
  "state"          text                     NOT NULL DEFAULT 'evaluating'::text,
  "metrics"        jsonb                    NOT NULL DEFAULT '{}'::jsonb,
  "shadow_members" jsonb                    NOT NULL DEFAULT '[]'::jsonb,
  "fingerprint"    text                     NOT NULL,
  "approved_by"    uuid,
  "approved_at"    timestamp with time zone,
  "invalid_reason" text,
  "created_at"     timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "improvement_versions_fingerprint_check" CHECK ((fingerprint ~ '^[a-f0-9]{64}$'::text)),
  CONSTRAINT "improvement_versions_pkey" PRIMARY KEY (tenant_id, id),
  CONSTRAINT "improvement_versions_spec_check" CHECK ((jsonb_typeof(spec) = 'object'::text)),
  CONSTRAINT "improvement_versions_state_check"
    CHECK ((state = ANY (ARRAY['evaluating'::text, 'awaiting_shadow'::text, 'proposed'::text, 'active'::text, 'superseded'::text, 'rejected'::text, 'rolled_back'::text]))),
  CONSTRAINT "improvement_versions_tenant_id_fingerprint_key" UNIQUE (tenant_id, fingerprint)
);

ALTER TABLE "app"."improvement_versions"
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE "app"."agent_runs"
  ADD COLUMN "improvement_version" uuid;

ALTER TABLE "app"."work_decision_cases"
  ADD COLUMN "improvement_version" uuid;

CREATE OR REPLACE FUNCTION app.capture_learning_decision()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
declare d app.decisions%rowtype;c app.work_decision_cases%rowtype;g uuid;a uuid;refs jsonb;
begin
 select * into d from app.decisions where tenant_id=new.tenant_id and id=new.decision_id;
 a:=coalesce(d.actor_id,d.grantor_user_id);
 select learning_consent_id into g from app.activity_consents where tenant_id=new.tenant_id and user_id=a and learning_allowed for share;
 if g is null then return new;end if;
 select * into c from app.work_decision_cases where tenant_id=d.tenant_id and id=d.target_ids[1];
 if c.id is null then return new;end if;
 select jsonb_agg(distinct r) into refs from app.work_command_effects e join app.decisions x on x.tenant_id=e.tenant_id and x.id=e.decision_id join app.work_decision_cases w on w.tenant_id=x.tenant_id and w.id=x.target_ids[1],jsonb_array_elements(w.source_refs) r where e.tenant_id=new.tenant_id and e.context_id=new.context_id;
 if not app.learning_scope_allowed(d.tenant_id,a,g,refs) then return new;end if;
 insert into app.decision_examples(tenant_id,decision_id,scope_type,proposal,answer,result,learning_actor_id,learning_consent_id,learning_state,learning_snapshot)
 values(new.tenant_id,d.id,'once',c.proposal,new.effects,new.after_state,a,g,'unreviewed',
 jsonb_build_object('source_refs',refs,'project_id',c.project_id,'context_id',c.context_id,'prompt',c.prompt,'before_state',new.before_state,'actor_kind',d.actor_kind,'decision_at',d.created_at,'rule_version','work-command-v1','period',to_char(d.created_at at time zone 'Asia/Seoul','YYYY-MM'),'transaction_group',c.context_id,'improvement_version',c.improvement_version))
 on conflict(tenant_id,decision_id) where learning_consent_id is not null do nothing;
 return new;
end $function$;

CREATE OR REPLACE FUNCTION app.improvement_budget_usage (
  t uuid
)
  RETURNS jsonb
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
 select jsonb_build_object('calls',count(*),'cost',coalesce(sum(coalesce(actual_minor,reserved_minor)),0),'unknown',count(*) filter(where actual_minor is null)) from app.improvement_experiments where tenant_id=t and app.has_tenant_role(t,array['owner']) and created_at>=(date_trunc('day',now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul')
$function$;

CREATE OR REPLACE FUNCTION app.improvement_members_allowed (
  t uuid,
  m jsonb
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
 select app.has_tenant_role(t,array['owner']) and jsonb_typeof(m)='array' and jsonb_array_length(m)>0 and not exists(
  select 1 from jsonb_array_elements(m) x where not exists(select 1 from app.decision_examples e where e.tenant_id=t and e.id=(x->>'id')::uuid and e.learning_version=(x->>'version')::integer and e.learning_state in ('confirmed','correction') and e.created_at>now()-interval '90 days'))
$function$;

CREATE OR REPLACE FUNCTION app.improvement_version_allowed (
  t uuid,
  v uuid
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
 select v is null or exists(select 1 from app.improvement_versions x where x.tenant_id=t and x.id=v and x.state in ('active','superseded') and not exists(select 1 from app.decision_examples e where e.tenant_id=t and e.learning_state='correction' and e.learning_snapshot->>'improvement_version'=v::text))
$function$;

CREATE OR REPLACE FUNCTION app.improvement_workspaces()
  RETURNS TABLE (
    tenant_id uuid,
    owner_id  uuid
  )
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
 select distinct h.tenant_id,h.owner_id from app.improvement_heads h join app.memberships m on m.tenant_id=h.tenant_id and m.user_id=h.owner_id where m.role='owner' and m.active and m.revoked_at is null
$function$;

CREATE OR REPLACE FUNCTION app.purge_improvements()
  RETURNS bigint
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
 with erased as(update app.improvement_versions v set spec='{"scope":"quality_interpretation","prompt_version":"evidence-quality-v1","rules":[]}',metrics='{}',state='rolled_back',invalid_reason='source_unavailable'
 where invalid_reason is distinct from 'source_unavailable' and exists(select 1 from app.improvement_datasets d,jsonb_array_elements(d.members||v.shadow_members) x where d.tenant_id=v.tenant_id and d.id=v.dataset_id and not exists(
  select 1 from app.decision_examples e join app.activity_consents c on c.tenant_id=e.tenant_id and c.user_id=e.learning_actor_id and c.learning_allowed and c.learning_consent_id=e.learning_consent_id
  where e.tenant_id=d.tenant_id and e.id=(x->>'id')::uuid and e.learning_state<>'deleted' and e.created_at>now()-interval '90 days' and not exists(select 1 from jsonb_array_elements(e.learning_snapshot->'source_refs') r join app.evidence_retention_tasks task on task.tenant_id=e.tenant_id and task.revision_id=(r->>'revision')::uuid)
 )) returning tenant_id,id),predictions as(update app.improvement_experiments e set prediction=null from erased v where e.tenant_id=v.tenant_id and e.version_id=v.id returning 1) select count(*) from erased
$function$;

ALTER TABLE "app"."improvement_datasets"
  ADD CONSTRAINT "improvement_datasets_owner_id_fkey" FOREIGN KEY (owner_id) REFERENCES auth.users(id);

ALTER TABLE "app"."improvement_datasets"
  ADD CONSTRAINT "improvement_datasets_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES app.tenants(id);

ALTER TABLE "app"."improvement_experiments"
  ADD CONSTRAINT "improvement_experiments_tenant_id_case_id_fkey" FOREIGN KEY (tenant_id, case_id) REFERENCES app.decision_examples(tenant_id, id);

ALTER TABLE "app"."improvement_heads"
  ADD CONSTRAINT "improvement_heads_owner_id_fkey" FOREIGN KEY (owner_id) REFERENCES auth.users(id);

ALTER TABLE "app"."improvement_heads"
  ADD CONSTRAINT "improvement_heads_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES app.tenants(id);

ALTER TABLE "app"."improvement_versions"
  ADD CONSTRAINT "improvement_versions_approved_by_fkey" FOREIGN KEY (approved_by) REFERENCES auth.users(id);

ALTER TABLE "app"."agent_runs"
  ADD CONSTRAINT "agent_runs_tenant_id_improvement_version_fkey" FOREIGN KEY (tenant_id, improvement_version) REFERENCES app.improvement_versions(tenant_id, id);

ALTER TABLE "app"."improvement_experiments"
  ADD CONSTRAINT "improvement_experiments_tenant_id_version_id_fkey" FOREIGN KEY (tenant_id, version_id) REFERENCES app.improvement_versions(tenant_id, id);

ALTER TABLE "app"."improvement_heads"
  ADD CONSTRAINT "improvement_heads_tenant_id_active_id_fkey" FOREIGN KEY (tenant_id, active_id) REFERENCES app.improvement_versions(tenant_id, id);

ALTER TABLE "app"."improvement_heads"
  ADD CONSTRAINT "improvement_heads_tenant_id_previous_id_fkey" FOREIGN KEY (tenant_id, previous_id) REFERENCES app.improvement_versions(tenant_id, id);

ALTER TABLE "app"."improvement_versions"
  ADD CONSTRAINT "improvement_versions_tenant_id_dataset_id_fkey" FOREIGN KEY (tenant_id, dataset_id) REFERENCES app.improvement_datasets(tenant_id, id);

ALTER TABLE "app"."work_decision_cases"
  ADD CONSTRAINT "work_decision_cases_tenant_id_improvement_version_fkey" FOREIGN KEY (tenant_id, improvement_version) REFERENCES app.improvement_versions(tenant_id, id);

CREATE INDEX improvement_pending ON app.improvement_versions USING btree (tenant_id, created_at)
  WHERE (state = ANY (ARRAY['evaluating'::text, 'awaiting_shadow'::text]));

CREATE POLICY "owner_insert" ON "app"."improvement_datasets"
  FOR INSERT
  TO "sigongnote_api"
  WITH CHECK (app.has_tenant_role(tenant_id, ARRAY['owner'::text]));

CREATE POLICY "owner_read" ON "app"."improvement_datasets"
  FOR SELECT
  TO "sigongnote_api"
  USING (app.improvement_members_allowed(tenant_id, members));

CREATE POLICY "owner_insert" ON "app"."improvement_experiments"
  FOR INSERT
  TO "sigongnote_api"
  WITH CHECK (app.has_tenant_role(tenant_id, ARRAY['owner'::text]));

CREATE POLICY "owner_read" ON "app"."improvement_experiments"
  FOR SELECT
  TO "sigongnote_api"
  USING (((EXISTS ( SELECT 1
   FROM app.improvement_versions v
  WHERE ((v.tenant_id = improvement_experiments.tenant_id) AND (v.id = improvement_experiments.version_id)))) AND
    app.improvement_members_allowed(tenant_id, jsonb_build_array(jsonb_build_object('id', case_id, 'version', case_version)))));

CREATE POLICY "owner_update" ON "app"."improvement_experiments"
  FOR UPDATE
  TO "sigongnote_api"
  USING (app.has_tenant_role(tenant_id, ARRAY['owner'::text]))
  WITH CHECK (app.has_tenant_role(tenant_id, ARRAY['owner'::text]));

CREATE POLICY "owner_insert" ON "app"."improvement_heads"
  FOR INSERT
  TO "sigongnote_api"
  WITH CHECK (app.has_tenant_role(tenant_id, ARRAY['owner'::text]));

CREATE POLICY "owner_read" ON "app"."improvement_heads"
  FOR SELECT
  TO "sigongnote_api"
  USING (app.has_tenant_role(tenant_id, ARRAY['owner'::text]));

CREATE POLICY "owner_update" ON "app"."improvement_heads"
  FOR UPDATE
  TO "sigongnote_api"
  USING (app.has_tenant_role(tenant_id, ARRAY['owner'::text]))
  WITH CHECK (app.has_tenant_role(tenant_id, ARRAY['owner'::text]));

CREATE POLICY "owner_insert" ON "app"."improvement_versions"
  FOR INSERT
  TO "sigongnote_api"
  WITH CHECK (app.has_tenant_role(tenant_id, ARRAY['owner'::text]));

CREATE POLICY "owner_read" ON "app"."improvement_versions"
  FOR SELECT
  TO "sigongnote_api"
  USING (((EXISTS ( SELECT 1
   FROM app.improvement_datasets d
  WHERE ((d.tenant_id = improvement_versions.tenant_id) AND (d.id = improvement_versions.dataset_id)))) AND
    ((shadow_members = '[]'::jsonb) OR app.improvement_members_allowed(tenant_id, shadow_members))));

CREATE POLICY "owner_update" ON "app"."improvement_versions"
  FOR UPDATE
  TO "sigongnote_api"
  USING (app.has_tenant_role(tenant_id, ARRAY['owner'::text]))
  WITH CHECK (app.has_tenant_role(tenant_id, ARRAY['owner'::text]));

REVOKE ALL ON FUNCTION "app"."improvement_budget_usage"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "app"."improvement_budget_usage"(uuid) TO "postgres", "sigongnote_api";

REVOKE ALL ON FUNCTION "app"."improvement_members_allowed"(uuid, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "app"."improvement_members_allowed"(uuid, jsonb) TO "postgres", "sigongnote_api";

REVOKE ALL ON FUNCTION "app"."improvement_version_allowed"(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "app"."improvement_version_allowed"(uuid, uuid) TO "postgres", "sigongnote_api";

REVOKE ALL ON FUNCTION "app"."improvement_workspaces"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "app"."improvement_workspaces"() TO "postgres", "sigongnote_api";

REVOKE ALL ON FUNCTION "app"."purge_improvements"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "app"."purge_improvements"() TO "postgres", "sigongnote_api", "sigongnote_worker";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "app"."improvement_datasets" TO "postgres";

GRANT INSERT, SELECT ON TABLE "app"."improvement_datasets" TO "sigongnote_api";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "app"."improvement_experiments" TO "postgres";

GRANT UPDATE ("actual_minor") ON TABLE "app"."improvement_experiments" TO "sigongnote_api";

GRANT UPDATE ("prediction") ON TABLE "app"."improvement_experiments" TO "sigongnote_api";

GRANT UPDATE ("state") ON TABLE "app"."improvement_experiments" TO "sigongnote_api";

GRANT INSERT, SELECT ON TABLE "app"."improvement_experiments" TO "sigongnote_api";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "app"."improvement_heads" TO "postgres";

GRANT UPDATE ("active_id") ON TABLE "app"."improvement_heads" TO "sigongnote_api";

GRANT UPDATE ("delegation") ON TABLE "app"."improvement_heads" TO "sigongnote_api";

GRANT UPDATE ("owner_id") ON TABLE "app"."improvement_heads" TO "sigongnote_api";

GRANT UPDATE ("previous_id") ON TABLE "app"."improvement_heads" TO "sigongnote_api";

GRANT UPDATE ("version") ON TABLE "app"."improvement_heads" TO "sigongnote_api";

GRANT INSERT, SELECT ON TABLE "app"."improvement_heads" TO "sigongnote_api";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "app"."improvement_versions" TO "postgres";

GRANT UPDATE ("approved_at") ON TABLE "app"."improvement_versions" TO "sigongnote_api";

GRANT UPDATE ("approved_by") ON TABLE "app"."improvement_versions" TO "sigongnote_api";

GRANT UPDATE ("invalid_reason") ON TABLE "app"."improvement_versions" TO "sigongnote_api";

GRANT UPDATE ("metrics") ON TABLE "app"."improvement_versions" TO "sigongnote_api";

GRANT UPDATE ("shadow_members") ON TABLE "app"."improvement_versions" TO "sigongnote_api";

GRANT UPDATE ("state") ON TABLE "app"."improvement_versions" TO "sigongnote_api";

GRANT INSERT, SELECT ON TABLE "app"."improvement_versions" TO "sigongnote_api";

