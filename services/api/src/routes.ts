import {registerPhotoSharing} from './photo-sharing.js';
import {registerDeliveries} from './deliveries.js';
import {registerPhotoSheets} from './photo-sheets.js';
import {registerPhotoGroups} from './photo-groups.js';
import {registerOwnerMemory} from './owner-memory.js';
import {registerEntityDirectory} from './entity-directory.js';
import {registerActivity} from './work-activity.js';
import {registerLearning} from './learning.js';
import {registerImprovements} from './improvements.js';
import {registerWorkReplies} from './work-replies.js';
import {registerWorkDecisions} from './work-decisions.js';
import {registerSyncChanges} from './sync-changes.js';
import {registerDocumentSharing} from './document-sharing.js';
import {registerDocumentArtifacts} from "./document-artifacts.js";
import {registerDocumentIssuance} from "./document-issuance.js";
import {registerDocumentDraftRoutes} from "./document-drafts.js";
import { registerVoiceRoutes } from "./voice.js";
import {registerConversationRoutes} from "./conversations.js";
import {registerWorkActions} from "./work-actions.js";
import { registerWorkspaceRoutes } from "./workspaces.js";
import { registerWorkMaterialRoutes } from "./work-materials.js";
import {registerEvidenceChunkRoutes} from "./evidence-chunks.js";
import {registerMaintenance} from "./maintenance.js";
import { registerWorkContext } from "./work-context.js";
import { registerFieldRoutes } from "./field.js";
import { registerSiteFolderRoutes } from "./site-folders.js";
import { createHash, createPublicKey, randomUUID } from "node:crypto";
import {
  DeviceRegistrationRequestSchema, DeviceResponseSchema, UuidSchema, makeApiError,
  type DeviceResponse, type ErrorCode,
} from "@sigongnote/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type postgres from "postgres";
import { inAuthorizedTransaction, RateLimitedAuthError, TransientAuthError, type Db, type Principal, type TokenVerifier, type Tx } from "./auth.js";
import { registerIngestionRoutes, type StorageGateway } from "./ingestions.js";
import { registerCaptureSourceRoutes } from "./capture-sources.js";
import { registerDirectoryRoutes } from "./directory.js";
import { registerDecisionRoutes } from "./decisions.js";
import { registerChargeCaseRoutes } from "./charge-cases.js";
import { registerCostAdjustmentRoutes } from "./cost-adjustments.js";
import { registerInvoiceRoutes } from "./invoices.js";
import { registerCashRoutes } from "./cash.js";
import { registerCashSettlementRoutes } from "./cash-settlements.js";
import { registerSubmittalRoutes } from "./submittals.js";
import { registerExportRoutes } from "./exports.js";
import { registerExternalActionRoutes } from "./external-actions.js";
import { registerOutcomeRoutes } from "./outcomes.js";
import { registerQuoteRoutes } from "./quotes.js";
import { registerQuoteLifecycleRoutes } from "./quote-lifecycle.js";
import { registerQuoteRevisionRoutes } from "./quote-revisions.js";

