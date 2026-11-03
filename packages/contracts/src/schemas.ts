import {DocumentFormSchema} from './document-form.js';
import { z } from "zod";

export const UuidSchema = z.uuid().regex(/^[^\r\n]*(?![\s\S])/);
export const VersionSchema = z.number().int().min(1).max(2147483647);
export const UtcTimestampSchema = z.iso.datetime({ offset: false }).regex(/^[^\r\n]*(?![\s\S])/);
export const IntegerStringSchema = z.string().regex(/^(?:0|-?[1-9][0-9]{0,19})(?![\s\S])/);
export const DecimalStringSchema = z.string().regex(/^-?(?:0|[1-9][0-9]{0,13})(?:\.[0-9]{1,6})?(?![\s\S])/);

export const MoneySchema = z.discriminatedUnion("knowledge", [
 z.strictObject({currency:z.literal("KRW"),minor:IntegerStringSchema,knowledge:z.literal("known")}),
 z.strictObject({currency:z.literal("KRW"),minor:z.null(),knowledge:z.literal("unknown")}),
 z.strictObject({currency:z.literal("KRW"),minor:z.null(),knowledge:z.literal("not_applicable")}),
]);
export const UnitCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}(?![\s\S])/);
export const QuantitySchema = z.strictObject({
 value:DecimalStringSchema, unit_code:UnitCodeSchema, raw_text:z.string().min(1).max(1024),
 semantic:z.enum(["scope","billing","ordered","moved","accepted","rejected","returned"]),
});
const dateFields = {
 raw:z.string().min(1).max(1024),
 inferred_components:z.array(z.enum(["year","month","day","time","timezone"])).max(5),
};
export const SourceDateSchema = z.discriminatedUnion("precision",[
 z.strictObject({...dateFields,precision:z.literal("unknown"),date:z.null()}),
 z.strictObject({...dateFields,precision:z.literal("year"),date:z.string().regex(/^[0-9]{4}(?![\s\S])/)}),
 z.strictObject({...dateFields,precision:z.literal("month"),date:z.string().regex(/^[0-9]{4}-(?:0[1-9]|1[0-2])(?![\s\S])/)}),
 z.strictObject({...dateFields,precision:z.literal("day"),date:z.iso.date().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}(?![\s\S])/)}),
 z.strictObject({...dateFields,precision:z.literal("time"),date:UtcTimestampSchema}),
]);
export const ErrorCodeSchema = z.enum([
 "INVALID_CONTRACT","UNAUTHENTICATED","FORBIDDEN","NOT_FOUND","VERSION_CONFLICT",
 "IDEMPOTENCY_CONFLICT","STORAGE_QUOTA_EXCEEDED","SOURCE_EXPIRED","PAYLOAD_TOO_LARGE","UNSUPPORTED_MEDIA",
 "DOMAIN_INVARIANT","SOURCE_SCOPE_MISMATCH","RATE_LIMITED","TEMPORARILY_UNAVAILABLE",
]);
export const ApiErrorSchema = z.strictObject({
 error:z.strictObject({
  code:ErrorCodeSchema,message_ko:z.string().min(1).max(240),retryable:z.boolean(),
  correlation_id:UuidSchema,
  details:z.strictObject({current_version:VersionSchema.optional(),action:z.enum(["refresh_diff","retry_later","reconnect"]).optional()}).optional(),
 }),
});
const bridgeFields = {bridgeVersion:z.literal(1),requestId:UuidSchema};
export const EvidenceCursorSchema=z.string().min(1).max(240).regex(/^[A-Za-z0-9_-]+(?![\s\S])/);
export const EvidencePageSchema=z.strictObject({
 revision_id:UuidSchema,index_job_id:UuidSchema.nullable(),source_hash:z.string().regex(/^[a-f0-9]{64}$/),
 parser_version:z.string().nullable(),source_status:z.string(),coverage:z.record(z.string(),z.json()),
 complete_extracted_text:z.boolean(),indexed_chunks:z.number().int().min(0),index_status:z.enum(['complete','legacy_excerpt_only','pending']),
 chunks:z.array(z.strictObject({ordinal:z.number().int().min(0),text:z.string().min(1).max(1000),locator:z.string().min(1).max(1000),position:z.record(z.string(),z.json())})).max(200),
 next_cursor:EvidenceCursorSchema.nullable(),
});
export const WorkRequestSchema=z.discriminatedUnion("route",[
 z.strictObject({route:z.literal('archive.status')}),
 z.strictObject({route:z.literal('archive.command'),command:z.string().min(2).max(16000)}),
 z.strictObject({route:z.literal('journal.tasks')}),
 z.strictObject({route:z.literal('events.list'),project_id:UuidSchema.optional(),limit:z.number().int().min(1).max(100).optional()}),
 z.strictObject({route:z.literal('events.read'),id:UuidSchema}),
 z.strictObject({route:z.literal('ai.consent'),allowed:z.boolean(),expected_version:z.number().int().nonnegative(),client_command_id:UuidSchema,processing_policy:z.lazy(()=>CapturePolicySchema).optional()}),
 z.strictObject({route:z.literal('journal.command'),command:z.string().min(2).max(16000)}),
 z.strictObject({route:z.literal('journal.list'),project_id:UuidSchema.optional(),q:z.iso.date().optional(),cursor:UuidSchema.optional(),category:z.enum(['agreement','drawing_material','delivery_work','billing_payment','inspection_defect']).optional()}),
 z.strictObject({route:z.literal('setup.read')}),
 z.strictObject({route:z.literal('setup.command'),command:z.string().min(2).max(16000)}),
 z.strictObject({route:z.literal('setup.capture'),command:z.string().min(2).max(16000)}),
 z.strictObject({route:z.literal('ledger.list'),project_id:UuidSchema.optional(),category:z.enum(['agreement','drawing_material','delivery_work','billing_payment','inspection_defect']).optional(),cursor:z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).optional()}),
 z.strictObject({route:z.literal('ledger.read'),id:UuidSchema,cursor:UuidSchema.optional()}),
 z.strictObject({route:z.literal('agenda.read')}),
 z.strictObject({route:z.literal('deliveries.list'),source_kind:z.enum(['document','photo_sheet']),source_id:UuidSchema}),
 z.strictObject({route:z.literal('deliveries.read'),id:UuidSchema}),
 z.strictObject({route:z.literal('deliveries.prepare'),command:z.string().min(2).max(3000)}),
 z.strictObject({route:z.literal('deliveries.authorize'),command:z.string().min(2).max(3000)}),
 z.strictObject({route:z.literal('deliveries.cancel'),command:z.string().min(2).max(3000)}),
 z.strictObject({route:z.literal('sheets.share'),command:z.string().min(2).max(3000)}),
 z.strictObject({route:z.literal('sheets.prepare'),command:z.string().min(2).max(2000)}),
 z.strictObject({route:z.literal('sheets.read'),id:UuidSchema}),
 z.strictObject({route:z.literal('sheets.file'),id:UuidSchema,format:z.literal('pdf'),action:z.enum(['open','save','share']).optional()}),
 z.strictObject({route:z.literal('photos.list'),project_id:UuidSchema,cursor:UuidSchema.optional()}),
 z.strictObject({route:z.literal('photos.group'),id:UuidSchema}),
 z.strictObject({route:z.literal('photos.preview'),id:UuidSchema}),
 z.strictObject({route:z.literal('photos.command'),command:z.string().min(2).max(12000)}),
 z.strictObject({route:z.literal("agent.start"),command:z.string().min(2).max(16000)}),
 z.strictObject({route:z.literal("agent.read"),id:UuidSchema}),
 z.strictObject({route:z.literal("agent.cancel"),id:UuidSchema}),
 z.strictObject({route:z.literal("agent.continue"),id:UuidSchema}),
 z.strictObject({route:z.literal('capture.status')}),
 z.strictObject({route:z.literal('evidence.resume'),id:UuidSchema,command:z.string().min(2).max(1000)}),
 z.strictObject({route:z.literal('folders.read')}),
 z.strictObject({route:z.literal('folders.correct'),command:z.string().min(2).max(64000)}),
 z.strictObject({route:z.literal("evidence.chunks"),id:UuidSchema,cursor:EvidenceCursorSchema.optional()}),
 z.strictObject({route:z.literal("learning.list"),cursor:UuidSchema.optional()}),
 z.strictObject({route:z.literal('context-learning.list')}),
 z.strictObject({route:z.literal('context-learning.command'),command:z.string().min(2).max(16000)}),
 z.strictObject({route:z.literal("improvements.list")}),
 z.strictObject({route:z.literal("improvements.command"),command:z.string().min(2).max(4000)}),
 z.strictObject({route:z.literal("learning.read"),id:UuidSchema}),
 z.strictObject({route:z.literal("learning.command"),command:z.string().min(2).max(4000)}),
 z.strictObject({route:z.literal("activity.status")}),
 z.strictObject({route:z.literal("activity.delete")}),
 z.strictObject({route:z.literal("activity.consent"),allowed:z.boolean()}),
 z.strictObject({route:z.literal("activity.append"),command:z.string().min(2).max(120000)}),
 z.strictObject({route:z.literal("activity.list"),cursor:UuidSchema.optional(),q:z.string().max(80).optional()}),
 z.strictObject({route:z.literal("questions.list")}),
 z.strictObject({route:z.literal("maintenance.status")}),
 z.strictObject({route:z.literal("policies.list")}),
 z.strictObject({route:z.literal("audio.correct"),command:z.string().min(2).max(16000)}),
 z.strictObject({route:z.literal("policies.command"),command:z.string().min(2).max(16000)}),
 z.strictObject({route:z.literal("work.reply"),command:z.string().min(2).max(16000)}),
 z.strictObject({route:z.literal("work.command"),command:z.string().min(2).max(16000)}),
 z.strictObject({route:z.literal("sync.item"),id:UuidSchema,target_kind:z.enum(["material","document","photo_sheet"])}),
 z.strictObject({route:z.literal("sync.changes"),sync_version:z.literal(2).optional(),cursor:z.string().regex(/^[a-f0-9-]{36}:[a-f0-9-]{36}:[0-9]{1,19}$/).optional()}),
 z.strictObject({route:z.literal("documents.list")}),
 z.strictObject({route:z.literal('documents.prepare'),project_id:UuidSchema,type:z.literal('estimate'),client_command_id:UuidSchema}),
 z.strictObject({route:z.literal("documents.issued"),id:UuidSchema}),
 z.strictObject({route:z.literal("documents.file"),id:UuidSchema,format:z.enum(["pdf","xlsx"]),action:z.enum(["open","save","share"]).optional()}),
 z.strictObject({route:z.literal("documents.share"),id:UuidSchema,format:z.enum(["pdf","xlsx"]),client_command_id:UuidSchema}),
 z.strictObject({route:z.literal("documents.shareOutcome"),id:UuidSchema,intent_id:UuidSchema,client_command_id:UuidSchema,outcome:z.enum(["cancelled","unknown","user_confirmed"])}),
 z.strictObject({route:z.literal("documents.retry"),id:UuidSchema,client_command_id:UuidSchema}),
 z.strictObject({route:z.literal("documents.cancel"),id:UuidSchema,client_command_id:UuidSchema,expected_hash:z.string().regex(/^[a-f0-9]{64}(?![\s\S])/)}),
 z.strictObject({route:z.literal("documents.issue"),id:UuidSchema,client_command_id:UuidSchema,basis_hash:z.string().regex(/^[a-f0-9]{64}(?![\s\S])/),recipient_confirmation:z.string().trim().min(1).max(120),amount_minor:z.string().regex(/^[1-9][0-9]{0,14}(?![\s\S])/).optional(),replacement_id:UuidSchema.optional(),expected_hash:z.string().regex(/^[a-f0-9]{64}(?![\s\S])/).optional()}),
 z.strictObject({route:z.literal("documents.read"),id:UuidSchema}),
 z.strictObject({route:z.literal("documents.complete"),form:DocumentFormSchema.optional(),quantities:z.string().min(2).max(16000).optional(),lines:z.string().min(2).max(64000).optional(),id:UuidSchema,client_command_id:UuidSchema,recipient:z.string().trim().min(1).max(120).optional(),margin_bps:z.number().int().min(0).max(9999).optional(),tax_mode:z.enum(["exclusive","inclusive","not_applicable"]).optional(),tax_bps:z.number().int().min(0).max(10000).optional()}),
 z.strictObject({route:z.literal("voice.status")}),
 z.strictObject({route:z.literal("voice.consent"),allowed:z.boolean(),consent_version:z.literal("short-voice-v1")}),
 z.strictObject({route:z.literal("voice.transcribe"),id:UuidSchema,mime:z.enum(["audio/webm","audio/ogg","audio/wav"]),audio:z.string().min(24).max(1048576).regex(/^[A-Za-z0-9+/]+={0,2}$/),consent_version:z.literal("short-voice-v1")}),
 z.strictObject({route:z.literal("voice.result"),id:UuidSchema}),
 z.strictObject({route:z.literal("voice.cancel"),id:UuidSchema}),
 z.strictObject({route:z.literal("materials.list"),q:z.string().max(80).optional(),cursor:UuidSchema.optional(),project_id:UuidSchema.optional(),category:z.enum(["agreement","drawing_material","delivery_work","billing_payment","inspection_defect"]).optional()}),
 z.strictObject({route:z.literal("materials.detail"),id:UuidSchema}),
 z.strictObject({route:z.literal("materials.message"),id:UuidSchema}),
 z.strictObject({route:z.literal("context")}),
 z.strictObject({route:z.literal("materials.original"),id:UuidSchema}),
 z.strictObject({route:z.literal("organization.answer"),id:UuidSchema,project_id:UuidSchema,version:VersionSchema}),
 z.strictObject({route:z.literal("conversation.turn"),id:UuidSchema,client_turn_id:UuidSchema,text:z.string().trim().min(1).max(2000),input_kind:z.enum(["text","voice"]).optional(),selected_project_id:UuidSchema.optional()}),
 z.strictObject({route:z.literal("conversation.read"),id:UuidSchema}),
 z.strictObject({route:z.literal("guide.read")}),
 z.strictObject({route:z.literal("guide.save"),step:z.number().int().min(0).max(2),completed:z.boolean()}),
]);
export const BridgeRequestSchema = z.discriminatedUnion("method",[
 z.strictObject({...bridgeFields,method:z.literal("startVoiceInput"),payload:z.strictObject({})}),
 z.strictObject({...bridgeFields,method:z.literal("cancelVoiceInput"),payload:z.strictObject({voice_request_id:UuidSchema})}),
 z.strictObject({...bridgeFields,method:z.literal("workRequest"),payload:WorkRequestSchema}),
 z.strictObject({...bridgeFields,method:z.literal("openPhotoCapture"),payload:z.strictObject({})}),
 z.strictObject({...bridgeFields,method:z.literal("getConnectionState"),payload:z.strictObject({})}),
 z.strictObject({...bridgeFields,method:z.literal("connectSource"),payload:z.strictObject({kind:z.enum(["folder","photos","notifications","sms","call_recording"])})}),
 z.strictObject({...bridgeFields,method:z.literal("pauseSource"),payload:z.strictObject({source_id:UuidSchema})}),
 z.strictObject({...bridgeFields,method:z.literal("openEvidence"),payload:z.strictObject({revision_id:UuidSchema})}),
 z.strictObject({...bridgeFields,method:z.literal("enqueueShare"),payload:z.strictObject({share_token:UuidSchema})}),
 z.strictObject({...bridgeFields,method:z.literal("getQueueSummary"),payload:z.strictObject({})}),
 z.strictObject({...bridgeFields,method:z.literal("logout"),payload:z.strictObject({})}),
]);
export const DeviceRegistrationRequestSchema = z.strictObject({
 platform:z.enum(["android","windows","web"]),
 app_version:z.string().min(1).max(64),
 public_key_jwk:z.strictObject({
  kty:z.literal("EC"),crv:z.literal("P-256"),
  x:z.string().regex(/^[A-Za-z0-9_-]{43}(?![\s\S])/),
  y:z.string().regex(/^[A-Za-z0-9_-]{43}(?![\s\S])/),
 }),
});
export const DeviceResponseSchema = z.strictObject({
 id:UuidSchema,tenant_id:UuidSchema,platform:z.enum(["android","windows","web"]),
 active:z.boolean(),version:VersionSchema,revoked_at:UtcTimestampSchema.nullable(),
});
export const MeResponseSchema = z.strictObject({
 user_id:UuidSchema,
 memberships:z.array(z.strictObject({tenant_id:UuidSchema,tenant_name:z.string(),role:z.enum(["owner","operator","accountant","viewer"])})),
});
export const CaptureSourceKindSchema = z.enum(["manual_share","folder","notifications","photos","call_recording","sms","call_log"]);
export const WorkspaceCreateRequestSchema = z.strictObject({ display_name:z.string().trim().min(1).max(120) });
export const WorkspaceResponseSchema = z.strictObject({ tenant_id:UuidSchema,display_name:z.string().min(1).max(120),role:z.literal("owner"),version:VersionSchema });
export const ProjectCreateRequestSchema = z.strictObject({display_name:z.string().trim().min(1).max(180)});
export const ProjectResponseSchema = z.strictObject({id:UuidSchema,display_name:z.string(),version:VersionSchema});
export const SiteFolderBindingRequestSchema = z.strictObject({
 source_id:UuidSchema,source_generation:VersionSchema,
 scope_fingerprint:z.string().regex(/^[0-9a-f]{64}(?![\s\S])/),
 scope_mode:z.enum(["project","company_common","unassigned"]),project_id:UuidSchema.nullable(),
 display_name:z.string().trim().min(1).max(180).nullable().optional(),
}).refine(value => (value.scope_mode === "project") === (value.project_id !== null));
export const SiteFolderBindingResponseSchema = z.strictObject({
 id:UuidSchema,source_id:UuidSchema,source_generation:VersionSchema,
 scope_fingerprint:z.string(),scope_mode:z.enum(["project","company_common","unassigned"]),
 project_id:UuidSchema.nullable(),version:VersionSchema,display_name:z.string().nullable().optional(),
});
export const SiteFolderBatchRequestSchema=z.strictObject({client_command_id:UuidSchema,changes:z.array(z.strictObject({
 id:UuidSchema,expected_version:VersionSchema,source_generation:VersionSchema,
 scope_mode:z.enum(["project","company_common","unassigned"]),project_id:UuidSchema.nullable(),
}).refine(v=>(v.scope_mode==="project")===(v.project_id!==null))).min(1).max(100)}).refine(v=>new Set(v.changes.map(c=>c.id)).size===v.changes.length);
export const SiteFolderBindingsResponseSchema = z.strictObject({bindings:z.array(SiteFolderBindingResponseSchema)});
export const CapturePolicySchema = z.strictObject({
 id:z.string().regex(/^[a-z0-9-]{1,64}$/),purpose:z.literal("work_records"),
 provider:z.string().min(1).max(80),processing_location:z.string().min(1).max(100),
 storage_location:z.string().min(1).max(100),retention:z.literal("until_user_deletes"),
 external_processing:z.boolean(),
 processors:z.array(z.strictObject({purpose:z.literal('long_stt'),provider:z.enum(['openai','clova_speech']),
  processing_location:z.string().trim().min(1).max(200),storage_location:z.string().trim().min(1).max(200),retention:z.string().trim().min(1).max(200)})).min(1).max(1).optional(),
}).refine(value=>!value.processors?.length||value.external_processing);
export const CaptureScopeSchema = z.strictObject({
 processing_lane:z.enum(["current","archive"]).optional(),
 capture_method:z.enum(["saf_tree","filesystem","selected_media","notification","sms_provider","manual_share"]),
 history_mode:z.enum(["all","since","selected"]),history_since:UtcTimestampSchema.nullable(),
 scope_mode:z.enum(["work_dedicated","selected_items","mixed_hold","ai_screened"]),
 rule_version:z.literal(1),processing_policy_id:z.string().regex(/^[a-z0-9-]{1,64}$/),
 fingerprint_algorithm:z.literal("hmac-sha256-device-v1"),
}).refine(v=>(v.history_mode==="since")===(v.history_since!==null));
export const CaptureSourceCreateRequestSchema = z.strictObject({
 device_id:UuidSchema,kind:CaptureSourceKindSchema,
 scope_fingerprint:z.string().regex(/^[0-9a-f]{64}(?![\s\S])/),
 consent_version:z.number().int().min(1).max(2),local_selection_consent:z.literal(true),
 scope:CaptureScopeSchema.optional(),
 server_upload_consent:z.boolean(),external_ai_consent:z.boolean(),
 processing_policy:CapturePolicySchema.optional(),
}).refine(value => !value.external_ai_consent || value.server_upload_consent)
 .refine(v=>(v.consent_version===2)===(v.scope!==undefined))
 .refine(v=>!v.scope || ({folder:["saf_tree","filesystem"],photos:["saf_tree","filesystem","selected_media"],
 call_recording:["saf_tree","filesystem","manual_share"],notifications:["notification"],sms:["sms_provider"],
 call_log:["sms_provider"],manual_share:["manual_share"]}[v.kind].includes(v.scope.capture_method)))
 .refine(v=>v.scope?.scope_mode!=="mixed_hold" || !v.server_upload_consent)
 .refine(v=>v.scope?.scope_mode!=="ai_screened" || (v.kind==="sms" && v.scope.history_mode==="since" && v.external_ai_consent && v.server_upload_consent))
 .refine(v=>v.scope?.capture_method!=="selected_media" ||
 (v.scope.scope_mode==="selected_items" && v.scope.history_mode==="selected"));
