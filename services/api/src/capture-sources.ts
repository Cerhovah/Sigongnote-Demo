import {effectiveCaptureCapability} from './sms-activation.js';
import {registerSmsAccess} from './sms-access.js';
import {registerSmsTriage} from './sms-triage.js';
import { captureCapability } from "./capture-scope.js";
import { createHash } from "node:crypto";
import {
  CapturePolicySchema, capturePolicyEqual, CaptureSourceCheckpointRequestSchema, CaptureSourceCreateRequestSchema,
  CaptureSourceResponseSchema, CaptureSourcesResponseSchema, UuidSchema,
} from "@sigongnote/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { inAuthorizedTransaction } from "./auth.js";
import { ApiFault, execute, idempotencyKey, membership, once, principal,
  tenantHeader, type Services } from "./routes.js";

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function versionHeader(request: FastifyRequest) {
  const match = /^"([1-9][0-9]*)"$/.exec(String(request.headers["if-match"] ?? ""));
  const version = Number(match?.[1]);
  if (!Number.isSafeInteger(version) || version > 2147483647) {
    throw new ApiFault("INVALID_CONTRACT");
  }
  return version;
}
function sourceBody(row: Record<string, unknown>, deviceActive = true) {
  const date = (name: string) => row[name] instanceof Date
    ? (row[name] as Date).toISOString() : row[name];
  return CaptureSourceResponseSchema.parse({
    id:row.id,tenant_id:row.tenant_id,device_id:row.device_id,kind:row.kind,
    capability:effectiveCaptureCapability(row),permission:row.permission,
    reported_permission:row.reported_permission,
    permission_trust:"client_report_only",health:row.health,
    ...(row.scope ? {scope:row.scope,processing_policy:row.processing_policy,scope_fingerprint:row.scope_fingerprint} : {}),
    scope_version:Number(row.scope_version),generation:Number(row.generation),
    version:Number(row.version),active:row.active,device_active:deviceActive,
    upload_ready:Boolean(row.active && deviceActive && row.server_upload_consent &&
      effectiveCaptureCapability(row) !== "unsupported" && effectiveCaptureCapability(row) !== "policy_gated"),
    local_selection_consent:row.local_selection_consent,
    server_upload_consent:row.server_upload_consent,
    external_ai_consent:row.external_ai_consent,
    permission_checked_at:date("permission_checked_at"),
    coverage_from:date("coverage_from"),
    last_successful_scan_at:date("last_successful_scan_at"),
    last_event_at:date("last_event_at"),
    last_server_ack_at:date("last_server_ack_at"),
    pending_count:Number(row.pending_count),bytes_pending:Number(row.bytes_pending),
    last_error_code:row.last_error_code,
  });
}
function sourceId(request: FastifyRequest<{Params:{id:string}}>) {
  const parsed = UuidSchema.safeParse(request.params.id);
  if (!parsed.success) throw new ApiFault("INVALID_CONTRACT");
  return parsed.data;
}

