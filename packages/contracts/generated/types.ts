// Generated from schemas.ts. Wire DTOs only; server runtime schemas enforce invariants.
// Never display nullable minor as zero. Preserve knowledge and explicit required nulls.
// C09/C14: align response readers to ignore added fields; incoming commands must stay strict.
export interface CaptureStatusResponse {
  limit_bytes: 100000000000;
  used_bytes: number;
  reserved_bytes: number;
  recovery: {
    checked: number;
    failed: number;
    last_checked_at: string | null;
  };
}
export interface EvidenceResumeRequest {
  job_id: string;
  resume_generation: number;
}
export interface EvidenceResumeResponse {
  resumed: true;
}
export interface SiteFolderBatchRequest {
  client_command_id: string;
  /**
   * @minItems 1
   * @maxItems 100
   */
  changes: [
    {
      id: string;
      expected_version: number;
      source_generation: number;
      scope_mode: "project" | "company_common" | "unassigned";
      project_id: string | null;
    },
    ...{
      id: string;
      expected_version: number;
      source_generation: number;
      scope_mode: "project" | "company_common" | "unassigned";
      project_id: string | null;
    }[]
  ];
}
export interface CaptureDurabilityRequest {
  sha256: string;
  byte_length: number;
}
export interface CaptureDurabilityResponse {
  state: "recoverable";
  ingestion_id: string;
  revision_id: string;
  sha256: string;
  byte_length: number;
  source_generation: number | null;
  verified_at: string;
  restore_url: string;
  expires_in: 60;
}
export interface CaptureStorageUsage {
  limit_bytes: 100000000000;
  used_bytes: number;
  reserved_bytes: number;
}
export interface ReadinessReport {
  checked_at: string;
  capabilities: {
    id: string;
    label: string;
    state: "ready" | "needs_setup" | "needs_reconnect" | "waiting" | "unverified";
    reason: string;
    action: "none" | "connect_folder" | "restore_permission" | "configure_provider" | "check_worker";
    source_id: string | null;
    evidence: "server_observed" | "device_report" | "configuration_only" | "not_verified";
  }[];
  coverage: {
    source_count: number;
    reported_scanned_count: number;
    last_scan_at: string | null;
    full_content: "not_verified" | "partial" | "complete";
  };
  limits: {
    daily_krw: 10000;
    monthly_krw: 50000;
    source_bytes: "100000000000";
    scope: "per_user";
    budget_enforced: boolean;
  };
  formats: {
    label: string;
    extensions: string[];
    status: "parser_available" | "provider_required" | "discovery_only" | "excluded";
  }[];
}
export type WorkRequest =
  | {
      route: "archive.status";
    }
  | {
      route: "archive.command";
      command: string;
    }
  | {
      route: "journal.tasks";
    }
  | {
      route: "events.list";
      project_id?: string;
      limit?: number;
    }
  | {
      route: "events.read";
      id: string;
    }
  | {
      route: "ai.consent";
      allowed: boolean;
      expected_version: number;
      client_command_id: string;
      processing_policy?: {
        id: string;
        purpose: "work_records";
        provider: string;
        processing_location: string;
        storage_location: string;
        retention: "until_user_deletes";
        external_processing: boolean;
        /**
         * @minItems 1
         * @maxItems 1
         */
        processors?: [
          {
            purpose: "long_stt";
            provider: "openai" | "clova_speech";
            processing_location: string;
            storage_location: string;
            retention: string;
          }
        ];
      };
    }
  | {
      route: "journal.command";
      command: string;
    }
  | {
      route: "journal.list";
      project_id?: string;
      q?: string;
      cursor?: string;
      category?: "agreement" | "drawing_material" | "delivery_work" | "billing_payment" | "inspection_defect";
    }
  | {
      route: "setup.read";
    }
  | {
      route: "setup.command";
      command: string;
    }
  | {
      route: "setup.capture";
      command: string;
    }
  | {
      route: "ledger.list";
      project_id?: string;
      category?: "agreement" | "drawing_material" | "delivery_work" | "billing_payment" | "inspection_defect";
      cursor?: string;
    }
  | {
      route: "ledger.read";
      id: string;
      cursor?: string;
    }
  | {
      route: "agenda.read";
    }
  | {
      route: "deliveries.list";
      source_kind: "document" | "photo_sheet";
      source_id: string;
    }
  | {
      route: "deliveries.read";
      id: string;
    }
  | {
      route: "deliveries.prepare";
      command: string;
    }
  | {
      route: "deliveries.authorize";
      command: string;
    }
  | {
      route: "deliveries.cancel";
      command: string;
    }
  | {
      route: "sheets.share";
      command: string;
    }
  | {
      route: "sheets.prepare";
      command: string;
    }
  | {
      route: "sheets.read";
      id: string;
    }
  | {
      route: "sheets.file";
      id: string;
      format: "pdf";
      action?: "open" | "save" | "share";
    }
  | {
      route: "photos.list";
      project_id: string;
      cursor?: string;
    }
  | {
      route: "photos.group";
      id: string;
    }
  | {
      route: "photos.preview";
      id: string;
    }
  | {
      route: "photos.command";
      command: string;
    }
  | {
      route: "agent.start";
      command: string;
    }
  | {
      route: "agent.read";
      id: string;
    }
  | {
      route: "agent.cancel";
      id: string;
    }
  | {
      route: "agent.continue";
      id: string;
    }
  | {
      route: "capture.status";
    }
  | {
      route: "evidence.resume";
      id: string;
      command: string;
    }
  | {
      route: "folders.read";
    }
  | {
      route: "folders.correct";
      command: string;
    }
  | {
      route: "evidence.chunks";
      id: string;
      cursor?: string;
    }
  | {
      route: "learning.list";
      cursor?: string;
    }
  | {
      route: "context-learning.list";
    }
  | {
      route: "context-learning.command";
      command: string;
    }
  | {
      route: "improvements.list";
    }
  | {
      route: "improvements.command";
      command: string;
    }
  | {
      route: "learning.read";
      id: string;
    }
  | {
      route: "learning.command";
      command: string;
    }
  | {
      route: "activity.status";
    }
  | {
      route: "activity.delete";
    }
  | {
      route: "activity.consent";
      allowed: boolean;
    }
  | {
      route: "activity.append";
      command: string;
    }
  | {
      route: "activity.list";
      cursor?: string;
      q?: string;
    }
  | {
      route: "questions.list";
    }
  | {
      route: "maintenance.status";
    }
  | {
      route: "policies.list";
    }
  | {
      route: "audio.correct";
      command: string;
    }
  | {
      route: "policies.command";
      command: string;
    }
  | {
      route: "work.reply";
      command: string;
    }
  | {
      route: "work.command";
      command: string;
    }
  | {
      route: "sync.item";
      id: string;
      target_kind: "material" | "document" | "photo_sheet";
    }
  | {
      route: "sync.changes";
      sync_version?: 2;
      cursor?: string;
    }
  | {
      route: "documents.list";
    }
  | {
      route: "documents.prepare";
      project_id: string;
      type: "estimate";
      client_command_id: string;
    }
  | {
      route: "documents.issued";
      id: string;
    }
  | {
      route: "documents.file";
      id: string;
      format: "pdf" | "xlsx";
      action?: "open" | "save" | "share";
    }
  | {
      route: "documents.share";
      id: string;
      format: "pdf" | "xlsx";
      client_command_id: string;
    }
  | {
      route: "documents.shareOutcome";
      id: string;
      intent_id: string;
      client_command_id: string;
      outcome: "cancelled" | "unknown" | "user_confirmed";
    }
  | {
      route: "documents.retry";
      id: string;
      client_command_id: string;
    }
  | {
      route: "documents.cancel";
      id: string;
      client_command_id: string;
      expected_hash: string;
    }
  | {
      route: "documents.issue";
      id: string;
      client_command_id: string;
      basis_hash: string;
      recipient_confirmation: string;
      amount_minor?: string;
      replacement_id?: string;
      expected_hash?: string;
    }
  | {
      route: "documents.read";
      id: string;
    }
  | {
      route: "documents.complete";
      form?: {
        issuer?: {
          business_number?: string;
          representative?: string;
          address?: string;
          business_type?: string;
          business_item?: string;
          contact?: string;
          name?: string;
        };
        recipient?: {
          business_number?: string;
          representative?: string;
          address?: string;
          business_type?: string;
          business_item?: string;
          contact?: string;
        };
        valid_until?: string | "";
        delivery_date?: string | "";
        delivery_place?: string;
        payment_terms?: string;
        payment_account?: string;
        note?: string;
      };
      quantities?: string;
      lines?: string;
      id: string;
      client_command_id: string;
      recipient?: string;
      margin_bps?: number;
      tax_mode?: "exclusive" | "inclusive" | "not_applicable";
      tax_bps?: number;
    }
  | {
      route: "voice.status";
    }
  | {
      route: "voice.consent";
      allowed: boolean;
      consent_version: "short-voice-v1";
    }
  | {
      route: "voice.transcribe";
      id: string;
      mime: "audio/webm" | "audio/ogg" | "audio/wav";
      audio: string;
      consent_version: "short-voice-v1";
    }
  | {
      route: "voice.result";
      id: string;
    }
  | {
      route: "voice.cancel";
      id: string;
    }
  | {
      route: "materials.list";
      q?: string;
      cursor?: string;
      project_id?: string;
      category?: "agreement" | "drawing_material" | "delivery_work" | "billing_payment" | "inspection_defect";
    }
  | {
      route: "materials.detail";
      id: string;
    }
  | {
      route: "materials.message";
      id: string;
    }
  | {
      route: "context";
    }
  | {
      route: "materials.original";
      id: string;
    }
  | {
      route: "organization.answer";
      id: string;
      project_id: string;
      version: number;
    }
  | {
      route: "conversation.turn";
      id: string;
      client_turn_id: string;
      text: string;
      input_kind?: "text" | "voice";
      selected_project_id?: string;
    }
  | {
      route: "conversation.read";
      id: string;
    }
  | {
      route: "guide.read";
    }
  | {
      route: "guide.save";
      step: number;
      completed: boolean;
    };
