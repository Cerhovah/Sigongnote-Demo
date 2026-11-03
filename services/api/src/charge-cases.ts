import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chargeCaseSchema, inspectChargeCase, parseTradePack } from "@sigongnote/domain";
import { UuidSchema } from "@sigongnote/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { inAuthorizedTransaction, type Tx } from "./auth.js";
import { ApiFault, execute, expectedVersion, idempotencyKey, membership, once, principal, tenantHeader,
  type Services } from "./routes.js";

const packs = new Map(["generic", "joinery", "wet-trade"].map(name => {
  const raw = JSON.parse(readFileSync(new URL(`../../../trade-packs/${name}/1.0.0.json`, import.meta.url), "utf8"));
  return [name, parseTradePack(raw)] as const;
}));
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
async function validated(tx: Tx, tenantId: string, input: unknown, requireAttribution: boolean) {
  const parsed = chargeCaseSchema.safeParse(input);
  if (!parsed.success || parsed.data.tenantId !== tenantId) throw new ApiFault("INVALID_CONTRACT");
  const charge = parsed.data;
  const [bundle] = await tx`select trade_pack_id,trade_pack_version,trade_pack_hash from app.work_bundles
    where tenant_id=${tenantId}::uuid and id=${charge.bundleId}::uuid`;
  if (!bundle) throw new ApiFault("NOT_FOUND");
  const pack = packs.get(String(bundle.trade_pack_id));
  if (!pack || bundle.trade_pack_version !== pack.version || bundle.trade_pack_hash !== pack.contentHash)
    throw new ApiFault("DOMAIN_INVARIANT");
  let inspected: ReturnType<typeof inspectChargeCase>;
  try { inspected = inspectChargeCase(charge, new Set(pack.units.map(unit => unit.code))); }
  catch { throw new ApiFault("DOMAIN_INVARIANT"); }
  const evidenceIds = [...new Set(charge.evidenceIds)];
  if (evidenceIds.length !== charge.evidenceIds.length) throw new ApiFault("INVALID_CONTRACT");
  const evidence = await tx`select id,source_kind from app.evidence_index where tenant_id=${tenantId}::uuid
    and id=any(${tx.array(evidenceIds,2950)})`;
  if (evidence.length !== evidenceIds.length) throw new ApiFault("NOT_FOUND");
  if (requireAttribution) {
    if (evidence.some(item => item.source_kind !== "original")) throw new ApiFault("DOMAIN_INVARIANT");
    const attributed = await tx`select a.evidence_index_id from app.evidence_attributions a
      join app.work_bundles b on b.tenant_id=a.tenant_id and b.id=${charge.bundleId}::uuid
      where a.tenant_id=${tenantId}::uuid and a.evidence_index_id=any(${tx.array(evidenceIds,2950)})
        and a.state='confirmed' and a.bundle_id=b.id`;
    if (attributed.length !== evidenceIds.length) throw new ApiFault("DOMAIN_INVARIANT");
  }
  return inspected;
}

