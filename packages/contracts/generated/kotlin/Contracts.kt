// Generated from schemas.ts. Wire DTOs only; server runtime schemas enforce invariants.
// Never display nullable minor as zero. Preserve knowledge and explicit required nulls.
// C09/C14: align response readers to ignore added fields; incoming commands must stay strict.
package com.sigongnote.contracts

import kotlinx.serialization.Serializable

@Serializable
data class CaptureStatusResponse(
  val limit_bytes: Long,
  val used_bytes: Long,
  val reserved_bytes: Long,
  val recovery: CaptureStatusResponseRecovery
)

@Serializable
data class CaptureStatusResponseRecovery(
  val checked: Long,
  val failed: Long,
  val last_checked_at: String?
)

@Serializable
data class EvidenceResumeRequest(
  val job_id: String,
  val resume_generation: Int
)

@Serializable
data class EvidenceResumeResponse(
  val resumed: Boolean
)

@Serializable
data class SiteFolderBatchRequest(
  val client_command_id: String,
  val changes: List<SiteFolderBatchRequestChangesItem>
)

@Serializable
data class SiteFolderBatchRequestChangesItem(
  val id: String,
  val expected_version: Int,
  val source_generation: Int,
  val scope_mode: String,
  val project_id: String?
)

@Serializable
data class CaptureDurabilityRequest(
  val sha256: String,
  val byte_length: Int
)

@Serializable
data class CaptureDurabilityResponse(
  val state: String,
  val ingestion_id: String,
  val revision_id: String,
  val sha256: String,
  val byte_length: Int,
  val source_generation: Long?,
  val verified_at: String,
  val restore_url: String,
  val expires_in: Int
)

@Serializable
data class CaptureStorageUsage(
  val limit_bytes: Long,
  val used_bytes: Long,
  val reserved_bytes: Long
)

@Serializable
data class ReadinessReport(
  val checked_at: String,
  val capabilities: List<ReadinessReportCapabilitiesItem>,
  val coverage: ReadinessReportCoverage,
  val limits: ReadinessReportLimits,
  val formats: List<ReadinessReportFormatsItem>
)

@Serializable
data class ReadinessReportCapabilitiesItem(
  val id: String,
  val label: String,
  val state: String,
  val reason: String,
  val action: String,
  val source_id: String?,
  val evidence: String
)

@Serializable
data class ReadinessReportCoverage(
  val source_count: Long,
  val reported_scanned_count: Long,
  val last_scan_at: String?,
  val full_content: String
)

@Serializable
data class ReadinessReportLimits(
  val daily_krw: Int,
  val monthly_krw: Int,
  val source_bytes: String,
  val scope: String,
  val budget_enforced: Boolean
)

@Serializable
data class ReadinessReportFormatsItem(
  val label: String,
  val extensions: List<String>,
  val status: String
)

@Serializable
data class WorkRequest(
  val route: String,
  val command: String? = null,
  val project_id: String? = null,
  val limit: Int? = null,
  val id: String? = null,
  val allowed: Boolean? = null,
  val expected_version: Long? = null,
  val client_command_id: String? = null,
  val processing_policy: WorkRequestProcessingPolicy? = null,
  val q: String? = null,
  val cursor: String? = null,
  val category: String? = null,
  val source_kind: String? = null,
  val source_id: String? = null,
  val format: String? = null,
  val action: String? = null,
  val target_kind: String? = null,
  val sync_version: Int? = null,
  val type: String? = null,
  val intent_id: String? = null,
  val outcome: String? = null,
  val expected_hash: String? = null,
  val basis_hash: String? = null,
  val recipient_confirmation: String? = null,
  val amount_minor: String? = null,
  val replacement_id: String? = null,
  val form: WorkRequestForm? = null,
  val quantities: String? = null,
  val lines: String? = null,
  val recipient: String? = null,
  val margin_bps: Int? = null,
  val tax_mode: String? = null,
  val tax_bps: Int? = null,
  val consent_version: String? = null,
  val mime: String? = null,
  val audio: String? = null,
  val version: Int? = null,
  val client_turn_id: String? = null,
  val text: String? = null,
  val input_kind: String? = null,
  val selected_project_id: String? = null,
  val step: Int? = null,
  val completed: Boolean? = null
)

@Serializable
data class WorkRequestProcessingPolicy(
  val id: String,
  val purpose: String,
  val provider: String,
  val processing_location: String,
  val storage_location: String,
  val retention: String,
  val external_processing: Boolean,
  val processors: List<WorkRequestProcessingPolicyProcessorsItem>? = null
)

@Serializable
data class WorkRequestProcessingPolicyProcessorsItem(
  val purpose: String,
  val provider: String,
  val processing_location: String,
  val storage_location: String,
  val retention: String
)