export interface WorkspaceCreateRequest {
  display_name: string;
}
export interface WorkspaceResponse {
  tenant_id: string;
  display_name: string;
  role: "owner";
  version: number;
}
export interface CapturePolicy {
  id: string;
  purpose: "work_records";
  provider: string;
  processing_location: string;
  storage_location: string;
  retention: "until_user_deletes";
  external_processing: boolean;
  /**
   * @minItems 1
   * @maxItems 1
   */
  processors?: [
    {
      purpose: "long_stt";
      provider: "openai" | "clova_speech";
      processing_location: string;
      storage_location: string;
      retention: string;
    }
  ];
}
export interface CaptureScope {
  processing_lane?: "current" | "archive";
  capture_method: "saf_tree" | "filesystem" | "selected_media" | "notification" | "sms_provider" | "manual_share";
  history_mode: "all" | "since" | "selected";
  history_since: string | null;
  scope_mode: "work_dedicated" | "selected_items" | "mixed_hold" | "ai_screened";
  rule_version: 1;
  processing_policy_id: string;
  fingerprint_algorithm: "hmac-sha256-device-v1";
}
export interface ProjectCreateRequest {
  display_name: string;
}
export interface ProjectResponse {
  id: string;
  display_name: string;
  version: number;
}
export interface SiteFolderBindingRequest {
  source_id: string;
  source_generation: number;
  scope_fingerprint: string;
  scope_mode: "project" | "company_common" | "unassigned";
  project_id: string | null;
  display_name?: string | null;
}
export interface SiteFolderBindingResponse {
  id: string;
  source_id: string;
  source_generation: number;
  scope_fingerprint: string;
  scope_mode: "project" | "company_common" | "unassigned";
  project_id: string | null;
  version: number;
  display_name?: string | null;
}
export interface SiteFolderBindingsResponse {
  bindings: {
    id: string;
    source_id: string;
    source_generation: number;
    scope_fingerprint: string;
    scope_mode: "project" | "company_common" | "unassigned";
    project_id: string | null;
    version: number;
    display_name?: string | null;
  }[];
}
export type Money =
  | {
      currency: "KRW";
      minor: string;
      knowledge: "known";
    }
  | {
      currency: "KRW";
      minor: null;
      knowledge: "unknown";
    }
  | {
      currency: "KRW";
      minor: null;
      knowledge: "not_applicable";
    };
