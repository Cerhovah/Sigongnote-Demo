SET local check_function_bodies = off;

DROP POLICY "tenant_read" ON "app"."decision_examples";

ALTER TABLE "app"."activity_consents"
  ADD COLUMN "learning_allowed" boolean NOT NULL DEFAULT false;

ALTER TABLE "app"."activity_consents"
  ADD COLUMN "learning_consent_id" uuid NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE "app"."activity_consents"
  ADD COLUMN "learning_since" timestamp WITH time zone NOT NULL DEFAULT now();

ALTER TABLE "app"."decision_examples"
  ADD COLUMN "learning_consent_id" uuid;

ALTER TABLE "app"."decision_examples"
  ADD COLUMN "learning_actor_id" uuid;

ALTER TABLE "app"."decision_examples"
  ADD COLUMN "learning_state" text NOT NULL DEFAULT 'policy_only'::text;

ALTER TABLE "app"."decision_examples"
  ADD COLUMN "learning_version" integer NOT NULL DEFAULT 1;

ALTER TABLE "app"."decision_examples"
  ADD COLUMN "learning_reason" text;

ALTER TABLE "app"."decision_examples"
  ADD COLUMN "learning_reviewed_by" uuid;

ALTER TABLE "app"."decision_examples"
  ADD COLUMN "learning_reviewed_at" timestamp WITH time zone;

ALTER TABLE "app"."decision_examples"
  ADD COLUMN "learning_snapshot" jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "app"."decision_examples"
  ADD COLUMN "learning_history" jsonb NOT NULL DEFAULT '[]'::jsonb;

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
 jsonb_build_object('source_refs',refs,'project_id',c.project_id,'context_id',c.context_id,'prompt',c.prompt,'before_state',new.before_state,'actor_kind',d.actor_kind,'decision_at',d.created_at,'rule_version','work-command-v1','period',to_char(d.created_at at time zone 'Asia/Seoul','YYYY-MM'),'transaction_group',c.context_id))
 on conflict(tenant_id,decision_id) where learning_consent_id is not null do nothing;
 return new;
end $function$;

CREATE OR REPLACE FUNCTION app.erase_learning_case (
  t       uuid,
  case_id uuid DEFAULT NULL::uuid
)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare n integer;
begin
 if auth.uid() is null or not app.has_tenant_role(t,array['owner']) then raise exception 'learning scope unavailable' using errcode='42501';end if;
 update app.decision_examples set proposal='{}',answer='{}',result='{}',learning_snapshot='{}',learning_history='[]',learning_reason=null,learning_state='deleted',learning_version=learning_version+1,learning_reviewed_at=now(),learning_reviewed_by=auth.uid()
 where tenant_id=t and learning_consent_id is not null and learning_state<>'deleted' and (case_id is null and learning_actor_id=auth.uid() or case_id=id);
 get diagnostics n=row_count;return n;
end $function$;