export function registerCaptureSourceRoutes(app: FastifyInstance, services: Services) {
  registerSmsAccess(app,services);
  registerSmsTriage(app,services);
  app.get("/v1/capture-policy",async(request,reply)=>execute(reply,async()=>{
    await principal(request,services);
    if(!services.capturePolicy)throw new ApiFault("TEMPORARILY_UNAVAILABLE");
    return {status:200,body:CapturePolicySchema.parse(services.capturePolicy)};
  }));
  app.get("/v1/capture-sources", async (request, reply) => execute(reply, async () => {
    const actor = await principal(request, services);
    const tenantId = tenantHeader(request);
    return inAuthorizedTransaction(services.db, actor, async tx => {
      await membership(tx, tenantId, actor.userId);
      const rows = await tx`select s.*,d.platform,d.active as device_active
        from app.capture_sources s join app.devices d
          on d.tenant_id = s.tenant_id and d.id = s.device_id
        where s.tenant_id = ${tenantId}::uuid and s.user_id = ${actor.userId}::uuid
        order by s.created_at,s.id`;
      return { status:200, body:CaptureSourcesResponseSchema.parse({
        sources:rows.map(row => sourceBody(row,Boolean(row.device_active))),
      }) };
    });
  }));

  app.post("/v1/capture-sources", async (request, reply) => execute(reply, async () => {
    const actor = await principal(request, services);
    const tenantId = tenantHeader(request);
    const key = idempotencyKey(request);
    const parsed = CaptureSourceCreateRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiFault("INVALID_CONTRACT");
    const body = parsed.data;
    const policy=body.scope ? services.capturePolicy : undefined;
    return inAuthorizedTransaction(services.db, actor, async tx => {
      if (!(["owner","operator"].includes(await membership(tx, tenantId, actor.userId)))) {
        throw new ApiFault("FORBIDDEN");
      }
      if((body.processing_policy&&!capturePolicyEqual(body.processing_policy,policy))||
          (body.scope&&policy?.processors?.length&&!body.processing_policy))throw new ApiFault('SOURCE_EXPIRED');
      return once(tx, tenantId, actor.userId, "POST /v1/capture-sources",key,
        hash(body),async () => {
          if(body.scope && (!policy || policy.id!==body.scope.processing_policy_id ||
              (body.external_ai_consent && !policy.external_processing)))throw new ApiFault("INVALID_CONTRACT");
          const [device] = await tx`select platform from app.devices
            where tenant_id = ${tenantId}::uuid and id = ${body.device_id}::uuid
              and user_id = ${actor.userId}::uuid and active for share`;
          if (!device) throw new ApiFault("NOT_FOUND");
          const supported = captureCapability(body.kind,String(device.platform),body.scope);
          if (supported === "unsupported" && body.server_upload_consent) {
            throw new ApiFault("INVALID_CONTRACT");
          }
          const [row] = await tx`insert into app.capture_sources
            (tenant_id,device_id,user_id,kind,capability,scope_fingerprint,
              local_selection_consent,server_upload_consent,external_ai_consent,
              consent_version,scope,processing_policy)
            values (${tenantId}::uuid,${body.device_id}::uuid,${actor.userId}::uuid,
              ${body.kind},${supported},${body.scope_fingerprint},true,
              ${body.server_upload_consent},${body.external_ai_consent},
              ${body.consent_version},${body.scope ? tx.json(body.scope) : null}::jsonb,
              ${policy ? tx.json(policy) : null}::jsonb) returning *`;
          if (!row) throw new ApiFault("TEMPORARILY_UNAVAILABLE");
          await tx`insert into app.consent_grants
            (tenant_id,source_id,actor_id,event,initiated_by,generation,consent_version,
              scope_fingerprint,local_selection,server_upload,external_ai)
            values (${tenantId}::uuid,${row.id}::uuid,${actor.userId}::uuid,'granted','subject',1,
              ${body.consent_version},${body.scope_fingerprint},true,
              ${body.server_upload_consent},${body.external_ai_consent})`;
          return { status:201,body:sourceBody(row) };
        });
    });
  }));

  app.post<{Params:{id:string}}>("/v1/capture-sources/:id/checkpoint",
    async (request, reply) => execute(reply, async () => {
      const actor = await principal(request, services);
      const tenantId = tenantHeader(request);
      const id = sourceId(request);
      const key = idempotencyKey(request);
      const version = versionHeader(request);
      const parsed = CaptureSourceCheckpointRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new ApiFault("INVALID_CONTRACT");
      const body = parsed.data;
      return inAuthorizedTransaction(services.db, actor, async tx => {
        if (!(["owner","operator"].includes(await membership(tx, tenantId, actor.userId)))) {
          throw new ApiFault("FORBIDDEN");
        }
        return once(tx,tenantId,actor.userId,`POST /v1/capture-sources/${id}/checkpoint`,
          key,hash({body,version}),async () => {
            const [current] = await tx`select s.*,d.platform,d.active as device_active
              from app.capture_sources s join app.devices d
                on d.tenant_id = s.tenant_id and d.id = s.device_id
              where s.tenant_id = ${tenantId}::uuid and s.id = ${id}::uuid
                and s.user_id = ${actor.userId}::uuid for update of s`;
            if (!current) throw new ApiFault("NOT_FOUND");
            if (Number(current.version) !== version) {
              throw new ApiFault("VERSION_CONFLICT",Number(current.version));
            }
            if (!current.active || !current.device_active ||
                Number(current.generation) !== body.generation) {
              throw new ApiFault("SOURCE_EXPIRED");
            }
            // A bearer token cannot prove an OS permission. Store its report
            // for diagnostics while keeping the authoritative axis unchanged.
            const [updated] = await tx`update app.capture_sources set
              reported_permission = ${body.reported_permission},
              permission_checked_at = now(),
              cursor_token = ${body.cursor_token ?? null},
              coverage_from = ${body.coverage_from ?? null}::timestamptz,
              last_successful_scan_at = ${body.last_successful_scan_at ?? null}::timestamptz,
              last_event_at = ${body.last_event_at ?? null}::timestamptz,
              pending_count = ${body.pending_count},bytes_pending = ${body.bytes_pending},
              last_error_code = ${body.last_error_code ?? null},
              version = version + 1,updated_at = now()
              where tenant_id = ${tenantId}::uuid and id = ${id}::uuid returning *`;
            if (!updated) throw new ApiFault("NOT_FOUND");
            return { status:200,body:sourceBody(updated,Boolean(current.device_active)) };
          });
      });
    }));

  app.post<{Params:{id:string}}>("/v1/capture-sources/:id/revoke",
    async (request, reply) => execute(reply, async () => {
      const actor = await principal(request, services);
      const tenantId = tenantHeader(request);
      const id = sourceId(request);
      const key = idempotencyKey(request);
      const version = versionHeader(request);
      if (request.body !== undefined && (request.body === null ||
        typeof request.body !== "object" || Array.isArray(request.body) ||
        Object.keys(request.body).length !== 0)) throw new ApiFault("INVALID_CONTRACT");
      return inAuthorizedTransaction(services.db,actor,async tx => {
        await membership(tx,tenantId,actor.userId);
        return once(tx,tenantId,actor.userId,`POST /v1/capture-sources/${id}/revoke`,
          key,hash({id,version}),async () => {
            const [current] = await tx`select * from app.capture_sources
              where tenant_id = ${tenantId}::uuid and id = ${id}::uuid
                and user_id = ${actor.userId}::uuid for update`;
            if (!current) throw new ApiFault("NOT_FOUND");
            if (Number(current.version) !== version) {
              throw new ApiFault("VERSION_CONFLICT",Number(current.version));
            }
            if (current.active) await tx`select app.stop_capture_source(
              ${tenantId}::uuid,${id}::uuid,${actor.userId}::uuid)`;
            const [stopped] = await tx`select s.*,d.platform,d.active as device_active
              from app.capture_sources s join app.devices d
                on d.tenant_id = s.tenant_id and d.id = s.device_id
              where s.tenant_id = ${tenantId}::uuid and s.id = ${id}::uuid`;
            if (!stopped) throw new ApiFault("NOT_FOUND");
            return { status:200,body:sourceBody(stopped,Boolean(stopped.device_active)) };
          });
      });
    }));
}
