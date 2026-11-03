SET local check_function_bodies = off;

ALTER TABLE "app"."improvement_heads"
  ADD COLUMN "budget_hold_day" text;

CREATE OR REPLACE FUNCTION app.improvement_budget_usage (
  t uuid
)
  RETURNS jsonb
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
 select jsonb_build_object('calls',count(*),'cost',coalesce(sum(coalesce(actual_minor,reserved_minor)),0),'known_cost',coalesce(sum(actual_minor),0),'unknown',count(*) filter(where actual_minor is null)) from app.improvement_experiments where tenant_id=t and app.has_tenant_role(t,array['owner']) and created_at>=(date_trunc('day',now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul')
$function$;

ALTER TABLE "app"."improvement_heads"
  ADD CONSTRAINT "improvement_heads_budget_hold_day_check" CHECK ((budget_hold_day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'::text));

REVOKE ALL ("budget_hold_day") ON TABLE "app"."improvement_heads" FROM "sigongnote_api";

GRANT UPDATE ("budget_hold_day") ON TABLE "app"."improvement_heads" TO "sigongnote_api";