export type Services = { smsTriage?: {config: import("./product-ai-config.js").ProductAiConfig;transport?:typeof fetch}; activityObserverUserIds?: readonly string[]; fax?: import("./fax-provider.js").FaxRuntime|undefined; agentRuntime?:boolean; shortStt?: import("./short-stt.js").ShortStt | undefined; profileTransport?: typeof fetch; profileProviders?: readonly import("./provider-profiles.js").ProfileProvider[]; db: Db; verifyToken: TokenVerifier; storage?: StorageGateway; capturePolicy?: import("./capture-scope.js").CapturePolicy; claudeRuntime?: import("./claude-runtime.js").ClaudeRuntimeConfig; claudeRunner?: import("./claude-runtime.js").ClaudeRunner };
export type Result = { status: number; body: unknown };
export class ApiFault extends Error {
  constructor(readonly code: ErrorCode, readonly currentVersion?: number) { super(code); }
}
function failure(reply: FastifyReply, code: ErrorCode, currentVersion?: number) {
  const { status, body } = makeApiError(code, randomUUID(),
    currentVersion === undefined ? undefined : { current_version: currentVersion, action: "refresh_diff" });
  return reply.code(status).send(body);
}
export async function principal(request: FastifyRequest, services: Services): Promise<Principal> {
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(request.headers.authorization ?? "");
  if (!match?.[1]) throw new ApiFault("UNAUTHENTICATED");
  const verified = await services.verifyToken(match[1]);
  if (!verified) throw new ApiFault("UNAUTHENTICATED");
  return verified;
}
export function tenantHeader(request: FastifyRequest): string {
  const result = UuidSchema.safeParse(request.headers["x-tenant-id"]);
  if (!result.success) throw new ApiFault("INVALID_CONTRACT");
  return result.data;
}
export function idempotencyKey(request: FastifyRequest): string {
  const result = UuidSchema.safeParse(request.headers["idempotency-key"]);
  if (!result.success) throw new ApiFault("INVALID_CONTRACT");
  return result.data;
}
export function expectedVersion(request: FastifyRequest): number {
  const match = /^"([1-9][0-9]*)"$/.exec(String(request.headers["if-match"] ?? ""));
  const number = Number(match?.[1]);
  if (!Number.isSafeInteger(number) || number > 2147483647) throw new ApiFault("INVALID_CONTRACT");
  return number;
}
function sha256(value: string) { return createHash("sha256").update(value).digest("hex"); }
function deviceBody(row: Record<string, unknown>): DeviceResponse {
  return DeviceResponseSchema.parse({
    id:row.id,tenant_id:row.tenant_id,platform:row.platform,active:row.active,
    version:Number(row.version),revoked_at:row.revoked_at instanceof Date
      ? row.revoked_at.toISOString() : row.revoked_at,
  });
}
export async function membership(tx: Tx, tenantId: string, userId: string) {
  const [row] = await tx`select role from app.memberships
    where tenant_id = ${tenantId}::uuid and user_id = ${userId}::uuid
      and active and revoked_at is null`;
  if (!row) throw new ApiFault("NOT_FOUND");
  return row.role as string;
}
export async function once(tx: Tx, tenantId: string, actorId: string, route: string,
  key: string, bodyHash: string, operation: () => Promise<Result>): Promise<Result> {
  await tx`select pg_advisory_xact_lock(hashtextextended(
    ${`${tenantId}:${actorId}:${route}:${key}`}, 0))`;
  const [receipt] = await tx`select request_hash, status_code, response
    from app.command_receipts where tenant_id = ${tenantId}::uuid
      and actor_id = ${actorId}::uuid and route = ${route}
      and idempotency_key = ${key}::uuid`;
  if (receipt) {
    if (receipt.request_hash !== bodyHash) throw new ApiFault("IDEMPOTENCY_CONFLICT");
    return { status: Number(receipt.status_code), body: receipt.response };
  }
  const result = await operation();
  await tx`insert into app.command_receipts
    (tenant_id, actor_id, route, idempotency_key, request_hash, status_code, response)
    values (${tenantId}::uuid, ${actorId}::uuid, ${route}, ${key}::uuid,
      ${bodyHash}, ${result.status}, ${tx.json(result.body as postgres.JSONValue)})`;
  return result;
}
export async function execute(reply: FastifyReply, work: () => Promise<Result | null>) {
  try {
    const result = await work();
    if (!result) return failure(reply, "UNAUTHENTICATED");
    return reply.code(result.status).send(result.body);
  } catch (error) {
    if (error instanceof ApiFault) return failure(reply, error.code, error.currentVersion);
    if (error instanceof RateLimitedAuthError) return failure(reply, "RATE_LIMITED");
    if (error instanceof TransientAuthError) return failure(reply, "TEMPORARILY_UNAVAILABLE");
    const sqlState = error && typeof error === "object" && "code" in error &&
      typeof error.code === "string" ? error.code : "";
    if (sqlState === "P0001" && error instanceof Error && error.message === "capture storage quota reached") return failure(reply, "STORAGE_QUOTA_EXCEEDED");
    if (sqlState === "23505") return failure(reply, "IDEMPOTENCY_CONFLICT");
    if (sqlState === "23503" || sqlState === "23514") return failure(reply, "DOMAIN_INVARIANT");
    if (sqlState === "42501") return failure(reply, "NOT_FOUND");
    if (sqlState === "40001" || sqlState === "40P01" || sqlState === "57P01" ||
        sqlState.startsWith("08") || sqlState.startsWith("53")) {
      return failure(reply, "TEMPORARILY_UNAVAILABLE");
    }
    if (/^[A-Z0-9]{5}$/.test(sqlState)) return failure(reply, "DOMAIN_INVARIANT");
    return failure(reply, "TEMPORARILY_UNAVAILABLE");
  }
}