export interface Quantity {
  value: string;
  unit_code: string;
  raw_text: string;
  semantic: "scope" | "billing" | "ordered" | "moved" | "accepted" | "rejected" | "returned";
}
export type SourceDate =
  | {
      raw: string;
      /**
       * @maxItems 5
       */
      inferred_components:
        | []
        | ["year" | "month" | "day" | "time" | "timezone"]
        | ["year" | "month" | "day" | "time" | "timezone", "year" | "month" | "day" | "time" | "timezone"]
        | [
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone"
          ]
        | [
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone"
          ]
        | [
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone"
          ];
      precision: "unknown";
      date: null;
    }
  | {
      raw: string;
      /**
       * @maxItems 5
       */
      inferred_components:
        | []
        | ["year" | "month" | "day" | "time" | "timezone"]
        | ["year" | "month" | "day" | "time" | "timezone", "year" | "month" | "day" | "time" | "timezone"]
        | [
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone"
          ]
        | [
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone"
          ]
        | [
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone"
          ];
      precision: "year";
      date: string;
    }
  | {
      raw: string;
      /**
       * @maxItems 5
       */
      inferred_components:
        | []
        | ["year" | "month" | "day" | "time" | "timezone"]
        | ["year" | "month" | "day" | "time" | "timezone", "year" | "month" | "day" | "time" | "timezone"]
        | [
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone"
          ]
        | [
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone"
          ]
        | [
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone"
          ];
      precision: "month";
      date: string;
    }
  | {
      raw: string;
      /**
       * @maxItems 5
       */
      inferred_components:
        | []
        | ["year" | "month" | "day" | "time" | "timezone"]
        | ["year" | "month" | "day" | "time" | "timezone", "year" | "month" | "day" | "time" | "timezone"]
        | [
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone"
          ]
        | [
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone"
          ]
        | [
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone"
          ];
      precision: "day";
      date: string;
    }
  | {
      raw: string;
      /**
       * @maxItems 5
       */
      inferred_components:
        | []
        | ["year" | "month" | "day" | "time" | "timezone"]
        | ["year" | "month" | "day" | "time" | "timezone", "year" | "month" | "day" | "time" | "timezone"]
        | [
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone"
          ]
        | [
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone"
          ]
        | [
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone",
            "year" | "month" | "day" | "time" | "timezone"
          ];
      precision: "time";
      date: string;
    };