@Serializable
data class WorkRequestForm(
  val issuer: WorkRequestFormIssuer? = null,
  val recipient: WorkRequestFormRecipient? = null,
  val valid_until: String? = null,
  val delivery_date: String? = null,
  val delivery_place: String? = null,
  val payment_terms: String? = null,
  val payment_account: String? = null,
  val note: String? = null
)

@Serializable
data class WorkRequestFormIssuer(
  val business_number: String? = null,
  val representative: String? = null,
  val address: String? = null,
  val business_type: String? = null,
  val business_item: String? = null,
  val contact: String? = null,
  val name: String? = null
)

@Serializable
data class WorkRequestFormRecipient(
  val business_number: String? = null,
  val representative: String? = null,
  val address: String? = null,
  val business_type: String? = null,
  val business_item: String? = null,
  val contact: String? = null
)

@Serializable
data class WorkspaceCreateRequest(
  val display_name: String
)

@Serializable
data class WorkspaceResponse(
  val tenant_id: String,
  val display_name: String,
  val role: String,
  val version: Int
)

@Serializable
data class CapturePolicy(
  val id: String,
  val purpose: String,
  val provider: String,
  val processing_location: String,
  val storage_location: String,
  val retention: String,
  val external_processing: Boolean,
  val processors: List<CapturePolicyProcessorsItem>? = null
)

@Serializable
data class CapturePolicyProcessorsItem(
  val purpose: String,
  val provider: String,
  val processing_location: String,
  val storage_location: String,
  val retention: String
)

@Serializable
data class CaptureScope(
  val capture_method: String,
  val history_mode: String,
  val history_since: String?,
  val scope_mode: String,
  val rule_version: Int,
  val processing_policy_id: String,
  val fingerprint_algorithm: String,
  val processing_lane: String? = null
)

@Serializable
data class ProjectCreateRequest(
  val display_name: String
)

@Serializable
data class ProjectResponse(
  val id: String,
  val display_name: String,
  val version: Int
)

@Serializable
data class SiteFolderBindingRequest(
  val source_id: String,
  val source_generation: Int,
  val scope_fingerprint: String,
  val scope_mode: String,
  val project_id: String?,
  val display_name: String? = null
)

@Serializable
data class SiteFolderBindingResponse(
  val id: String,
  val source_id: String,
  val source_generation: Int,
  val scope_fingerprint: String,
  val scope_mode: String,
  val project_id: String?,
  val version: Int,
  val display_name: String? = null
)

@Serializable
data class SiteFolderBindingsResponse(
  val bindings: List<SiteFolderBindingsResponseBindingsItem>
)

@Serializable
data class SiteFolderBindingsResponseBindingsItem(
  val id: String,
  val source_id: String,
  val source_generation: Int,
  val scope_fingerprint: String,
  val scope_mode: String,
  val project_id: String?,
  val version: Int,
  val display_name: String? = null
)

@Serializable
data class Money(
  val currency: String,
  val minor: String?,
  val knowledge: String
)

@Serializable
data class Quantity(
  val value: String,
  val unit_code: String,
  val raw_text: String,
  val semantic: String
)

@Serializable
data class SourceDate(
  val raw: String,
  val inferred_components: List<String>,
  val precision: String,
  val date: String?
)

@Serializable
data class ApiError(
  val error: ApiErrorError
)

@Serializable
data class ApiErrorError(
  val code: String,
  val message_ko: String,
  val retryable: Boolean,
  val correlation_id: String,
  val details: ApiErrorErrorDetails? = null
)

@Serializable
data class ApiErrorErrorDetails(
  val current_version: Int? = null,
  val action: String? = null
)

@Serializable
data class BridgeRequest(
  val bridgeVersion: Int,
  val requestId: String,
  val method: String,
  val payload: BridgeRequestPayload
)

@Serializable
data class BridgeRequestPayload(
  val voice_request_id: String? = null,
  val route: String? = null,
  val command: String? = null,
  val project_id: String? = null,
  val limit: Int? = null,
  val id: String? = null,
  val allowed: Boolean? = null,
  val expected_version: Long? = null,
  val client_command_id: String? = null,
  val processing_policy: BridgeRequestPayloadProcessingPolicy? = null,
  val q: String? = null,
  val cursor: String? = null,
  val category: String? = null,
  val source_kind: String? = null,
  val source_id: String? = null,
  val format: String? = null,
  val action: String? = null,
  val target_kind: String? = null,
  val sync_version: Int? = null,
  val type: String? = null,
  val intent_id: String? = null,
  val outcome: String? = null,
  val expected_hash: String? = null,
  val basis_hash: String? = null,
  val recipient_confirmation: String? = null,
  val amount_minor: String? = null,
  val replacement_id: String? = null,
  val form: BridgeRequestPayloadForm? = null,
  val quantities: String? = null,
  val lines: String? = null,
  val recipient: String? = null,
  val margin_bps: Int? = null,
  val tax_mode: String? = null,
  val tax_bps: Int? = null,
  val consent_version: String? = null,
  val mime: String? = null,
  val audio: String? = null,
  val version: Int? = null,
  val client_turn_id: String? = null,
  val text: String? = null,
  val input_kind: String? = null,
  val selected_project_id: String? = null,
  val step: Int? = null,
  val completed: Boolean? = null,
  val kind: String? = null,
  val revision_id: String? = null,
  val share_token: String? = null
)

