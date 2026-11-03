-- C41b: revision lineage and owner reason for a changed margin draft.
alter table app.quote_revisions add column revision_reason text;
alter table app.quote_lines add column source_quote_line_id uuid;
alter table app.quote_lines add constraint quote_lines_source_line_fk
  foreign key (tenant_id,source_quote_line_id)
  references app.quote_lines(tenant_id,id) on delete restrict;
