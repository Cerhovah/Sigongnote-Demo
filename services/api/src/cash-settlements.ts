import { createHash } from "node:crypto";
import { UuidSchema } from "@sigongnote/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { inAuthorizedTransaction } from "./auth.js";
import { ApiFault, execute, idempotencyKey, membership, once, principal, tenantHeader,
  type Services } from "./routes.js";

const minor=z.string().regex(/^[1-9][0-9]{0,18}$/);
const cashBody=z.object({id:UuidSchema,cash_record_id:UuidSchema,invoice_id:UuidSchema,
  amount_minor:minor,kind:z.enum(["apply","reversal"]),
  reverses_application_id:UuidSchema.nullable(),expected_cash_version:z.number().int().positive(),
  expected_invoice_version:z.number().int().positive(),evidence_ids:z.array(UuidSchema).min(1).max(20),
  reason:z.string().trim().min(10).max(1000)}).strict();
const noncashBody=z.object({id:UuidSchema,basis_kind:z.enum(["offset_agreement",
  "writeoff_agreement","writeoff_reason","reversal_basis"]),
  kind:z.enum(["offset","writeoff_receivable",
  "writeoff_payable","reversal"]),receivable_invoice_id:UuidSchema.nullable(),
  payable_invoice_id:UuidSchema.nullable(),reverses_settlement_id:UuidSchema.nullable(),
  amount_minor:minor,evidence_id:UuidSchema,expected_receivable_version:z.number().int().positive().nullable(),
  expected_payable_version:z.number().int().positive().nullable(),
  reason:z.string().trim().min(10).max(1000)}).strict();
function hash(value:unknown) {return createHash("sha256").update(JSON.stringify(value)).digest("hex");}
function minorText(value:unknown) {return String(value);}