export interface ApiError {
  error: {
    code:
      | "INVALID_CONTRACT"
      | "UNAUTHENTICATED"
      | "FORBIDDEN"
      | "NOT_FOUND"
      | "VERSION_CONFLICT"
      | "IDEMPOTENCY_CONFLICT"
      | "STORAGE_QUOTA_EXCEEDED"
      | "SOURCE_EXPIRED"
      | "PAYLOAD_TOO_LARGE"
      | "UNSUPPORTED_MEDIA"
      | "DOMAIN_INVARIANT"
      | "SOURCE_SCOPE_MISMATCH"
      | "RATE_LIMITED"
      | "TEMPORARILY_UNAVAILABLE";
    message_ko: string;
    retryable: boolean;
    correlation_id: string;
    details?: {
      current_version?: number;
      action?: "refresh_diff" | "retry_later" | "reconnect";
    };
  };
}
export type BridgeRequest =
  | {
      bridgeVersion: 1;
      requestId: string;
      method: "startVoiceInput";
      payload: {};
    }
  | {
      bridgeVersion: 1;
      requestId: string;
      method: "cancelVoiceInput";
      payload: {
        voice_request_id: string;
      };
    }
  | {
      bridgeVersion: 1;
      requestId: string;
      method: "workRequest";
      payload:
        | {
            route: "archive.status";
          }
        | {
            route: "archive.command";
            command: string;
          }
        | {
            route: "journal.tasks";
          }
        | {
            route: "events.list";
            project_id?: string;
            limit?: number;
          }
        | {
            route: "events.read";
            id: string;
          }
        | {
            route: "ai.consent";
            allowed: boolean;
            expected_version: number;
            client_command_id: string;
            processing_policy?: {
              id: string;
              purpose: "work_records";
              provider: string;
              processing_location: string;
              storage_location: string;
              retention: "until_user_deletes";
              external_processing: boolean;
              /**
               * @minItems 1
               * @maxItems 1
               */
              processors?: [
                {
                  purpose: "long_stt";
                  provider: "openai" | "clova_speech";
                  processing_location: string;
                  storage_location: string;
                  retention: string;
                }
              ];
            };
          }
        | {
            route: "journal.command";
            command: string;
          }
        | {
            route: "journal.list";
            project_id?: string;
            q?: string;
            cursor?: string;
            category?: "agreement" | "drawing_material" | "delivery_work" | "billing_payment" | "inspection_defect";
          }
        | {
            route: "setup.read";
          }
        | {
            route: "setup.command";
            command: string;
          }
        | {
            route: "setup.capture";
            command: string;
          }
        | {
            route: "ledger.list";
            project_id?: string;
            category?: "agreement" | "drawing_material" | "delivery_work" | "billing_payment" | "inspection_defect";
            cursor?: string;
          }
        | {
            route: "ledger.read";
            id: string;
            cursor?: string;
          }
        | {
            route: "agenda.read";
          }
        | {
            route: "deliveries.list";
            source_kind: "document" | "photo_sheet";
            source_id: string;
          }
        | {
            route: "deliveries.read";
            id: string;
          }
        | {
            route: "deliveries.prepare";
            command: string;
          }
        | {
            route: "deliveries.authorize";
            command: string;
          }
        | {
            route: "deliveries.cancel";
            command: string;
          }
        | {
            route: "sheets.share";
            command: string;
          }
        | {
            route: "sheets.prepare";
            command: string;
          }
        | {
            route: "sheets.read";
            id: string;
          }
        | {
            route: "sheets.file";
            id: string;
            format: "pdf";
            action?: "open" | "save" | "share";
          }
        | {
            route: "photos.list";
            project_id: string;
            cursor?: string;
          }
        | {
            route: "photos.group";
            id: string;
          }
        | {
            route: "photos.preview";
            id: string;
          }
        | {
            route: "photos.command";
            command: string;
          }
        | {
            route: "agent.start";
            command: string;
          }
        | {
            route: "agent.read";
            id: string;
          }
        | {
            route: "agent.cancel";
            id: string;
          }
        | {
            route: "agent.continue";
            id: string;
          }
        | {
            route: "capture.status";
          }
        | {
            route: "evidence.resume";
            id: string;
            command: string;
          }
        | {
            route: "folders.read";
          }
        | {
            route: "folders.correct";
            command: string;
          }
        | {
            route: "evidence.chunks";
            id: string;
            cursor?: string;
          }
        | {
            route: "learning.list";
            cursor?: string;
          }
        | {
            route: "context-learning.list";
          }
        | {
            route: "context-learning.command";
            command: string;
          }
        | {
            route: "improvements.list";
          }
        | {
            route: "improvements.command";
            command: string;
          }
        | {
            route: "learning.read";
            id: string;
          }
        | {
            route: "learning.command";
            command: string;
          }
        | {
            route: "activity.status";
          }
        | {
            route: "activity.delete";
          }
        | {
            route: "activity.consent";
            allowed: boolean;
          }
        | {
            route: "activity.append";
            command: string;
          }
        | {
            route: "activity.list";
            cursor?: string;
            q?: string;
          }
        | {
            route: "questions.list";
          }
        | {
            route: "maintenance.status";
          }
        | {
            route: "policies.list";
          }
        | {
            route: "audio.correct";
            command: string;
          }
        | {
            route: "policies.command";
            command: string;
          }
        | {
            route: "work.reply";
            command: string;
          }
        | {
            route: "work.command";
            command: string;
          }
        | {
            route: "sync.item";
            id: string;
            target_kind: "material" | "document" | "photo_sheet";
          }
        | {
            route: "sync.changes";
            sync_version?: 2;
            cursor?: string;
          }
        | {
            route: "documents.list";
          }
        | {
            route: "documents.prepare";
            project_id: string;
            type: "estimate";
            client_command_id: string;
          }
        | {
            route: "documents.issued";
            id: string;
          }
        | {
            route: "documents.file";
            id: string;
            format: "pdf" | "xlsx";
            action?: "open" | "save" | "share";
          }
        | {
            route: "documents.share";
            id: string;
            format: "pdf" | "xlsx";
            client_command_id: string;
          }
        | {
            route: "documents.shareOutcome";
            id: string;
            intent_id: string;
            client_command_id: string;
            outcome: "cancelled" | "unknown" | "user_confirmed";
          }
        | {
            route: "documents.retry";
            id: string;
            client_command_id: string;
          }
        | {
            route: "documents.cancel";
            id: string;
            client_command_id: string;
            expected_hash: string;
          }
        | {
            route: "documents.issue";
            id: string;
            client_command_id: string;
            basis_hash: string;
            recipient_confirmation: string;
            amount_minor?: string;
            replacement_id?: string;
            expected_hash?: string;
          }
        | {
            route: "documents.read";
            id: string;
          }
        | {
            route: "documents.complete";
            form?: {
              issuer?: {
                business_number?: string;
                representative?: string;
                address?: string;
                business_type?: string;
                business_item?: string;
                contact?: string;
                name?: string;
              };
              recipient?: {
                business_number?: string;
                representative?: string;
                address?: string;
                business_type?: string;
                business_item?: string;
                contact?: string;
              };
              valid_until?: string | "";
              delivery_date?: string | "";
              delivery_place?: string;
              payment_terms?: string;
              payment_account?: string;
              note?: string;
            };
            quantities?: string;
            lines?: string;
            id: string;
            client_command_id: string;
            recipient?: string;
            margin_bps?: number;
            tax_mode?: "exclusive" | "inclusive" | "not_applicable";
            tax_bps?: number;
          }
        | {
            route: "voice.status";
          }
        | {
            route: "voice.consent";
            allowed: boolean;
            consent_version: "short-voice-v1";
          }
        | {
            route: "voice.transcribe";
            id: string;
            mime: "audio/webm" | "audio/ogg" | "audio/wav";
            audio: string;
            consent_version: "short-voice-v1";
          }
        | {
            route: "voice.result";
            id: string;
          }
        | {
            route: "voice.cancel";
            id: string;
          }
        | {
            route: "materials.list";
            q?: string;
            cursor?: string;
            project_id?: string;
            category?: "agreement" | "drawing_material" | "delivery_work" | "billing_payment" | "inspection_defect";
          }
        | {
            route: "materials.detail";
            id: string;
          }
        | {
            route: "materials.message";
            id: string;
          }
        | {
            route: "context";
          }
        | {
            route: "materials.original";
            id: string;
          }
        | {
            route: "organization.answer";
            id: string;
            project_id: string;
            version: number;
          }
        | {
            route: "conversation.turn";
            id: string;
            client_turn_id: string;
            text: string;
            input_kind?: "text" | "voice";
            selected_project_id?: string;
          }
        | {
            route: "conversation.read";
            id: string;
          }
        | {
            route: "guide.read";
          }
        | {
            route: "guide.save";
            step: number;
            completed: boolean;
          };
    }
  | {
      bridgeVersion: 1;
      requestId: string;
      method: "openPhotoCapture";
      payload: {};
    }
  | {
      bridgeVersion: 1;
      requestId: string;
      method: "getConnectionState";
      payload: {};
    }
  | {
      bridgeVersion: 1;
      requestId: string;
      method: "connectSource";
      payload: {
        kind: "folder" | "photos" | "notifications" | "sms" | "call_recording";
      };
    }
  | {
      bridgeVersion: 1;
      requestId: string;
      method: "pauseSource";
      payload: {
        source_id: string;
      };
    }
  | {
      bridgeVersion: 1;
      requestId: string;
      method: "openEvidence";
      payload: {
        revision_id: string;
      };
    }
  | {
      bridgeVersion: 1;
      requestId: string;
      method: "enqueueShare";
      payload: {
        share_token: string;
      };
    }
  | {
      bridgeVersion: 1;
      requestId: string;
      method: "getQueueSummary";
      payload: {};
    }
  | {
      bridgeVersion: 1;
      requestId: string;
      method: "logout";
      payload: {};
    };
