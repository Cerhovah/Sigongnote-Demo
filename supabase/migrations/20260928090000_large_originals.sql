-- C13: align the private original bucket and tenant claims with the Android
-- per-file recording limit. Upload verification remains server-owned.
update storage.buckets set file_size_limit = 209715200
where id = 'sigongnote-originals';
alter table app.evidence_blobs drop constraint evidence_blobs_byte_length_check;
alter table app.evidence_blobs add constraint evidence_blobs_byte_length_check
  check (byte_length between 1 and 209715200);
alter table app.upload_intents drop constraint upload_intents_claimed_byte_length_check;
alter table app.upload_intents add constraint upload_intents_claimed_byte_length_check
  check (claimed_byte_length between 1 and 209715200);