export function registerChargeCaseRoutes(app: FastifyInstance, services: Services) {
  app.post("/v1/charge-cases", async (request, reply) => execute(reply, async () => {
    const actor = await principal(request, services);
    const tenantId = tenantHeader(request);
    const key = idempotencyKey(request);
    const parsed = chargeCaseSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiFault("INVALID_CONTRACT");
    const charge = parsed.data;
    if (charge.status !== "candidate" || charge.identityState !== "unresolved" ||
        charge.canonicalCaseId !== null || charge.confirmedActualMinor !== null ||
        charge.customerChargeMinor !== null || charge.paidMinor !== null) throw new ApiFault("DOMAIN_INVARIANT");
    return inAuthorizedTransaction(services.db, actor, async tx => {
      if (await membership(tx, tenantId, actor.userId) !== "owner") throw new ApiFault("NOT_FOUND");
      return once(tx, tenantId, actor.userId, "POST /v1/charge-cases", key, hash(charge), async () => {
        await validated(tx, tenantId, charge, false);
        const [created] = await tx`insert into app.charge_cases
          (tenant_id,id,bundle_id,category,identity_state,canonical_case_id,status)
          values (${tenantId}::uuid,${charge.id}::uuid,${charge.bundleId}::uuid,${charge.category},
            ${charge.identityState},null,'candidate') returning id`;
        const [revision] = await tx`insert into app.charge_revisions
          (tenant_id,charge_case_id,version,actor_id,reason,payload,evidence_ids,confirmed_actual_minor,tax_mode)
          values (${tenantId}::uuid,${charge.id}::uuid,1,${actor.userId}::uuid,'candidate created',
            ${tx.json(charge)},${tx.array(charge.evidenceIds,2950)},null,${charge.taxMode}) returning id`;
        if (!created || !revision) throw new ApiFault("TEMPORARILY_UNAVAILABLE");
        await tx`update app.charge_cases set current_revision_id=${revision.id}::uuid
          where tenant_id=${tenantId}::uuid and id=${charge.id}::uuid`;
        return { status: 201, body: { id: charge.id, revision_id: revision.id,
          version: 1, status: "candidate", confirmed_actual_minor: null } };
      });
    });
  }));

  app.post<{Params:{id:string}}>("/v1/charge-cases/:id/confirm", async (request, reply) => execute(reply, async () => {
    const actor = await principal(request, services);
    const tenantId = tenantHeader(request);
    const key = idempotencyKey(request);
    const expected = expectedVersion(request);
    const id = UuidSchema.safeParse(request.params.id);
    if (!id.success) throw new ApiFault("INVALID_CONTRACT");
    const parsed = z.object({ charge: chargeCaseSchema,
      reason: z.string().trim().min(3).max(1000) }).strict().safeParse(request.body);
    if (!parsed.success || parsed.data.charge.id !== id.data || parsed.data.charge.status !== "confirmed")
      throw new ApiFault("INVALID_CONTRACT");
    const { charge, reason } = parsed.data;
    return inAuthorizedTransaction(services.db, actor, async tx => {
      if (await membership(tx, tenantId, actor.userId) !== "owner") throw new ApiFault("NOT_FOUND");
      return once(tx, tenantId, actor.userId, `POST /v1/charge-cases/${id.data}/confirm`, key,
        hash({ charge, reason, expected }), async () => {
          await tx`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:charge-confirm`},0))`;
          const [current] = await tx`select bundle_id,category,status,identity_state,version,current_revision_id
            from app.charge_cases where tenant_id=${tenantId}::uuid and id=${id.data}::uuid for update`;
          if (!current) throw new ApiFault("NOT_FOUND");
          if (Number(current.version) !== expected) throw new ApiFault("VERSION_CONFLICT", Number(current.version));
          if (current.bundle_id !== charge.bundleId || current.category !== charge.category ||
              !["candidate","documented","disputed"].includes(current.status) ||
              charge.identityState !== current.identity_state || current.identity_state !== "unresolved")
            throw new ApiFault("DOMAIN_INVARIANT");
          const resolvedCharge = { ...charge, identityState: "confirmed_distinct" as const };
          const inspected = await validated(tx, tenantId, resolvedCharge, true);
          if (inspected.confirmationBlockers.length)
            throw new ApiFault("DOMAIN_INVARIANT");
          const same = await tx`select 1 from app.transaction_identities ti
            join app.evidence_index new_e on new_e.tenant_id=ti.tenant_id and
              new_e.id=any(${tx.array(charge.evidenceIds,2950)})
            join app.evidence_index owned_e on owned_e.tenant_id=ti.tenant_id and
              ((ti.left_revision_id=new_e.revision_id and ti.right_revision_id=owned_e.revision_id) or
               (ti.right_revision_id=new_e.revision_id and ti.left_revision_id=owned_e.revision_id))
            join app.charge_evidence_ownership o on o.tenant_id=owned_e.tenant_id and o.evidence_id=owned_e.id
            where ti.tenant_id=${tenantId}::uuid and ti.choice='same_transaction' limit 1`;
          if (same.length) throw new ApiFault("DOMAIN_INVARIANT");
          const [previous] = await tx`select payload from app.charge_revisions
            where tenant_id=${tenantId}::uuid and id=${current.current_revision_id}::uuid`;
          const oldPayload = previous?.payload as Record<string, unknown> | undefined;
          const changedFields = ["partyId","scopeQuantity","billingQuantity","billingRateMinor",
            "billingRatePerUnit","documentedMinor","taxMode","settlementParentId"]
            .filter(field => JSON.stringify(oldPayload?.[field]) !== JSON.stringify(charge[field as keyof typeof charge]));
          if (changedFields.length && reason.length < 10) throw new ApiFault("INVALID_CONTRACT");
          const decisionHash = hash({ id: id.data, expected, evidenceIds: charge.evidenceIds,
            reason, identity: "confirmed_distinct" });
          const [decision] = await tx`insert into app.decisions
            (tenant_id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash)
            values (${tenantId}::uuid,${actor.userId}::uuid,'charge_identity','distinct_transaction',
              ${tx.array([id.data],2950)},${tx.array([expected],20)},
              ${tx.array(charge.evidenceIds,2950)},${reason},${decisionHash}) returning id`;
          if (!decision) throw new ApiFault("TEMPORARILY_UNAVAILABLE");
          for (const evidenceId of charge.evidenceIds) await tx`insert into app.charge_evidence_ownership
            (tenant_id,evidence_id,charge_case_id,identity_decision_id)
            values (${tenantId}::uuid,${evidenceId}::uuid,${id.data}::uuid,${decision.id}::uuid)`;
          const [revision] = await tx`insert into app.charge_revisions
            (tenant_id,charge_case_id,version,previous_revision_id,actor_id,reason,payload,evidence_ids,
              confirmed_actual_minor,tax_mode)
            values (${tenantId}::uuid,${id.data}::uuid,${expected+1},${current.current_revision_id}::uuid,
              ${actor.userId}::uuid,${reason},${tx.json(resolvedCharge)},
              ${tx.array(charge.evidenceIds,2950)},${charge.confirmedActualMinor}::numeric,${charge.taxMode})
            returning id`;
          if (!revision) throw new ApiFault("TEMPORARILY_UNAVAILABLE");
          const [updated] = await tx`update app.charge_cases set status='confirmed',identity_state='confirmed_distinct',
            identity_decision_id=${decision.id}::uuid,version=version+1,
            current_revision_id=${revision.id}::uuid,updated_at=now()
            where tenant_id=${tenantId}::uuid and id=${id.data}::uuid and version=${expected}
            returning version`;
          if (!updated) throw new ApiFault("VERSION_CONFLICT");
          return { status: 201, body: { id: id.data, revision_id: revision.id,
            version: Number(updated.version), status: "confirmed",
            confirmed_actual_minor: charge.confirmedActualMinor,
            tax_mode: charge.taxMode, discrepancy_minor: inspected.discrepancyMinor,
            identity_decision_id: decision.id, changed_fields: changedFields } };
        });
    });
  }));
}
