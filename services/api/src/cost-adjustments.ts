import { createHash, randomUUID } from "node:crypto";
import { allocateApprovedCost, applyChargeAdjustment, chargeCaseSchema } from "@sigongnote/domain";
import { UuidSchema } from "@sigongnote/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { inAuthorizedTransaction, type Tx } from "./auth.js";
import { ApiFault, execute, expectedVersion, idempotencyKey, membership, once, principal, tenantHeader,
  type Services } from "./routes.js";

const amount = z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/);
const adjustmentBody = z.object({
  id: UuidSchema, direction: z.enum(["increase", "reversal"]), amount_minor: amount,
  reason: z.enum(["change", "return", "refund", "defect", "correction"]),
  liability: z.enum(["unknown", "company", "customer", "supplier"]),
  evidence_ids: z.array(UuidSchema).min(1).max(100), explanation: z.string().trim().min(10).max(1000),
}).strict();
const allocationBody = z.object({
  id: UuidSchema, policy: z.enum(["approved_weight", "direct"]), policy_version: z.number().int().positive(),
  targets: z.array(z.object({ bundle_id: UuidSchema, weight: amount }).strict()).min(1).max(100),
  evidence_ids: z.array(UuidSchema).min(1).max(100), explanation: z.string().trim().min(10).max(1000),
}).strict();
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
async function evidenceExists(tx: Tx, tenantId: string, ids: string[]) {
  if (new Set(ids).size !== ids.length) throw new ApiFault("INVALID_CONTRACT");
  const rows = await tx`select id from app.evidence_index where tenant_id=${tenantId}::uuid
    and id=any(${tx.array(ids,2950)})`;
  if (rows.length !== ids.length) throw new ApiFault("NOT_FOUND");
}
async function currentCharge(tx: Tx, tenantId: string, chargeId: string, expected: number) {
  const [row] = await tx`select c.bundle_id,c.status,c.version,c.current_revision_id,r.payload,
    r.confirmed_actual_minor,r.tax_mode from app.charge_cases c
    join app.charge_revisions r on r.tenant_id=c.tenant_id and r.id=c.current_revision_id
    where c.tenant_id=${tenantId}::uuid and c.id=${chargeId}::uuid for update of c`;
  if (!row) throw new ApiFault("NOT_FOUND");
  if (Number(row.version) !== expected) throw new ApiFault("VERSION_CONFLICT", Number(row.version));
  if (!["confirmed","adjusted"].includes(row.status) || row.confirmed_actual_minor === null)
    throw new ApiFault("DOMAIN_INVARIANT");
  return row;
}

