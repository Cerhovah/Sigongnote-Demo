alter table app.sync_changes drop constraint sync_changes_kind_check;
alter table app.sync_changes add constraint sync_changes_kind_check check(kind in ('material','document','photo_sheet','reset'));
create trigger sync_material_predecessor after insert on app.document_revisions for each row when(new.predecessor_id is not null) execute function app.record_sync_change('material','predecessor_id');
create trigger sync_photo_sheet after insert or delete on app.photo_sheets for each row execute function app.record_sync_change('photo_sheet','id');
create trigger sync_photo_artifact after insert or delete on app.photo_sheet_artifacts for each row execute function app.record_sync_change('photo_sheet','sheet_id');
create trigger sync_photo_job after update of state on app.jobs for each row when(new.photo_sheet_id is not null) execute function app.record_sync_change('photo_sheet','photo_sheet_id');
-- Checkpointed clients replay on their v2 upgrade. Existing immutable sheets enter
-- the same feed once; no source, original, or accounting effects are modified.
do $$ declare r record; pos bigint;begin
 for r in select s.tenant_id,s.id from app.photo_sheets s where not exists(select 1 from app.sync_changes c where c.tenant_id=s.tenant_id and c.kind='photo_sheet' and c.target_id=s.id) order by s.tenant_id,s.id loop
  insert into app.sync_heads values(r.tenant_id,1) on conflict(tenant_id) do update set position=app.sync_heads.position+1 returning position into pos;
  insert into app.sync_changes values(r.tenant_id,pos,'photo_sheet',r.id,false);
 end loop;
end $$;
