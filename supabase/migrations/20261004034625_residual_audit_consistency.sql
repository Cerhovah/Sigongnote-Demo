-- Earlier local application kept weaker duplicate FKs. Keep the validated
-- delivery-scoped FKs from N20 before removing only those redundant copies.
-- N20 outbox_business_scope keeps delivery_id and delivery_attempt_id paired,
-- so the composite MATCH SIMPLE FK also covers the old two-column constraint.
do $$
begin
 if not exists(select 1 from pg_constraint where conrelid='app.deliveries'::regclass
  and conname='deliveries_tenant_id_id_current_attempt_fkey' and convalidated
  and pg_get_constraintdef(oid)='FOREIGN KEY (tenant_id, id, current_attempt) REFERENCES app.delivery_attempts(tenant_id, delivery_id, id)')
 or not exists(select 1 from pg_constraint where conrelid='app.outbox'::regclass
  and conname='outbox_tenant_id_delivery_id_delivery_attempt_id_fkey' and convalidated
  and pg_get_constraintdef(oid)='FOREIGN KEY (tenant_id, delivery_id, delivery_attempt_id) REFERENCES app.delivery_attempts(tenant_id, delivery_id, id)')
 or not exists(select 1 from pg_constraint where conrelid='app.outbox'::regclass
  and conname='outbox_business_scope' and contype='c' and convalidated)
 then raise exception 'DELIVERY_SCOPE_CONSTRAINT_REQUIRED';end if;
end $$;
alter table app.deliveries drop constraint if exists deliveries_tenant_id_current_attempt_fkey;
alter table app.outbox drop constraint if exists outbox_tenant_id_delivery_attempt_id_fkey;