export function registerCostAdjustmentRoutes(app: FastifyInstance, services: Services) {
  app.post<{Params:{id:string}}>("/v1/charge-cases/:id/adjust", async (request, reply) => execute(reply, async () => {
    const actor = await principal(request, services), tenantId = tenantHeader(request);
    const key = idempotencyKey(request), expected = expectedVersion(request);
    const id = UuidSchema.safeParse(request.params.id), parsed = adjustmentBody.safeParse(request.body);
    if (!id.success || !parsed.success) throw new ApiFault("INVALID_CONTRACT");
    const body = parsed.data;
    return inAuthorizedTransaction(services.db, actor, async tx => {
      if (await membership(tx, tenantId, actor.userId) !== "owner") throw new ApiFault("NOT_FOUND");
      return once(tx, tenantId, actor.userId, `POST /v1/charge-cases/${id.data}/adjust`, key,
        hash({ body, expected }), async () => {
          return applyCostAdjustment(tx,tenantId,actor.userId,id.data,expected,body);
        });
    });
  }));

  app.post<{Params:{id:string}}>("/v1/charge-cases/:id/allocate", async (request, reply) => execute(reply, async () => {
    const actor = await principal(request, services), tenantId = tenantHeader(request);
    const key = idempotencyKey(request), expected = expectedVersion(request);
    const id = UuidSchema.safeParse(request.params.id), parsed = allocationBody.safeParse(request.body);
    if (!id.success || !parsed.success) throw new ApiFault("INVALID_CONTRACT");
    const body = parsed.data;
    return inAuthorizedTransaction(services.db, actor, async tx => {
      if (await membership(tx, tenantId, actor.userId) !== "owner") throw new ApiFault("NOT_FOUND");
      return once(tx, tenantId, actor.userId, `POST /v1/charge-cases/${id.data}/allocate`, key,
        hash({ body, expected }), async () => {
          const current = await currentCharge(tx, tenantId, id.data, expected);
          await evidenceExists(tx, tenantId, body.evidence_ids);
          const targetIds = body.targets.map(target => target.bundle_id);
          if (new Set(targetIds).size !== targetIds.length) throw new ApiFault("INVALID_CONTRACT");
          const targets = await tx`select id from app.work_bundles where tenant_id=${tenantId}::uuid
            and id=any(${tx.array(targetIds,2950)})`;
          if (targets.length !== targetIds.length) throw new ApiFault("NOT_FOUND");
          const decisionId = randomUUID();
          let result: ReturnType<typeof allocateApprovedCost>;
          try { result = allocateApprovedCost({ chargeId: id.data, tenantId,
            amountMinor: String(current.confirmed_actual_minor), chargeVersion: expected,
            policy: body.policy, policyVersion: body.policy_version, approvalDecisionId: decisionId,
            evidenceIds: body.evidence_ids,
            targets: body.targets.map(target => ({bundleId:target.bundle_id,weight:target.weight})) }); }
          catch { throw new ApiFault("DOMAIN_INVARIANT"); }
          if (result.status !== "allocated") throw new ApiFault("DOMAIN_INVARIANT");
          await tx`insert into app.decisions
            (tenant_id,id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash)
            values (${tenantId}::uuid,${decisionId}::uuid,${actor.userId}::uuid,'charge_allocation',
              ${body.policy},${tx.array([id.data],2950)},${tx.array([expected],20)},
              ${tx.array(body.evidence_ids,2950)},${body.explanation},${hash({body,expected})})`;
          await tx`insert into app.charge_allocation_batches
            (tenant_id,id,charge_case_id,charge_revision_id,charge_version,policy,policy_version,total_minor,
              decision_id,evidence_ids)
            values (${tenantId}::uuid,${body.id}::uuid,${id.data}::uuid,${current.current_revision_id}::uuid,
              ${expected},${body.policy},${body.policy_version},${result.totalMinor}::numeric,
              ${decisionId}::uuid,${tx.array(body.evidence_ids,2950)})`;
          for (const row of result.allocations) await tx`insert into app.charge_allocation_rows
            (tenant_id,batch_id,bundle_id,amount_minor)
            values (${tenantId}::uuid,${body.id}::uuid,${row.bundleId}::uuid,${row.amountMinor}::numeric)`;
          return { status: 201, body: { batch_id: body.id, charge_id: id.data, charge_version: expected,
            total_minor: result.totalMinor, allocations: result.allocations } };
        });
    });
  }));
}