export const CaptureSourceCheckpointRequestSchema = z.strictObject({
 generation:VersionSchema,
 reported_permission:z.enum(["not_requested","granted","denied","revoked","role_missing"]),
 cursor_token:z.string().regex(/^[0-9a-f]{64}(?![\s\S])/).optional(),
 coverage_from:UtcTimestampSchema.optional(),
 last_successful_scan_at:UtcTimestampSchema.optional(),
 last_event_at:UtcTimestampSchema.optional(),
 pending_count:z.number().int().min(0).max(2147483647),
 bytes_pending:z.number().int().min(0).max(9007199254740991),
 last_error_code:z.string().regex(/^[A-Z0-9_]{1,64}(?![\s\S])/).optional(),
});
export const CaptureSourceResponseSchema = z.strictObject({
 id:UuidSchema,tenant_id:UuidSchema,device_id:UuidSchema,kind:CaptureSourceKindSchema,
 capability:z.enum(["unsupported","manual_only","selected_items","passive","policy_gated"]),
 permission:z.enum(["not_requested","granted","denied","revoked","role_missing"]),
 reported_permission:z.enum(["not_requested","granted","denied","revoked","role_missing"]).nullable(),
 permission_trust:z.literal("client_report_only"),
 health:z.enum(["not_started","scanning","current","delayed","source_offline","paused","error"]),
 scope_version:VersionSchema,generation:VersionSchema,version:VersionSchema,active:z.boolean(),
 device_active:z.boolean(),upload_ready:z.boolean(),
 scope_fingerprint:z.string().regex(/^[0-9a-f]{64}$/).optional(),
 scope:CaptureScopeSchema.nullable().optional(),processing_policy:CapturePolicySchema.nullable().optional(),
 local_selection_consent:z.boolean(),server_upload_consent:z.boolean(),external_ai_consent:z.boolean(),
 permission_checked_at:UtcTimestampSchema.nullable(),coverage_from:UtcTimestampSchema.nullable(),
 last_successful_scan_at:UtcTimestampSchema.nullable(),last_event_at:UtcTimestampSchema.nullable(),
 last_server_ack_at:UtcTimestampSchema.nullable(),pending_count:z.number().int().min(0),
 bytes_pending:z.number().int().min(0),last_error_code:z.string().nullable(),
});
export const CaptureSourcesResponseSchema = z.strictObject({sources:z.array(CaptureSourceResponseSchema)});
export const ReadinessReportSchema=z.strictObject({
 checked_at:UtcTimestampSchema,
 capabilities:z.array(z.strictObject({id:z.string(),label:z.string(),state:z.enum(['ready','needs_setup','needs_reconnect','waiting','unverified']),reason:z.string(),action:z.enum(['none','connect_folder','restore_permission','configure_provider','check_worker']),source_id:UuidSchema.nullable(),evidence:z.enum(['server_observed','device_report','configuration_only','not_verified'])})),
 coverage:z.strictObject({source_count:z.number().int().nonnegative(),reported_scanned_count:z.number().int().nonnegative(),last_scan_at:UtcTimestampSchema.nullable(),full_content:z.enum(['not_verified','partial','complete'])}),
 limits:z.strictObject({daily_krw:z.literal(10000),monthly_krw:z.literal(50000),source_bytes:z.literal('100000000000'),scope:z.literal('per_user'),budget_enforced:z.boolean()}),
 formats:z.array(z.strictObject({label:z.string(),extensions:z.array(z.string()),status:z.enum(['parser_available','provider_required','discovery_only','excluded'])})),
});
export type ReadinessReport=z.infer<typeof ReadinessReportSchema>;
export const IngestionPrepareRequestSchema = z.strictObject({
 client_capture_id:UuidSchema,
 sha256:z.string().regex(/^[0-9a-f]{64}(?![\s\S])/),
 byte_length:z.number().int().min(1).max(209715200),
 declared_mime:z.string().regex(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*(?![\s\S])/).max(127),
 document_id:UuidSchema.optional(),predecessor_revision_id:UuidSchema.optional(),
 expected_version:VersionSchema.optional(),
 source_id:UuidSchema.optional(),source_generation:VersionSchema.optional(),
}).refine(value => [value.document_id,value.predecessor_revision_id,value.expected_version]
 .every(part => part === undefined) ||
 [value.document_id,value.predecessor_revision_id,value.expected_version]
 .every(part => part !== undefined)).refine(value =>
  (value.source_id === undefined) === (value.source_generation === undefined));
