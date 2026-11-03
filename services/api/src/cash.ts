import {createHash} from "node:crypto";
import {cashObservationSchema,matchCashObservation,type CashRecord} from "@sigongnote/domain";
import {UuidSchema} from "@sigongnote/contracts";
import type {FastifyInstance} from "fastify";
import {z} from "zod";
import {inAuthorizedTransaction,type Tx} from "./auth.js";
import {ApiFault,execute,idempotencyKey,membership,once,principal,tenantHeader,
  type Services} from "./routes.js";

const identityBody=z.object({observation_id:UuidSchema,
  choice:z.enum(["link_existing","new_distinct"]),cash_record_id:UuidSchema,
  reason:z.string().trim().min(10).max(1000),evidence_ids:z.array(UuidSchema).min(1).max(100)}).strict();
function hash(value:unknown) {return createHash("sha256").update(JSON.stringify(value)).digest("hex");}
function asObservation(row:Record<string,unknown>) {
  return cashObservationSchema.parse({id:row.id,tenantId:row.tenant_id,accountToken:row.account_token,
    direction:row.direction,amountMinor:row.amount_minor===null?null:String(row.amount_minor),
    counterpartyId:row.counterparty_id,
    occurredAt:row.occurred_at instanceof Date?row.occurred_at.toISOString():row.occurred_at,
    timePrecision:row.time_precision,normalizedMemo:row.normalized_memo,provider:row.provider,
    providerTxnId:row.provider_txn_id,source:row.source,evidenceId:row.evidence_id});
}
async function candidates(tx:Tx,tenantId:string,observation:ReturnType<typeof asObservation>) {
  const rows=await tx`select c.id,c.tenant_id,c.account_token,c.direction,c.counterparty_id,
    c.amount_minor,c.occurred_at,
    c.normalized_memo,c.bank_reconciled,i.provider,i.transaction_id
    from app.cash_records c left join app.cash_record_identifiers i
      on i.tenant_id=c.tenant_id and i.cash_record_id=c.id
      and i.provider=${observation.provider} and i.transaction_id=${observation.providerTxnId}
    where c.tenant_id=${tenantId}::uuid and c.account_token=${observation.accountToken}
      and c.direction=${observation.direction}`;
  const records:CashRecord[]=rows.map(row=>({id:row.id,tenantId,accountToken:row.account_token,
    counterpartyId:row.counterparty_id,
    direction:row.direction,amountMinor:String(row.amount_minor),occurredAt:row.occurred_at.toISOString(),
    normalizedMemo:row.normalized_memo,provider:row.provider,providerTxnId:row.transaction_id,
    evidenceIds:[],bankReconciled:row.bank_reconciled}));
  return {records,match:matchCashObservation(observation,records)};
}
export function registerCashRoutes(app:FastifyInstance,services:Services) {
  app.post("/v1/cash-observations",async(request,reply)=>execute(reply,async()=>{
    const actor=await principal(request,services),tenantId=tenantHeader(request),key=idempotencyKey(request);
    const parsed=cashObservationSchema.safeParse(request.body);
    if (!parsed.success || parsed.data.tenantId!==tenantId) throw new ApiFault("INVALID_CONTRACT");
    const body=parsed.data;
    return inAuthorizedTransaction(services.db,actor,async tx=>{
      const role=await membership(tx,tenantId,actor.userId);
      if (role!=="owner" && role!=="operator") throw new ApiFault("NOT_FOUND");
      return once(tx,tenantId,actor.userId,"POST /v1/cash-observations",key,hash(body),async()=>{
        const [evidence]=await tx`select id,category,source_kind,revision_id,locator from app.evidence_index
          where tenant_id=${tenantId}::uuid and id=${body.evidenceId}::uuid`;
        if (!evidence) throw new ApiFault("NOT_FOUND");
        if (body.source==="notification" && evidence.source_kind!=="notification_fragment" ||
            body.source==="bank" && (evidence.source_kind!=="original" ||
              evidence.category!=="billing_payment") ||
            body.source==="manual" && evidence.source_kind!=="original")
          throw new ApiFault("DOMAIN_INVARIANT");
        await tx`insert into app.cash_observations
          (tenant_id,id,account_token,direction,amount_minor,occurred_at,time_precision,
            normalized_memo,provider,provider_txn_id,source,evidence_id,source_revision_id,
            source_locator,counterparty_id)
          values (${tenantId}::uuid,${body.id}::uuid,${body.accountToken},${body.direction},
            ${body.amountMinor}::numeric,${body.occurredAt}::timestamptz,${body.timePrecision},
            ${body.normalizedMemo},${body.provider},${body.providerTxnId},${body.source},
            ${body.evidenceId}::uuid,${evidence.revision_id}::uuid,${tx.json(evidence.locator)},
            ${body.counterpartyId??null}::uuid)`;
        const result=await candidates(tx,tenantId,body);
        return {status:201,body:{observation_id:body.id,identity:result.match,
          confirmed_cash:false,bank_reconciled:false}};
      });
    });
  }));

  app.post("/v1/cash-identity-decisions",async(request,reply)=>execute(reply,async()=>{
    const actor=await principal(request,services),tenantId=tenantHeader(request),key=idempotencyKey(request);
    const parsed=identityBody.safeParse(request.body);
    if (!parsed.success) throw new ApiFault("INVALID_CONTRACT");
    const body=parsed.data;
    if (new Set(body.evidence_ids).size!==body.evidence_ids.length)
      throw new ApiFault("INVALID_CONTRACT");
    return inAuthorizedTransaction(services.db,actor,async tx=>{
      if (await membership(tx,tenantId,actor.userId)!=="owner") throw new ApiFault("NOT_FOUND");
      return once(tx,tenantId,actor.userId,"POST /v1/cash-identity-decisions",key,hash(body),async()=>{
        const [source]=await tx`select * from app.cash_observations
          where tenant_id=${tenantId}::uuid and id=${body.observation_id}::uuid`;
        if (!source) throw new ApiFault("NOT_FOUND");
        const observation=asObservation(source);
        await tx`select pg_advisory_xact_lock(hashtextextended(
          ${`${tenantId}:cash-account:${observation.accountToken??"unknown"}`},0))`;
        const [already]=await tx`select cash_record_id from app.cash_observation_links
          where tenant_id=${tenantId}::uuid and observation_id=${body.observation_id}::uuid`;
        if (already) throw new ApiFault("IDEMPOTENCY_CONFLICT");
        const evidence=await tx`select id from app.evidence_index
          where tenant_id=${tenantId}::uuid and id=any(${tx.array(body.evidence_ids,2950)})`;
        if (evidence.length!==body.evidence_ids.length || !body.evidence_ids.includes(observation.evidenceId))
          throw new ApiFault("NOT_FOUND");
        const found=await candidates(tx,tenantId,observation);
        if (found.match.kind==="missing_basis") throw new ApiFault("DOMAIN_INVARIANT");
        if (!observation.accountToken || !observation.amountMinor || !observation.occurredAt)
          throw new ApiFault("DOMAIN_INVARIANT");
        if (body.choice==="new_distinct") {
          if (found.match.kind==="exact" || found.match.kind==="review" &&
              !observation.providerTxnId && body.evidence_ids.length<2)
            throw new ApiFault("DOMAIN_INVARIANT");
          if (found.match.kind==="review" && !observation.providerTxnId) {
            const supports=await tx`select o.evidence_id,o.account_token,o.direction,o.amount_minor,
              l.cash_record_id from app.cash_observations o
              left join app.cash_observation_links l on l.tenant_id=o.tenant_id and l.observation_id=o.id
              where o.tenant_id=${tenantId}::uuid
                and o.evidence_id=any(${tx.array(body.evidence_ids,2950)})`;
            if (supports.length<2 || supports.some(item=>item.cash_record_id ||
                item.account_token!==observation.accountToken ||
                item.direction!==observation.direction ||
                String(item.amount_minor)!==observation.amountMinor))
              throw new ApiFault("DOMAIN_INVARIANT");
          }
          await tx`insert into app.cash_records
            (tenant_id,id,account_token,direction,amount_minor,occurred_at,normalized_memo,
              bank_reconciled,counterparty_id)
            values (${tenantId}::uuid,${body.cash_record_id}::uuid,${observation.accountToken},
              ${observation.direction},${observation.amountMinor}::numeric,
              ${observation.occurredAt}::timestamptz,${observation.normalizedMemo},false,
              ${observation.counterpartyId??null}::uuid)`;
        } else {
          const [target]=await tx`select id,account_token,direction,amount_minor,bank_reconciled,
            counterparty_id
            from app.cash_records where tenant_id=${tenantId}::uuid and id=${body.cash_record_id}::uuid for update`;
          if (!target || target.account_token!==observation.accountToken ||
              target.direction!==observation.direction || String(target.amount_minor)!==observation.amountMinor ||
              target.counterparty_id && observation.counterpartyId &&
                target.counterparty_id!==observation.counterpartyId)
            throw new ApiFault("DOMAIN_INVARIANT");
          if (observation.provider && observation.providerTxnId) {
            const conflicts=await tx`select transaction_id from app.cash_record_identifiers
              where tenant_id=${tenantId}::uuid and cash_record_id=${body.cash_record_id}::uuid
                and provider=${observation.provider}`;
            if (conflicts.some(item=>item.transaction_id!==observation.providerTxnId))
              throw new ApiFault("DOMAIN_INVARIANT");
          }
        }
        if (observation.provider && observation.providerTxnId)
          await tx`insert into app.cash_record_identifiers
            (tenant_id,account_token,provider,transaction_id,cash_record_id)
            values (${tenantId}::uuid,${observation.accountToken},${observation.provider},
              ${observation.providerTxnId},${body.cash_record_id}::uuid)
            on conflict (tenant_id,account_token,provider,transaction_id) do nothing`;
        if (observation.provider && observation.providerTxnId) {
          const [identifier]=await tx`select cash_record_id from app.cash_record_identifiers
            where tenant_id=${tenantId}::uuid and account_token=${observation.accountToken}
              and provider=${observation.provider} and transaction_id=${observation.providerTxnId}`;
          if (identifier?.cash_record_id!==body.cash_record_id) throw new ApiFault("DOMAIN_INVARIANT");
        }
        const decisionHash=hash(body);
        const [decision]=await tx`insert into app.decisions
          (tenant_id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash)
          values (${tenantId}::uuid,${actor.userId}::uuid,'cash_identity',${body.choice},
            ${tx.array([body.observation_id,body.cash_record_id],2950)},${tx.array([1,1],20)},
            ${tx.array(body.evidence_ids,2950)},${body.reason},${decisionHash}) returning id`;
        if (!decision) throw new ApiFault("TEMPORARILY_UNAVAILABLE");
        await tx`insert into app.cash_observation_links
          (tenant_id,observation_id,cash_record_id,decision_id)
          values (${tenantId}::uuid,${body.observation_id}::uuid,${body.cash_record_id}::uuid,
            ${decision.id}::uuid)`;
        if (observation.source==="bank")
          await tx`update app.cash_records set bank_reconciled=true,version=version+1
            where tenant_id=${tenantId}::uuid and id=${body.cash_record_id}::uuid
              and not bank_reconciled`;
        const [finalRecord]=await tx`select bank_reconciled from app.cash_records
          where tenant_id=${tenantId}::uuid and id=${body.cash_record_id}::uuid`;
        return {status:201,body:{cash_record_id:body.cash_record_id,observation_id:body.observation_id,
          decision_id:decision.id,choice:body.choice,amount_minor:observation.amountMinor,
          bank_reconciled:finalRecord?.bank_reconciled===true,applications_changed:false}};
      });
    });
  }));
}