export function registerCashSettlementRoutes(app:FastifyInstance,services:Services) {
  app.post("/v1/cash-applications",async(request,reply)=>execute(reply,async()=>{
    const actor=await principal(request,services),tenantId=tenantHeader(request),key=idempotencyKey(request);
    const parsed=cashBody.safeParse(request.body);
    if (!parsed.success) throw new ApiFault("INVALID_CONTRACT");
    const body=parsed.data;
    if (new Set(body.evidence_ids).size!==body.evidence_ids.length ||
        (body.kind==="apply")!==(body.reverses_application_id===null))
      throw new ApiFault("INVALID_CONTRACT");
    return inAuthorizedTransaction(services.db,actor,async tx=>{
      if (await membership(tx,tenantId,actor.userId)!=="owner") throw new ApiFault("NOT_FOUND");
      return once(tx,tenantId,actor.userId,"POST /v1/cash-applications",key,hash(body),async()=>{
        const [account]=await tx`select account_token from app.cash_records
          where tenant_id=${tenantId}::uuid and id=${body.cash_record_id}::uuid`;
        if (!account) throw new ApiFault("NOT_FOUND");
        await tx`select pg_advisory_xact_lock(hashtextextended(
          ${`${tenantId}:cash-account:${account.account_token}`},0))`;
        const [cash]=await tx`select amount_minor,direction,bank_reconciled,version,counterparty_id
          from app.cash_records
          where tenant_id=${tenantId}::uuid and id=${body.cash_record_id}::uuid for update`;
        const [invoice]=await tx`select direction,status,version,counterparty_id from app.invoices
          where tenant_id=${tenantId}::uuid and id=${body.invoice_id}::uuid for update`;
        if (!cash || !invoice) throw new ApiFault("NOT_FOUND");
        if (Number(cash.version)!==body.expected_cash_version ||
            Number(invoice.version)!==body.expected_invoice_version)
          throw new ApiFault("VERSION_CONFLICT",Number(invoice.version));
        if (invoice.status!=="approved" ||
            (cash.direction==="incoming"?invoice.direction!=="receivable":
              invoice.direction!=="payable") || cash.counterparty_id &&
              cash.counterparty_id!==invoice.counterparty_id) throw new ApiFault("DOMAIN_INVARIANT");
        const evidence=await tx`select o.evidence_id from app.cash_observations o
          join app.cash_observation_links l on l.tenant_id=o.tenant_id and l.observation_id=o.id
          where l.tenant_id=${tenantId}::uuid and l.cash_record_id=${body.cash_record_id}::uuid
            and o.evidence_id=any(${tx.array(body.evidence_ids,2950)})`;
        if (evidence.length!==body.evidence_ids.length) throw new ApiFault("DOMAIN_INVARIANT");
        const decisionHash=hash(body);
        const [decision]=await tx`insert into app.decisions
          (tenant_id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash)
          values (${tenantId}::uuid,${actor.userId}::uuid,'cash_application',${body.kind},
            ${tx.array([body.cash_record_id,body.invoice_id],2950)},
            ${tx.array([body.expected_cash_version,body.expected_invoice_version],20)},
            ${tx.array(body.evidence_ids,2950)},${body.reason},${decisionHash}) returning id`;
        if (!decision) throw new ApiFault("TEMPORARILY_UNAVAILABLE");
        await tx`insert into app.cash_applications
          (tenant_id,id,cash_record_id,invoice_id,amount_minor,kind,reverses_application_id,decision_id)
          values (${tenantId}::uuid,${body.id}::uuid,${body.cash_record_id}::uuid,
            ${body.invoice_id}::uuid,${body.amount_minor}::numeric,${body.kind},
            ${body.reverses_application_id}::uuid,${decision.id}::uuid)`;
        await tx`update app.cash_records set version=version+1
          where tenant_id=${tenantId}::uuid and id=${body.cash_record_id}::uuid`;
        const [remaining]=await tx`select app.invoice_settlement_remaining(
          ${tenantId}::uuid,${body.invoice_id}::uuid) as amount`;
        const [cashNet]=await tx`select coalesce(sum(case when kind='apply' then amount_minor
          else -amount_minor end),0) as amount from app.cash_applications
          where tenant_id=${tenantId}::uuid and cash_record_id=${body.cash_record_id}::uuid`;
        return {status:201,body:{id:body.id,decision_id:decision.id,
          invoice_remaining_minor:minorText(remaining?.amount),
          cash_unapplied_minor:(BigInt(String(cash.amount_minor))-BigInt(String(cashNet?.amount))).toString(),
          bank_reconciled:cash.bank_reconciled===true,
          cash_version:body.expected_cash_version+1,effect:"ledger_only"}};
      });
    });
  }));

  app.post("/v1/noncash-settlements",async(request,reply)=>execute(reply,async()=>{
    const actor=await principal(request,services),tenantId=tenantHeader(request),key=idempotencyKey(request);
    const parsed=noncashBody.safeParse(request.body);
    if (!parsed.success) throw new ApiFault("INVALID_CONTRACT");
    const body=parsed.data;
    if ((body.kind==="offset" && (!body.receivable_invoice_id || !body.payable_invoice_id)) ||
        (body.kind==="writeoff_receivable" && (!body.receivable_invoice_id || body.payable_invoice_id)) ||
        (body.kind==="writeoff_payable" && (!body.payable_invoice_id || body.receivable_invoice_id)) ||
        (body.kind==="reversal")!==(body.reverses_settlement_id!==null) ||
        (body.receivable_invoice_id!==null)!==(body.expected_receivable_version!==null) ||
        (body.payable_invoice_id!==null)!==(body.expected_payable_version!==null))
      throw new ApiFault("INVALID_CONTRACT");
    return inAuthorizedTransaction(services.db,actor,async tx=>{
      if (await membership(tx,tenantId,actor.userId)!=="owner") throw new ApiFault("NOT_FOUND");
      return once(tx,tenantId,actor.userId,"POST /v1/noncash-settlements",key,hash(body),async()=>{
        const [source]=await tx`select id from app.evidence_index
          where tenant_id=${tenantId}::uuid and id=${body.evidence_id}::uuid
            and source_kind='original' and category in ('agreement','billing_payment')`;
        if (!source) throw new ApiFault("DOMAIN_INVARIANT");
        if (body.kind==="offset" && body.basis_kind!=="offset_agreement" ||
            body.kind.startsWith("writeoff") && !["writeoff_agreement","writeoff_reason"].includes(body.basis_kind) ||
            body.kind==="reversal" && body.basis_kind!=="reversal_basis")
          throw new ApiFault("DOMAIN_INVARIANT");
        const targets=[body.receivable_invoice_id,body.payable_invoice_id].filter((id):id is string=>!!id).sort();
        const invoices:Array<{id:string;direction:string;status:string;version:number;
          counterparty_id:string|null;source_evidence_id:string|null}>=[];
        for (const id of targets) {
          const [invoice]=await tx`select id,direction,status,version,counterparty_id,
            source_evidence_id from app.invoices
            where tenant_id=${tenantId}::uuid and id=${id}::uuid for update`;
          if (!invoice) throw new ApiFault("NOT_FOUND");
          invoices.push({id:String(invoice.id),direction:String(invoice.direction),
            status:String(invoice.status),version:Number(invoice.version),
            counterparty_id:invoice.counterparty_id===null?null:String(invoice.counterparty_id),
            source_evidence_id:invoice.source_evidence_id===null?null:String(invoice.source_evidence_id)});
        }
        if (invoices.some(invoice=>invoice.status!=="approved" ||
            (invoice.id===body.receivable_invoice_id && invoice.direction!=="receivable") ||
            (invoice.id===body.payable_invoice_id && invoice.direction!=="payable") ||
            (invoice.id===body.receivable_invoice_id && Number(invoice.version)!==body.expected_receivable_version) ||
            (invoice.id===body.payable_invoice_id && Number(invoice.version)!==body.expected_payable_version)))
          throw new ApiFault("DOMAIN_INVARIANT");
        if (body.kind==="offset" && (!invoices[0]?.counterparty_id ||
            invoices[0].counterparty_id!==invoices[1]?.counterparty_id))
          throw new ApiFault("DOMAIN_INVARIANT");
        if (invoices.some(invoice=>invoice.source_evidence_id===body.evidence_id))
          throw new ApiFault("DOMAIN_INVARIANT");
        const decisionHash=hash(body);
        const [decision]=await tx`insert into app.decisions
          (tenant_id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash)
          values (${tenantId}::uuid,${actor.userId}::uuid,'noncash_settlement',${body.kind},
            ${tx.array(targets,2950)},${tx.array(targets.map(id=>Number(invoices.find(i=>i.id===id)?.version)),20)},
            ${tx.array([body.evidence_id],2950)},${body.reason},${decisionHash}) returning id`;
        if (!decision) throw new ApiFault("TEMPORARILY_UNAVAILABLE");
        await tx`insert into app.noncash_settlements
          (tenant_id,id,receivable_invoice_id,payable_invoice_id,amount_minor,decision_id,evidence_id,
            kind,basis_kind,reverses_settlement_id)
          values (${tenantId}::uuid,${body.id}::uuid,${body.receivable_invoice_id}::uuid,
            ${body.payable_invoice_id}::uuid,${body.amount_minor}::numeric,${decision.id}::uuid,
            ${body.evidence_id}::uuid,${body.kind},${body.basis_kind},
            ${body.reverses_settlement_id}::uuid)`;
        return {status:201,body:{id:body.id,decision_id:decision.id,kind:body.kind,
          cash_flow_minor:"0",effect:"balance_only"}};
      });
    });
  }));

  app.get<{Params:{id:string}}>("/v1/invoices/:id/settlement",async(request,reply)=>execute(reply,async()=>{
    const actor=await principal(request,services),tenantId=tenantHeader(request),id=UuidSchema.safeParse(request.params.id);
    if (!id.success) throw new ApiFault("INVALID_CONTRACT");
    return inAuthorizedTransaction(services.db,actor,async tx=>{
      const role=await membership(tx,tenantId,actor.userId);
      if (!["owner","operator","accountant"].includes(role)) throw new ApiFault("NOT_FOUND");
      const [invoice]=await tx`select direction,status from app.invoices
        where tenant_id=${tenantId}::uuid and id=${id.data}::uuid`;
      if (!invoice) throw new ApiFault("NOT_FOUND");
      const [gross]=await tx`select coalesce(sum(gross_minor),0) as amount from app.invoice_lines
        where tenant_id=${tenantId}::uuid and invoice_id=${id.data}::uuid`;
      const [cash]=await tx`select coalesce(sum(case when a.kind='apply' then a.amount_minor
        else -a.amount_minor end),0) as amount,
        coalesce(sum(case when c.bank_reconciled and a.kind='apply' then a.amount_minor
          when c.bank_reconciled then -a.amount_minor else 0 end),0) as bank_amount
        from app.cash_applications a join app.cash_records c
          on c.tenant_id=a.tenant_id and c.id=a.cash_record_id
        where a.tenant_id=${tenantId}::uuid and a.invoice_id=${id.data}::uuid`;
      const [remaining]=await tx`select app.invoice_settlement_remaining(
        ${tenantId}::uuid,${id.data}::uuid) as amount`;
      return {status:200,body:{invoice_id:id.data,direction:invoice.direction,status:invoice.status,
        approved_gross_minor:invoice.status==="approved"?minorText(gross?.amount):null,
        applied_cash_minor:minorText(cash?.amount),bank_reconciled_cash_minor:minorText(cash?.bank_amount),
        remaining_minor:invoice.status==="approved"?minorText(remaining?.amount):null,
        payment_confirmed:false,statement_match_basis:"user_supplied_statement",
        statement_matched_full_cash:invoice.status==="approved" &&
          BigInt(String(gross?.amount))>0n && BigInt(String(remaining?.amount))===0n &&
          BigInt(String(cash?.amount))===BigInt(String(gross?.amount)) &&
          BigInt(String(cash?.amount))===BigInt(String(cash?.bank_amount))}};
    });
  }));
}
