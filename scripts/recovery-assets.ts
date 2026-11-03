/** Dependencies deliberately contain no secret values, personal paths or provider credentials. */
export function recoveryAssets(migrations:string[],roles:string[]){
 return {schema:1,migrations,roles,server_assets:['all app tables','auth metadata','storage metadata','originals','documents','purpose consent/deletion','model/prompt/evaluation versions','receipts/outbox'],
  key_dependencies:[
   {purpose:'archive',custody:'same Windows account DPAPI',included:false,gate:'H09'},
   {purpose:'server authentication and providers',custody:'external environment and provider accounts',included:false,gate:'H02/H09'},
   {purpose:'Windows queue and credentials',custody:'original Windows account DPAPI',included:false,gate:'H09'},
   {purpose:'Android queue and credentials',custody:'original device Keystore and application identity',included:false,gate:'H09'},
   {purpose:'Android update signing',custody:'existing release signing identity',included:false,gate:'H09'}],
  shared_local_journal:{table:'app.local_journal_entries',included_in_all_app_tables:true,originals:'device copies remain separately preserved'},
  work_events:{tables:['app.work_events','app.work_followups','app.work_event_sources','app.work_event_corrections','app.local_context_consents'],included_in_all_app_tables:true,model_versions:'each event row keeps the model id and usage reference that produced it; the recorded Claude fixture is in Git'},
  context_learning:{tables:['app.context_learning_cases','app.context_reading_procedures','app.context_reading_shadows','app.context_reading_evaluations'],included_in_all_app_tables:true,scope:'consented site-reading observations and approved read hints only; no business effects'},
  native_queues:{windows:'separate closed-app encrypted snapshot required',android:'separate closed-app encrypted snapshot required',new_device_decryption_verified:false},
  update_requirements:['same application and signing identity','compatible queue schema','preserve unsubmitted sources and operation IDs','preserve consent/revocation/deletion state','do not replay unknown external attempts'],full_product_restore_accepted:false};
}