@Serializable
data class BridgeRequestPayloadProcessingPolicy(
  val id: String,
  val purpose: String,
  val provider: String,
  val processing_location: String,
  val storage_location: String,
  val retention: String,
  val external_processing: Boolean,
  val processors: List<BridgeRequestPayloadProcessingPolicyProcessorsItem>? = null
)

@Serializable
data class BridgeRequestPayloadProcessingPolicyProcessorsItem(
  val purpose: String,
  val provider: String,
  val processing_location: String,
  val storage_location: String,
  val retention: String
)

@Serializable
data class BridgeRequestPayloadForm(
  val issuer: BridgeRequestPayloadFormIssuer? = null,
  val recipient: BridgeRequestPayloadFormRecipient? = null,
  val valid_until: String? = null,
  val delivery_date: String? = null,
  val delivery_place: String? = null,
  val payment_terms: String? = null,
  val payment_account: String? = null,
  val note: String? = null
)

@Serializable
data class BridgeRequestPayloadFormIssuer(
  val business_number: String? = null,
  val representative: String? = null,
  val address: String? = null,
  val business_type: String? = null,
  val business_item: String? = null,
  val contact: String? = null,
  val name: String? = null
)

@Serializable
data class BridgeRequestPayloadFormRecipient(
  val business_number: String? = null,
  val representative: String? = null,
  val address: String? = null,
  val business_type: String? = null,
  val business_item: String? = null,
  val contact: String? = null
)

@Serializable
data class DeviceRegistrationRequest(
  val platform: String,
  val app_version: String,
  val public_key_jwk: DeviceRegistrationRequestPublicKeyJwk
)

@Serializable
data class DeviceRegistrationRequestPublicKeyJwk(
  val kty: String,
  val crv: String,
  val x: String,
  val y: String
)

@Serializable
data class DeviceResponse(
  val id: String,
  val tenant_id: String,
  val platform: String,
  val active: Boolean,
  val version: Int,
  val revoked_at: String?
)

@Serializable
data class MeResponse(
  val user_id: String,
  val memberships: List<MeResponseMembershipsItem>
)

@Serializable
data class MeResponseMembershipsItem(
  val tenant_id: String,
  val tenant_name: String,
  val role: String
)

@Serializable
data class CaptureSourceCreateRequest(
  val device_id: String,
  val kind: String,
  val scope_fingerprint: String,
  val consent_version: Int,
  val local_selection_consent: Boolean,
  val server_upload_consent: Boolean,
  val external_ai_consent: Boolean,
  val scope: CaptureSourceCreateRequestScope? = null,
  val processing_policy: CaptureSourceCreateRequestProcessingPolicy? = null
)

@Serializable
data class CaptureSourceCreateRequestScope(
  val capture_method: String,
  val history_mode: String,
  val history_since: String?,
  val scope_mode: String,
  val rule_version: Int,
  val processing_policy_id: String,
  val fingerprint_algorithm: String,
  val processing_lane: String? = null
)

@Serializable
data class CaptureSourceCreateRequestProcessingPolicy(
  val id: String,
  val purpose: String,
  val provider: String,
  val processing_location: String,
  val storage_location: String,
  val retention: String,
  val external_processing: Boolean,
  val processors: List<CaptureSourceCreateRequestProcessingPolicyProcessorsItem>? = null
)

@Serializable
data class CaptureSourceCreateRequestProcessingPolicyProcessorsItem(
  val purpose: String,
  val provider: String,
  val processing_location: String,
  val storage_location: String,
  val retention: String
)

@Serializable
data class CaptureSourceCheckpointRequest(
  val generation: Int,
  val reported_permission: String,
  val pending_count: Int,
  val bytes_pending: Long,
  val cursor_token: String? = null,
  val coverage_from: String? = null,
  val last_successful_scan_at: String? = null,
  val last_event_at: String? = null,
  val last_error_code: String? = null
)