export async function applyCostAdjustment(tx:Tx,tenantId:string,userId:string,chargeId:string,expected:number,body:z.infer<typeof adjustmentBody>){
          const current = await currentCharge(tx, tenantId, chargeId, expected);
          const [approvedInvoiceNet] = await tx`select coalesce(sum(k.gross_minor),0) as gross
            from app.invoice_charge_links k join app.invoice_lines l
              on l.tenant_id=k.tenant_id and l.id=k.invoice_line_id
            join app.invoices i on i.tenant_id=l.tenant_id and i.id=l.invoice_id
            where k.tenant_id=${tenantId}::uuid and k.charge_case_id=${chargeId}::uuid
              and i.status='approved'`;
          if (BigInt(String(approvedInvoiceNet?.gross ?? "0")) !== 0n)
            throw new ApiFault("DOMAIN_INVARIANT");
          await evidenceExists(tx, tenantId, body.evidence_ids);
          const attributed = await tx`select e.id from app.evidence_index e
            join app.evidence_attributions a on a.tenant_id=e.tenant_id and a.evidence_index_id=e.id
            where e.tenant_id=${tenantId}::uuid and e.id=any(${tx.array(body.evidence_ids,2950)})
              and e.source_kind='original' and a.state='confirmed'
              and a.bundle_id=${current.bundle_id}::uuid`;
          if (attributed.length !== body.evidence_ids.length) throw new ApiFault("DOMAIN_INVARIANT");
          const decisionId = randomUUID();
          let adjusted: ReturnType<typeof applyChargeAdjustment>;
          try { adjusted = applyChargeAdjustment({ id: body.id, tenantId, chargeId: chargeId,
            parentRevisionId: current.current_revision_id, expectedVersion: expected,
            direction: body.direction, amountMinor: body.amount_minor, reason: body.reason,
            evidenceIds: body.evidence_ids, liability: body.liability, approvalDecisionId: decisionId },
          { tenantId, chargeId: chargeId, revisionId: current.current_revision_id,
            version: expected, currentMinor: String(current.confirmed_actual_minor) }); }
          catch { throw new ApiFault("DOMAIN_INVARIANT"); }
          if (adjusted.status !== "applied") throw new ApiFault("DOMAIN_INVARIANT");
          const previous = chargeCaseSchema.parse(current.payload);
          const next = chargeCaseSchema.parse({ ...previous, status: "adjusted",
            confirmedActualMinor: adjusted.proposedMinor,
            evidenceIds: [...new Set([...previous.evidenceIds, ...body.evidence_ids])] });
          await tx`insert into app.decisions
            (tenant_id,id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash)
            values (${tenantId}::uuid,${decisionId}::uuid,${userId}::uuid,'charge_adjustment',
              ${body.direction},${tx.array([chargeId],2950)},${tx.array([expected],20)},
              ${tx.array(body.evidence_ids,2950)},${body.explanation},${hash({body,expected})})`;
          const [revision] = await tx`insert into app.charge_revisions
            (tenant_id,charge_case_id,version,previous_revision_id,actor_id,reason,payload,evidence_ids,
              confirmed_actual_minor,tax_mode)
            values (${tenantId}::uuid,${chargeId}::uuid,${expected+1},${current.current_revision_id}::uuid,
              ${userId}::uuid,${body.explanation},${tx.json(next)},
              ${tx.array(next.evidenceIds,2950)},${adjusted.proposedMinor}::numeric,${next.taxMode}) returning id`;
          if (!revision) throw new ApiFault("TEMPORARILY_UNAVAILABLE");
          const [updated] = await tx`update app.charge_cases set status='adjusted',version=version+1,
            current_revision_id=${revision.id}::uuid,updated_at=now()
            where tenant_id=${tenantId}::uuid and id=${chargeId}::uuid and version=${expected}
            returning version`;
          if (!updated) throw new ApiFault("VERSION_CONFLICT");
          await tx`insert into app.charge_adjustments
            (tenant_id,id,charge_case_id,previous_revision_id,next_revision_id,direction,amount_minor,
              reason,liability,decision_id)
            values (${tenantId}::uuid,${body.id}::uuid,${chargeId}::uuid,${current.current_revision_id}::uuid,
              ${revision.id}::uuid,${body.direction},${body.amount_minor}::numeric,
              ${body.reason},${body.liability},${decisionId}::uuid)`;
          for (const evidenceId of body.evidence_ids) await tx`insert into app.charge_adjustment_evidence_ownership
            (tenant_id,evidence_id,adjustment_id)
            values (${tenantId}::uuid,${evidenceId}::uuid,${body.id}::uuid)`;
          const [priorAllocation] = await tx`select id from app.charge_allocation_batches
            where tenant_id=${tenantId}::uuid and charge_case_id=${chargeId}::uuid
              and charge_version<=${expected} limit 1`;
          return { status: 201, body: { id: chargeId, adjustment_id: body.id, revision_id: revision.id,
            version: Number(updated.version), confirmed_actual_minor: adjusted.proposedMinor,
            customer_charge_eligible: adjusted.customerChargeEligible,
            allocation_stale: !!priorAllocation } };
}