CREATE OR REPLACE FUNCTION app.learning_scope_allowed (
  t    uuid,
  a    uuid,
  g    uuid,
  refs jsonb
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
 select app.has_tenant_role(t,array['owner']) and exists(select 1 from app.activity_consents c where c.tenant_id=t and c.user_id=a and c.learning_allowed and c.learning_consent_id=g)
 and jsonb_typeof(refs)='array' and jsonb_array_length(refs)>0
 and not exists(select 1 from jsonb_array_elements(refs) r where not app.revision_accessible(t,(r->>'revision')::uuid))
$function$;

CREATE OR REPLACE FUNCTION app.purge_learning_cases()
  RETURNS bigint
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
 with scrubbed as(update app.decision_examples e set proposal='{}',answer='{}',result='{}',learning_snapshot='{}',learning_history='[]',learning_reason=null,learning_state='deleted',learning_version=learning_version+1
 where learning_consent_id is not null and learning_state<>'deleted' and (created_at<now()-interval '90 days'
 or not exists(select 1 from app.activity_consents c where c.tenant_id=e.tenant_id and c.user_id=e.learning_actor_id and c.learning_allowed and c.learning_consent_id=e.learning_consent_id)
 or exists(select 1 from jsonb_array_elements(e.learning_snapshot->'source_refs') r join app.evidence_retention_tasks t on t.tenant_id=e.tenant_id and t.revision_id=(r->>'revision')::uuid)) returning 1)
 select count(*) from scrubbed
$function$;

ALTER TABLE "app"."decision_examples"
  ADD CONSTRAINT "decision_examples_learning_actor_id_fkey" FOREIGN KEY (learning_actor_id) REFERENCES auth.users(id);

ALTER TABLE "app"."decision_examples"
  ADD CONSTRAINT "decision_examples_learning_history_check" CHECK (((jsonb_typeof(learning_history) = 'array'::text) AND (jsonb_array_length(learning_history) <= 100)));

ALTER TABLE "app"."decision_examples"
  ADD CONSTRAINT "decision_examples_learning_reason_check" CHECK ((length(learning_reason) <= 1000));

ALTER TABLE "app"."decision_examples"
  ADD CONSTRAINT "decision_examples_learning_reviewed_by_fkey" FOREIGN KEY (learning_reviewed_by) REFERENCES auth.users(id);

ALTER TABLE "app"."decision_examples"
  ADD CONSTRAINT "decision_examples_learning_snapshot_check" CHECK ((jsonb_typeof(learning_snapshot) = 'object'::text));

ALTER TABLE "app"."decision_examples"
  ADD CONSTRAINT "decision_examples_learning_state_check"
    CHECK ((learning_state = ANY (ARRAY['policy_only'::text, 'unreviewed'::text, 'confirmed'::text, 'correction'::text, 'new_fact'::text, 'excluded'::text, 'deleted'::text])));

ALTER TABLE "app"."decision_examples"
  ADD CONSTRAINT "decision_examples_learning_version_check" CHECK ((learning_version > 0));

ALTER TABLE "app"."decision_examples"
  ADD CONSTRAINT "learning_case_scope"
    CHECK ((((learning_state = 'policy_only'::text) = (learning_consent_id IS NULL)) AND ((learning_consent_id IS NULL) = (learning_actor_id IS NULL))));

ALTER TABLE "app"."decision_examples"
  ADD CONSTRAINT "learning_deleted_scrubbed"
    CHECK
    (((learning_state <> 'deleted'::text) OR ((proposal = '{}'::jsonb) AND (answer = '{}'::jsonb) AND (result = '{}'::jsonb) AND (learning_snapshot = '{}'::jsonb) AND
    (learning_history = '[]'::jsonb) AND (learning_reason IS NULL))));

CREATE UNIQUE INDEX learning_decision_once ON app.decision_examples USING btree (tenant_id, decision_id)
  WHERE (learning_consent_id IS NOT NULL);

CREATE INDEX learning_timeline ON app.decision_examples USING btree (tenant_id, created_at DESC, id DESC)
  WHERE (learning_consent_id IS NOT NULL);

CREATE TRIGGER capture_learning_decision
  AFTER INSERT ON app.work_command_effects
  FOR EACH ROW
  EXECUTE FUNCTION app.capture_learning_decision();

CREATE POLICY "learning_owner_review" ON "app"."decision_examples"
  FOR UPDATE
  TO "sigongnote_api"
  USING (((learning_consent_id IS
    NOT NULL) AND (learning_state <> 'deleted'::text) AND
    app.learning_scope_allowed(tenant_id, learning_actor_id, learning_consent_id, (learning_snapshot -> 'source_refs'::text))))
  WITH CHECK (((learning_consent_id IS NOT NULL) AND app.has_tenant_role(tenant_id, ARRAY['owner'::text])));

CREATE POLICY "tenant_read" ON "app"."decision_examples"
  FOR SELECT
  TO "sigongnote_api"
  USING ((((learning_consent_id IS NULL) AND app.has_tenant_role(tenant_id, ARRAY['owner'::text, 'operator'::text, 'accountant'::text])) OR ((learning_consent_id IS
    NOT NULL) AND app.has_tenant_role(tenant_id, ARRAY['owner'::text]) AND
    ((learning_state = 'deleted'::text) OR app.learning_scope_allowed(tenant_id, learning_actor_id, learning_consent_id, (learning_snapshot -> 'source_refs'::text))))));

REVOKE ALL ON FUNCTION "app"."capture_learning_decision"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "app"."capture_learning_decision"() TO "postgres";

REVOKE ALL ON FUNCTION "app"."erase_learning_case"(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "app"."erase_learning_case"(uuid, uuid) TO "postgres", "sigongnote_api";

REVOKE ALL ON FUNCTION "app"."learning_scope_allowed"(uuid, uuid, uuid, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "app"."learning_scope_allowed"(uuid, uuid, uuid, jsonb) TO "postgres", "sigongnote_api";

REVOKE ALL ON FUNCTION "app"."purge_learning_cases"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "app"."purge_learning_cases"() TO "postgres", "sigongnote_api", "sigongnote_worker";

REVOKE ALL ("learning_history") ON TABLE "app"."decision_examples" FROM "sigongnote_api";

GRANT UPDATE ("learning_history") ON TABLE "app"."decision_examples" TO "sigongnote_api";

REVOKE ALL ("learning_reason") ON TABLE "app"."decision_examples" FROM "sigongnote_api";

GRANT UPDATE ("learning_reason") ON TABLE "app"."decision_examples" TO "sigongnote_api";

REVOKE ALL ("learning_reviewed_at") ON TABLE "app"."decision_examples" FROM "sigongnote_api";

GRANT UPDATE ("learning_reviewed_at") ON TABLE "app"."decision_examples" TO "sigongnote_api";

REVOKE ALL ("learning_reviewed_by") ON TABLE "app"."decision_examples" FROM "sigongnote_api";

GRANT UPDATE ("learning_reviewed_by") ON TABLE "app"."decision_examples" TO "sigongnote_api";

REVOKE ALL ("learning_state") ON TABLE "app"."decision_examples" FROM "sigongnote_api";

GRANT UPDATE ("learning_state") ON TABLE "app"."decision_examples" TO "sigongnote_api";

REVOKE ALL ("learning_version") ON TABLE "app"."decision_examples" FROM "sigongnote_api";

GRANT UPDATE ("learning_version") ON TABLE "app"."decision_examples" TO "sigongnote_api";
