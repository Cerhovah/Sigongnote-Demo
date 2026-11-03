-- A failed or expired resumable session may be abandoned without deleting evidence.
alter table app.upload_intents drop constraint upload_intents_rejection_reason_check;
alter table app.upload_intents add constraint upload_intents_rejection_reason_check
  check (rejection_reason in
    ('hash_mismatch','expired','stale_document','source_revoked','client_abandoned'));