export function registerRoutes(app: FastifyInstance, services: Services) {
  registerWorkDecisions(app,services);
  registerOwnerMemory(app,services);
  registerEntityDirectory(app,services);
  registerWorkReplies(app,services);
  registerVoiceRoutes(app,services);
  registerDocumentDraftRoutes(app,services);
  registerDocumentIssuance(app,services);
  registerDocumentArtifacts(app,services);
  registerPhotoGroups(app,services);registerPhotoSheets(app,services);registerDeliveries(app,services);registerPhotoSharing(app,services);registerDocumentSharing(app,services);
  registerSyncChanges(app,services);
  registerWorkMaterialRoutes(app, services);
  registerEvidenceChunkRoutes(app,services);
  registerWorkContext(app, services);registerMaintenance(app,services);registerActivity(app,services);registerLearning(app,services);
  registerImprovements(app,services);
  registerConversationRoutes(app,services);
  registerWorkActions(app,services);
  registerFieldRoutes(app, services);
  registerCaptureSourceRoutes(app, services);
  registerDirectoryRoutes(app, services);
  registerSiteFolderRoutes(app, services);
  registerWorkspaceRoutes(app, services);
  registerDecisionRoutes(app, services);
  registerChargeCaseRoutes(app, services);
  registerCostAdjustmentRoutes(app, services);
  registerInvoiceRoutes(app, services);
  registerCashRoutes(app, services);
  registerCashSettlementRoutes(app, services);
  registerSubmittalRoutes(app, services);
  registerExportRoutes(app, services);
  registerExternalActionRoutes(app, services);
  registerOutcomeRoutes(app, services);
  registerQuoteRoutes(app, services);
  registerQuoteLifecycleRoutes(app, services);
  registerQuoteRevisionRoutes(app, services);
  if (services.storage) registerIngestionRoutes(app, services, services.storage);
  app.get("/v1/me", async (request, reply) => execute(reply, async () => {
    const actor = await principal(request, services);
    return inAuthorizedTransaction(services.db, actor, async tx => {
      const rows = await tx`select m.tenant_id, t.display_name as tenant_name, m.role
        from app.memberships m join app.tenants t on t.id = m.tenant_id
        where m.user_id = ${actor.userId}::uuid and m.active and m.revoked_at is null
        order by t.display_name, m.tenant_id`;
      return { status: 200, body: { user_id: actor.userId, memberships: rows } };
    });
  }));

  app.post("/v1/devices", async (request, reply) => execute(reply, async () => {
    const actor = await principal(request, services);
    const tenantId = tenantHeader(request);
    const key = idempotencyKey(request);
    const parsed = DeviceRegistrationRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiFault("INVALID_CONTRACT");
    const body = parsed.data;
    try { createPublicKey({ key: body.public_key_jwk, format: "jwk" }); }
    catch { throw new ApiFault("INVALID_CONTRACT"); }
    const bodyHash = sha256(JSON.stringify(body));
    const publicKeyHash = sha256(JSON.stringify(body.public_key_jwk));
    return inAuthorizedTransaction(services.db, actor, async tx => {
      await membership(tx, tenantId, actor.userId);
      return once(tx, tenantId, actor.userId, "POST /v1/devices", key, bodyHash, async () => {
        const [existing] = await tx`select id from app.devices where tenant_id = ${tenantId}::uuid
          and user_id = ${actor.userId}::uuid and public_key_sha256 = ${publicKeyHash}`;
        if (existing) throw new ApiFault("IDEMPOTENCY_CONFLICT");
        const [device] = await tx`insert into app.devices
          (tenant_id, user_id, platform, public_key_jwk, public_key_sha256,
            app_version, registration_key, registration_hash)
          values (${tenantId}::uuid, ${actor.userId}::uuid, ${body.platform},
            ${tx.json(body.public_key_jwk)}, ${publicKeyHash}, ${body.app_version},
            ${key}::uuid, ${bodyHash})
          returning id, tenant_id, platform, active, version, revoked_at`;
        if (!device) throw new ApiFault("TEMPORARILY_UNAVAILABLE");
        return { status: 201, body: deviceBody(device) };
      });
    });
  }));

  app.get<{Params:{fingerprint:string}}>("/v1/devices/by-key/:fingerprint",
    async (request, reply) => execute(reply, async () => {
      const actor = await principal(request, services);
      const tenantId = tenantHeader(request);
      const fingerprint = request.params.fingerprint;
      if (!/^[0-9a-f]{64}$/.test(fingerprint))
        throw new ApiFault("INVALID_CONTRACT");
      return inAuthorizedTransaction(services.db, actor, async tx => {
        await membership(tx, tenantId, actor.userId);
        const [device] = await tx`select id,tenant_id,platform,active,version,revoked_at
          from app.devices where tenant_id = ${tenantId}::uuid
            and user_id = ${actor.userId}::uuid
            and public_key_sha256 = ${fingerprint}`;
        if (!device) throw new ApiFault("NOT_FOUND");
        return { status: 200, body: deviceBody(device) };
      });
    }));

  app.get<{Params:{id:string}}>("/v1/devices/:id", async (request, reply) =>
    execute(reply, async () => {
      const actor = await principal(request, services);
      const tenantId = tenantHeader(request);
      const deviceId = UuidSchema.safeParse(request.params.id);
      if (!deviceId.success) throw new ApiFault("INVALID_CONTRACT");
      return inAuthorizedTransaction(services.db, actor, async tx => {
        await membership(tx, tenantId, actor.userId);
        const [device] = await tx`select id,tenant_id,platform,active,version,revoked_at
          from app.devices where tenant_id = ${tenantId}::uuid
            and id = ${deviceId.data}::uuid and user_id = ${actor.userId}::uuid`;
        if (!device) throw new ApiFault("NOT_FOUND");
        return { status: 200, body: deviceBody(device) };
      });
    }));

  app.post<{Params:{id:string}}>("/v1/devices/:id/revoke", async (request, reply) =>
    execute(reply, async () => {
      const actor = await principal(request, services);
      const tenantId = tenantHeader(request);
      const key = idempotencyKey(request);
      const version = expectedVersion(request);
      const deviceId = UuidSchema.safeParse(request.params.id);
      if (!deviceId.success || request.body !== undefined &&
          (typeof request.body !== "object" || request.body === null ||
           Array.isArray(request.body) || Object.keys(request.body).length !== 0)) {
        throw new ApiFault("INVALID_CONTRACT");
      }
      const route = `POST /v1/devices/${deviceId.data}/revoke`;
      const bodyHash = sha256(JSON.stringify({ device_id: deviceId.data, version }));
      return inAuthorizedTransaction(services.db, actor, async tx => {
        const role = await membership(tx, tenantId, actor.userId);
        return once(tx, tenantId, actor.userId, route, key, bodyHash, async () => {
          const [device] = await tx`select id, tenant_id, user_id, platform, active,
            version, revoked_at from app.devices where tenant_id = ${tenantId}::uuid
            and id = ${deviceId.data}::uuid for update`;
          if (!device || (role !== "owner" && device.user_id !== actor.userId)) {
            throw new ApiFault("NOT_FOUND");
          }
          const current = Number(device.version);
          if (current !== version) throw new ApiFault("VERSION_CONFLICT", current);
          if (!device.active) return { status: 200, body: deviceBody(device) };
          const [revoked] = await tx`update app.devices set active = false,
            revoked_at = now(), version = version + 1, updated_at = now()
            where tenant_id = ${tenantId}::uuid and id = ${deviceId.data}::uuid
            returning id, tenant_id, platform, active, version, revoked_at`;
          if (!revoked) throw new ApiFault("NOT_FOUND");
          await tx`select app.stop_device_sources(${tenantId}::uuid,
            ${deviceId.data}::uuid,${actor.userId}::uuid)`;
          return { status: 200, body: deviceBody(revoked) };
        });
      });
    }));
}
