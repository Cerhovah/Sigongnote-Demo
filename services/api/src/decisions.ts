import { createHash } from "node:crypto";
import { UuidSchema } from "@sigongnote/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { inAuthorizedTransaction } from "./auth.js";
import { ApiFault, execute, idempotencyKey, membership, once, principal, tenantHeader,
  type Services } from "./routes.js";

const targetSchema = z.object({ type: z.enum(["evidence_index", "document_revision"]),
  id: UuidSchema, version: z.number().int().min(1) }).strict();
const decisionSchema = z.object({
  scope: z.enum(["project_attribution", "economic_transaction_identity"]),
  targets: z.array(targetSchema).min(1).max(2),
  choice: z.enum(["confirm_project", "confirm_bundle", "reject_candidate", "same_transaction", "distinct_transaction"]),
  project_id: UuidSchema.optional(), bundle_id: UuidSchema.optional(),
  reason: z.string().trim().min(3).max(1000), evidence_ids: z.array(UuidSchema).min(1).max(100),
}).strict();
const deferSchema = z.object({ reason: z.string().trim().min(3).max(1000),
  next_review_at: z.iso.datetime({ offset: true }) }).strict();

function versionHeader(request: FastifyRequest): number {
  const match = /^"([1-9][0-9]*)"$/.exec(String(request.headers["if-match"] ?? ""));
  const version = Number(match?.[1]);
  if (!Number.isSafeInteger(version) || version > 2147483647) throw new ApiFault("INVALID_CONTRACT");
  return version;
}
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function unique(values: string[]): boolean { return new Set(values).size === values.length; }