export const IngestionPrepareResponseSchema = z.strictObject({
 ingestion_id:UuidSchema,state:z.literal("prepared"),upload_url:z.url(),expires_at:UtcTimestampSchema,
 upload:z.strictObject({protocol:z.literal("tus"),endpoint:z.url(),
  signature:z.string().min(32).max(4096),bucket:z.literal("sigongnote-originals"),
  object_name:z.string().regex(/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/),
  chunk_bytes:z.literal(6291456),authorization:z.literal("user_bearer+signature"),
  metadata_keys:z.literal("bucketName,objectName,contentType"),
  upsert:z.literal(false)}),
});
export const IngestionCompleteRequestSchema = z.strictObject({
 sha256:z.string().regex(/^[0-9a-f]{64}(?![\s\S])/),
 byte_length:z.number().int().min(1).max(209715200),
});
export const IngestionReceiptResponseSchema = z.strictObject({
 ingestion_id:UuidSchema,state:z.enum(["verified","queued"]),blob_id:UuidSchema,
 document_id:UuidSchema,revision_id:UuidSchema,revision_number:z.number().int().positive().optional(),job_id:UuidSchema.optional(),
 deduplicated:z.boolean(),
});
export const CaptureDurabilityRequestSchema=IngestionCompleteRequestSchema;
export const CaptureDurabilityResponseSchema=z.strictObject({state:z.literal('recoverable'),ingestion_id:UuidSchema,revision_id:UuidSchema,sha256:z.string().regex(/^[a-f0-9]{64}$/),byte_length:z.number().int().positive().max(209715200),source_generation:z.number().int().positive().nullable(),verified_at:UtcTimestampSchema,restore_url:z.url().max(4096),expires_in:z.literal(60)});
export const CaptureStorageUsageSchema=z.strictObject({limit_bytes:z.literal(100000000000),used_bytes:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),reserved_bytes:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)});
export const CaptureStatusResponseSchema=CaptureStorageUsageSchema.extend({recovery:z.strictObject({checked:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),failed:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),last_checked_at:z.iso.datetime({offset:true}).nullable()})});
export const EvidenceResumeRequestSchema=z.strictObject({job_id:UuidSchema,resume_generation:z.number().int().min(0).max(2147483646)});
export const EvidenceResumeResponseSchema=z.strictObject({resumed:z.literal(true)});
export const schemas = {CaptureStatusResponse:CaptureStatusResponseSchema,EvidenceResumeRequest:EvidenceResumeRequestSchema,EvidenceResumeResponse:EvidenceResumeResponseSchema,SiteFolderBatchRequest:SiteFolderBatchRequestSchema,CaptureDurabilityRequest:CaptureDurabilityRequestSchema,CaptureDurabilityResponse:CaptureDurabilityResponseSchema,CaptureStorageUsage:CaptureStorageUsageSchema,ReadinessReport:ReadinessReportSchema,WorkRequest:WorkRequestSchema,WorkspaceCreateRequest:WorkspaceCreateRequestSchema,WorkspaceResponse:WorkspaceResponseSchema,CapturePolicy:CapturePolicySchema,CaptureScope:CaptureScopeSchema,ProjectCreateRequest:ProjectCreateRequestSchema,ProjectResponse:ProjectResponseSchema,SiteFolderBindingRequest:SiteFolderBindingRequestSchema,SiteFolderBindingResponse:SiteFolderBindingResponseSchema,SiteFolderBindingsResponse:SiteFolderBindingsResponseSchema,Money:MoneySchema,Quantity:QuantitySchema,SourceDate:SourceDateSchema,ApiError:ApiErrorSchema,BridgeRequest:BridgeRequestSchema,DeviceRegistrationRequest:DeviceRegistrationRequestSchema,DeviceResponse:DeviceResponseSchema,MeResponse:MeResponseSchema,CaptureSourceCreateRequest:CaptureSourceCreateRequestSchema,CaptureSourceCheckpointRequest:CaptureSourceCheckpointRequestSchema,CaptureSourceResponse:CaptureSourceResponseSchema,CaptureSourcesResponse:CaptureSourcesResponseSchema,IngestionPrepareRequest:IngestionPrepareRequestSchema,IngestionPrepareResponse:IngestionPrepareResponseSchema,IngestionCompleteRequest:IngestionCompleteRequestSchema,IngestionReceiptResponse:IngestionReceiptResponseSchema};
export type Money = z.infer<typeof MoneySchema>;
export type Quantity = z.infer<typeof QuantitySchema>;
export type SourceDate = z.infer<typeof SourceDateSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type DeviceRegistrationRequest = z.infer<typeof DeviceRegistrationRequestSchema>;
export type DeviceResponse = z.infer<typeof DeviceResponseSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;