export interface DeviceRegistrationRequest {
  platform: "android" | "windows" | "web";
  app_version: string;
  public_key_jwk: {
    kty: "EC";
    crv: "P-256";
    x: string;
    y: string;
  };
}
export interface DeviceResponse {
  id: string;
  tenant_id: string;
  platform: "android" | "windows" | "web";
  active: boolean;
  version: number;
  revoked_at: string | null;
}
export interface MeResponse {
  user_id: string;
  memberships: {
    tenant_id: string;
    tenant_name: string;
    role: "owner" | "operator" | "accountant" | "viewer";
  }[];
}
export interface CaptureSourceCreateRequest {
  device_id: string;
  kind: "manual_share" | "folder" | "notifications" | "photos" | "call_recording" | "sms" | "call_log";
  scope_fingerprint: string;
  consent_version: number;
  local_selection_consent: true;
  scope?: {
    processing_lane?: "current" | "archive";
    capture_method: "saf_tree" | "filesystem" | "selected_media" | "notification" | "sms_provider" | "manual_share";
    history_mode: "all" | "since" | "selected";
    history_since: string | null;
    scope_mode: "work_dedicated" | "selected_items" | "mixed_hold" | "ai_screened";
    rule_version: 1;
    processing_policy_id: string;
    fingerprint_algorithm: "hmac-sha256-device-v1";
  };
  server_upload_consent: boolean;
  external_ai_consent: boolean;
  processing_policy?: {
    id: string;
    purpose: "work_records";
    provider: string;
    processing_location: string;
    storage_location: string;
    retention: "until_user_deletes";
    external_processing: boolean;
    /**
     * @minItems 1
     * @maxItems 1
     */
    processors?: [
      {
        purpose: "long_stt";
        provider: "openai" | "clova_speech";
        processing_location: string;
        storage_location: string;
        retention: string;
      }
    ];
  };
}
export interface CaptureSourceCheckpointRequest {
  generation: number;
  reported_permission: "not_requested" | "granted" | "denied" | "revoked" | "role_missing";
  cursor_token?: string;
  coverage_from?: string;
  last_successful_scan_at?: string;
  last_event_at?: string;
  pending_count: number;
  bytes_pending: number;
  last_error_code?: string;
}
export interface CaptureSourceResponse {
  id: string;
  tenant_id: string;
  device_id: string;
  kind: "manual_share" | "folder" | "notifications" | "photos" | "call_recording" | "sms" | "call_log";
  capability: "unsupported" | "manual_only" | "selected_items" | "passive" | "policy_gated";
  permission: "not_requested" | "granted" | "denied" | "revoked" | "role_missing";
  reported_permission: ("not_requested" | "granted" | "denied" | "revoked" | "role_missing") | null;
  permission_trust: "client_report_only";
  health: "not_started" | "scanning" | "current" | "delayed" | "source_offline" | "paused" | "error";
  scope_version: number;
  generation: number;
  version: number;
  active: boolean;
  device_active: boolean;
  upload_ready: boolean;
  scope_fingerprint?: string;
  scope?: {
    processing_lane?: "current" | "archive";
    capture_method: "saf_tree" | "filesystem" | "selected_media" | "notification" | "sms_provider" | "manual_share";
    history_mode: "all" | "since" | "selected";
    history_since: string | null;
    scope_mode: "work_dedicated" | "selected_items" | "mixed_hold" | "ai_screened";
    rule_version: 1;
    processing_policy_id: string;
    fingerprint_algorithm: "hmac-sha256-device-v1";
  } | null;
  processing_policy?: {
    id: string;
    purpose: "work_records";
    provider: string;
    processing_location: string;
    storage_location: string;
    retention: "until_user_deletes";
    external_processing: boolean;
    /**
     * @minItems 1
     * @maxItems 1
     */
    processors?: [
      {
        purpose: "long_stt";
        provider: "openai" | "clova_speech";
        processing_location: string;
        storage_location: string;
        retention: string;
      }
    ];
  } | null;
  local_selection_consent: boolean;
  server_upload_consent: boolean;
  external_ai_consent: boolean;
  permission_checked_at: string | null;
  coverage_from: string | null;
  last_successful_scan_at: string | null;
  last_event_at: string | null;
  last_server_ack_at: string | null;
  pending_count: number;
  bytes_pending: number;
  last_error_code: string | null;
}
export interface CaptureSourcesResponse {
  sources: {
    id: string;
    tenant_id: string;
    device_id: string;
    kind: "manual_share" | "folder" | "notifications" | "photos" | "call_recording" | "sms" | "call_log";
    capability: "unsupported" | "manual_only" | "selected_items" | "passive" | "policy_gated";
    permission: "not_requested" | "granted" | "denied" | "revoked" | "role_missing";
    reported_permission: ("not_requested" | "granted" | "denied" | "revoked" | "role_missing") | null;
    permission_trust: "client_report_only";
    health: "not_started" | "scanning" | "current" | "delayed" | "source_offline" | "paused" | "error";
    scope_version: number;
    generation: number;
    version: number;
    active: boolean;
    device_active: boolean;
    upload_ready: boolean;
    scope_fingerprint?: string;
    scope?: {
      processing_lane?: "current" | "archive";
      capture_method: "saf_tree" | "filesystem" | "selected_media" | "notification" | "sms_provider" | "manual_share";
      history_mode: "all" | "since" | "selected";
      history_since: string | null;
      scope_mode: "work_dedicated" | "selected_items" | "mixed_hold" | "ai_screened";
      rule_version: 1;
      processing_policy_id: string;
      fingerprint_algorithm: "hmac-sha256-device-v1";
    } | null;
    processing_policy?: {
      id: string;
      purpose: "work_records";
      provider: string;
      processing_location: string;
      storage_location: string;
      retention: "until_user_deletes";
      external_processing: boolean;
      /**
       * @minItems 1
       * @maxItems 1
       */
      processors?: [
        {
          purpose: "long_stt";
          provider: "openai" | "clova_speech";
          processing_location: string;
          storage_location: string;
          retention: string;
        }
      ];
    } | null;
    local_selection_consent: boolean;
    server_upload_consent: boolean;
    external_ai_consent: boolean;
    permission_checked_at: string | null;
    coverage_from: string | null;
    last_successful_scan_at: string | null;
    last_event_at: string | null;
    last_server_ack_at: string | null;
    pending_count: number;
    bytes_pending: number;
    last_error_code: string | null;
  }[];
}
export interface IngestionPrepareRequest {
  client_capture_id: string;
  sha256: string;
  byte_length: number;
  declared_mime: string;
  document_id?: string;
  predecessor_revision_id?: string;
  expected_version?: number;
  source_id?: string;
  source_generation?: number;
}
export interface IngestionPrepareResponse {
  ingestion_id: string;
  state: "prepared";
  upload_url: string;
  expires_at: string;
  upload: {
    protocol: "tus";
    endpoint: string;
    signature: string;
    bucket: "sigongnote-originals";
    object_name: string;
    chunk_bytes: 6291456;
    authorization: "user_bearer+signature";
    metadata_keys: "bucketName,objectName,contentType";
    upsert: false;
  };
}
export interface IngestionCompleteRequest {
  sha256: string;
  byte_length: number;
}
export interface IngestionReceiptResponse {
  ingestion_id: string;
  state: "verified" | "queued";
  blob_id: string;
  document_id: string;
  revision_id: string;
  revision_number?: number;
  job_id?: string;
  deduplicated: boolean;
}