export function registerDecisionRoutes(app: FastifyInstance, services: Services) {
  app.post("/v1/decisions", async (request, reply) => execute(reply, async () => {
    const actor = await principal(request, services);
    const tenantId = tenantHeader(request);
    const key = idempotencyKey(request);
    const expected = versionHeader(request);
    const parsed = decisionSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiFault("INVALID_CONTRACT");
    const body = parsed.data;
    if (!unique(body.targets.map(item => item.id)) || !unique(body.evidence_ids)) throw new ApiFault("INVALID_CONTRACT");
    if (body.scope === "project_attribution" && (body.targets.length !== 1 ||
        body.targets[0]?.type !== "evidence_index" || body.targets[0].version !== expected ||
        !body.evidence_ids.includes(body.targets[0].id) ||
        (body.choice === "confirm_project" && (!body.project_id || body.bundle_id)) ||
        (body.choice === "confirm_bundle" && (!body.bundle_id || body.project_id)) ||
        (body.choice === "reject_candidate" && (body.project_id || body.bundle_id)) ||
        !["confirm_project","confirm_bundle","reject_candidate"].includes(body.choice))) {
      throw new ApiFault("INVALID_CONTRACT");
    }
    if (body.scope === "economic_transaction_identity" && (body.targets.length !== 2 ||
        body.targets.some(item => item.type !== "document_revision") || body.project_id || body.bundle_id ||
        !["same_transaction","distinct_transaction"].includes(body.choice))) {
      throw new ApiFault("INVALID_CONTRACT");
    }
    const bodyHash = hash({ body, expected });
    return inAuthorizedTransaction(services.db, actor, async tx => {
      const role = await membership(tx, tenantId, actor.userId);
      if (role !== "owner" && role !== "operator") throw new ApiFault("NOT_FOUND");
      return once(tx, tenantId, actor.userId, "POST /v1/decisions", key, bodyHash, async () => {
        const evidenceIds = body.evidence_ids;
        const evidence = await tx`select id,revision_id from app.evidence_index
          where tenant_id=${tenantId}::uuid and id=any(${tx.array(evidenceIds, 2950)})`;
        if (evidence.length !== evidenceIds.length) throw new ApiFault("NOT_FOUND");
        const target = body.targets[0];
        if (!target) throw new ApiFault("INVALID_CONTRACT");
        if (body.scope === "project_attribution") {
          await tx`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:attribution:${target.id}`},0))`;
          const [source] = await tx`select id,scope,project_id,bundle_id from app.evidence_index
            where tenant_id=${tenantId}::uuid and id=${target.id}::uuid`;
          if (!source) throw new ApiFault("NOT_FOUND");
          const [previous] = await tx`select version from app.evidence_attributions
            where tenant_id=${tenantId}::uuid and evidence_index_id=${target.id}::uuid for update`;
          const current = previous ? Number(previous.version) : 1;
          if (current !== expected) throw new ApiFault("VERSION_CONFLICT", current);
          if (body.project_id) {
            const [project] = await tx`select id from app.projects where tenant_id=${tenantId}::uuid and id=${body.project_id}::uuid`;
            if (!project) throw new ApiFault("NOT_FOUND");
          }
          if (body.bundle_id) {
            const [bundle] = await tx`select id from app.work_bundles where tenant_id=${tenantId}::uuid and id=${body.bundle_id}::uuid`;
            if (!bundle) throw new ApiFault("NOT_FOUND");
          }
          const [decision] = await tx`insert into app.decisions
            (tenant_id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash)
            values (${tenantId}::uuid,${actor.userId}::uuid,${body.scope},${body.choice},
              ${tx.array([target.id],2950)},${tx.array([expected],20)},${tx.array(evidenceIds,2950)},${body.reason},${bodyHash})
            returning id`;
          if (!decision) throw new ApiFault("TEMPORARILY_UNAVAILABLE");
          const state = body.choice === "reject_candidate" ? "rejected" : "confirmed";
          const projectId = body.choice === "confirm_project" ? body.project_id : null;
          const bundleId = body.choice === "confirm_bundle" ? body.bundle_id : null;
          const [projected] = await tx`insert into app.evidence_attributions
            (tenant_id,evidence_index_id,project_id,bundle_id,state,version,decision_id)
            values (${tenantId}::uuid,${target.id}::uuid,${projectId ?? null}::uuid,
              ${bundleId ?? null}::uuid,${state},${current + 1},${decision.id}::uuid)
            on conflict (tenant_id,evidence_index_id) do update set
              project_id=excluded.project_id,bundle_id=excluded.bundle_id,state=excluded.state,
              version=excluded.version,decision_id=excluded.decision_id,updated_at=now()
              where app.evidence_attributions.version=${current} returning version`;
          if (!projected) throw new ApiFault("VERSION_CONFLICT");
          return { status: 201, body: { decision_id: decision.id, scope: body.scope,
            changed_projections: ["project_attribution"], target_version: current + 1,
            money_confirmed: false, payment_confirmed: false, quality_confirmed: false } };
        }
        const pair = [...body.targets].sort((a, b) => a.id.localeCompare(b.id));
        const left = pair[0]; const right = pair[1];
        if (!left || !right) throw new ApiFault("INVALID_CONTRACT");
        await tx`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:identity:${left.id}:${right.id}`},0))`;
        const revisions = await tx`select id,revision_number from app.document_revisions
          where tenant_id=${tenantId}::uuid and id=any(${tx.array([left.id,right.id],2950)}) order by id`;
        if (revisions.length !== 2 || revisions.some(row =>
          Number(row.revision_number) !== pair.find(item => item.id === row.id)?.version)) throw new ApiFault("NOT_FOUND");
        if (evidence.some(row => row.revision_id !== left.id && row.revision_id !== right.id)) throw new ApiFault("INVALID_CONTRACT");
        const [previous] = await tx`select version from app.transaction_identities where tenant_id=${tenantId}::uuid
          and left_revision_id=${left.id}::uuid and right_revision_id=${right.id}::uuid for update`;
        const current = previous ? Number(previous.version) : 1;
        if (current !== expected) throw new ApiFault("VERSION_CONFLICT", current);
        const [decision] = await tx`insert into app.decisions
          (tenant_id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash)
          values (${tenantId}::uuid,${actor.userId}::uuid,${body.scope},${body.choice},
            ${tx.array([left.id,right.id],2950)},${tx.array([left.version,right.version],20)},
            ${tx.array(evidenceIds,2950)},${body.reason},${bodyHash}) returning id`;
        if (!decision) throw new ApiFault("TEMPORARILY_UNAVAILABLE");
        const [projected] = await tx`insert into app.transaction_identities
          (tenant_id,left_revision_id,right_revision_id,choice,version,decision_id)
          values (${tenantId}::uuid,${left.id}::uuid,${right.id}::uuid,${body.choice},${current + 1},${decision.id}::uuid)
          on conflict (tenant_id,left_revision_id,right_revision_id) do update set
            choice=excluded.choice,version=excluded.version,decision_id=excluded.decision_id,updated_at=now()
            where app.transaction_identities.version=${current} returning version`;
        if (!projected) throw new ApiFault("VERSION_CONFLICT");
        return { status: 201, body: { decision_id: decision.id, scope: body.scope,
          changed_projections: ["transaction_identity"], target_version: current + 1,
          cost_confirmed: false, actual_received_confirmed: false } };
      });
    });
  }));

  app.post<{ Params: { id: string } }>("/v1/exceptions/:id/defer", async (request, reply) => execute(reply, async () => {
    const actor = await principal(request, services);
    const tenantId = tenantHeader(request);
    const key = idempotencyKey(request);
    const expected = versionHeader(request);
    const exceptionId = UuidSchema.safeParse(request.params.id);
    const parsed = deferSchema.safeParse(request.body);
    if (!exceptionId.success || !parsed.success) throw new ApiFault("INVALID_CONTRACT");
    const body = parsed.data;
    const nextReview = new Date(body.next_review_at);
    if (!Number.isFinite(nextReview.getTime())) throw new ApiFault("INVALID_CONTRACT");
    const bodyHash = hash({ exceptionId: exceptionId.data, expected, body });
    return inAuthorizedTransaction(services.db, actor, async tx => {
      const role = await membership(tx, tenantId, actor.userId);
      if (role !== "owner" && role !== "operator") throw new ApiFault("NOT_FOUND");
      return once(tx, tenantId, actor.userId, `POST /v1/exceptions/${exceptionId.data}/defer`, key, bodyHash, async () => {
        const [item] = await tx`select id,state,version,due_at from app.exception_cases
          where tenant_id=${tenantId}::uuid and id=${exceptionId.data}::uuid for update`;
        if (!item) throw new ApiFault("NOT_FOUND");
        const [clock] = await tx`select now() as database_time`;
        if (!clock || nextReview <= new Date(clock.database_time)) throw new ApiFault("INVALID_CONTRACT");
        const current = Number(item.version);
        if (current !== expected) throw new ApiFault("VERSION_CONFLICT", current);
        if (item.state === "resolved" || item.due_at && nextReview > new Date(item.due_at)) throw new ApiFault("DOMAIN_INVARIANT");
        const [updated] = await tx`update app.exception_cases set state='deferred',version=version+1,
          next_review_at=${nextReview},updated_at=now()
          where tenant_id=${tenantId}::uuid and id=${exceptionId.data}::uuid and version=${expected}
          returning id,state,version,next_review_at`;
        if (!updated) throw new ApiFault("VERSION_CONFLICT");
        await tx`insert into app.exception_events(tenant_id,exception_id,actor_id,kind,reason)
          values (${tenantId}::uuid,${exceptionId.data}::uuid,${actor.userId}::uuid,'deferred',${body.reason})`;
        return { status: 200, body: { exception: updated, unresolved: true } };
      });
    });
  }));
}