@Serializable
data class CaptureSourceResponse(
  val id: String,
  val tenant_id: String,
  val device_id: String,
  val kind: String,
  val capability: String,
  val permission: String,
  val reported_permission: String?,
  val permission_trust: String,
  val health: String,
  val scope_version: Int,
  val generation: Int,
  val version: Int,
  val active: Boolean,
  val device_active: Boolean,
  val upload_ready: Boolean,
  val local_selection_consent: Boolean,
  val server_upload_consent: Boolean,
  val external_ai_consent: Boolean,
  val permission_checked_at: String?,
  val coverage_from: String?,
  val last_successful_scan_at: String?,
  val last_event_at: String?,
  val last_server_ack_at: String?,
  val pending_count: Long,
  val bytes_pending: Long,
  val last_error_code: String?,
  val scope_fingerprint: String? = null,
  val scope: CaptureSourceResponseScope? = null,
  val processing_policy: CaptureSourceResponseProcessingPolicy? = null
)

@Serializable
data class CaptureSourceResponseScope(
  val capture_method: String,
  val history_mode: String,
  val history_since: String?,
  val scope_mode: String,
  val rule_version: Int,
  val processing_policy_id: String,
  val fingerprint_algorithm: String,
  val processing_lane: String? = null
)

@Serializable
data class CaptureSourceResponseProcessingPolicy(
  val id: String,
  val purpose: String,
  val provider: String,
  val processing_location: String,
  val storage_location: String,
  val retention: String,
  val external_processing: Boolean,
  val processors: List<CaptureSourceResponseProcessingPolicyProcessorsItem>? = null
)

@Serializable
data class CaptureSourceResponseProcessingPolicyProcessorsItem(
  val purpose: String,
  val provider: String,
  val processing_location: String,
  val storage_location: String,
  val retention: String
)

@Serializable
data class CaptureSourcesResponse(
  val sources: List<CaptureSourcesResponseSourcesItem>
)

@Serializable
data class CaptureSourcesResponseSourcesItem(
  val id: String,
  val tenant_id: String,
  val device_id: String,
  val kind: String,
  val capability: String,
  val permission: String,
  val reported_permission: String?,
  val permission_trust: String,
  val health: String,
  val scope_version: Int,
  val generation: Int,
  val version: Int,
  val active: Boolean,
  val device_active: Boolean,
  val upload_ready: Boolean,
  val local_selection_consent: Boolean,
  val server_upload_consent: Boolean,
  val external_ai_consent: Boolean,
  val permission_checked_at: String?,
  val coverage_from: String?,
  val last_successful_scan_at: String?,
  val last_event_at: String?,
  val last_server_ack_at: String?,
  val pending_count: Long,
  val bytes_pending: Long,
  val last_error_code: String?,
  val scope_fingerprint: String? = null,
  val scope: CaptureSourcesResponseSourcesItemScope? = null,
  val processing_policy: CaptureSourcesResponseSourcesItemProcessingPolicy? = null
)

@Serializable
data class CaptureSourcesResponseSourcesItemScope(
  val capture_method: String,
  val history_mode: String,
  val history_since: String?,
  val scope_mode: String,
  val rule_version: Int,
  val processing_policy_id: String,
  val fingerprint_algorithm: String,
  val processing_lane: String? = null
)

@Serializable
data class CaptureSourcesResponseSourcesItemProcessingPolicy(
  val id: String,
  val purpose: String,
  val provider: String,
  val processing_location: String,
  val storage_location: String,
  val retention: String,
  val external_processing: Boolean,
  val processors: List<CaptureSourcesResponseSourcesItemProcessingPolicyProcessorsItem>? = null
)

@Serializable
data class CaptureSourcesResponseSourcesItemProcessingPolicyProcessorsItem(
  val purpose: String,
  val provider: String,
  val processing_location: String,
  val storage_location: String,
  val retention: String
)

@Serializable
data class IngestionPrepareRequest(
  val client_capture_id: String,
  val sha256: String,
  val byte_length: Int,
  val declared_mime: String,
  val document_id: String? = null,
  val predecessor_revision_id: String? = null,
  val expected_version: Int? = null,
  val source_id: String? = null,
  val source_generation: Int? = null
)

@Serializable
data class IngestionPrepareResponse(
  val ingestion_id: String,
  val state: String,
  val upload_url: String,
  val expires_at: String,
  val upload: IngestionPrepareResponseUpload
)

@Serializable
data class IngestionPrepareResponseUpload(
  val protocol: String,
  val endpoint: String,
  val signature: String,
  val bucket: String,
  val object_name: String,
  val chunk_bytes: Int,
  val authorization: String,
  val metadata_keys: String,
  val upsert: Boolean
)

@Serializable
data class IngestionCompleteRequest(
  val sha256: String,
  val byte_length: Int
)

@Serializable
data class IngestionReceiptResponse(
  val ingestion_id: String,
  val state: String,
  val blob_id: String,
  val document_id: String,
  val revision_id: String,
  val deduplicated: Boolean,
  val revision_number: Long? = null,
  val job_id: String? = null
)
