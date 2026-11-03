import { createHash } from "node:crypto";
import { UuidSchema } from "@sigongnote/contracts";
import { invoiceChargeLinkSchema, invoiceLineSchema, reconcileInvoiceLinks } from "@sigongnote/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { inAuthorizedTransaction, type Tx } from "./auth.js";
import { ApiFault, execute, expectedVersion, idempotencyKey, membership, once, principal, tenantHeader,
  type Services } from "./routes.js";

const draftSchema = z.object({ id: UuidSchema, direction: z.enum(["receivable","payable"]),
  counterparty_id: UuidSchema.nullable(), stage: z.enum(["advance","progress","final","other"]),
  bundle_id: UuidSchema.nullable(),
  agreement_id: UuidSchema.nullable(), sequence: z.number().int().positive().nullable(),
  tax_mode: z.enum(["unknown","exclusive","inclusive","not_applicable"]),
  source_evidence_id: UuidSchema.nullable(), due_at: z.iso.datetime({offset:true}).nullable(),
  lines: z.array(invoiceLineSchema).min(1).max(100) }).strict();
const linkBody = z.object({ link: invoiceChargeLinkSchema, claim_complete: z.boolean() }).strict();
const agreementBody = z.object({ id:UuidSchema,bundle_id:UuidSchema,source_evidence_id:UuidSchema,
  approved_gross_minor:z.string().regex(/^[1-9][0-9]{0,18}$/),
  reason:z.string().trim().min(10).max(1000) }).strict();
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function registerInvoiceRoutes(app: FastifyInstance, services: Services) {
  app.post("/v1/billing-agreements", async (request, reply) => execute(reply, async () => {
    const actor = await principal(request, services),tenantId=tenantHeader(request);
    const key=idempotencyKey(request),parsed=agreementBody.safeParse(request.body);
    if (!parsed.success) throw new ApiFault("INVALID_CONTRACT");
    const body=parsed.data;
    return inAuthorizedTransaction(services.db,actor,async tx => {
      if (await membership(tx,tenantId,actor.userId)!=="owner") throw new ApiFault("NOT_FOUND");
      return once(tx,tenantId,actor.userId,"POST /v1/billing-agreements",key,hash(body),async () => {
        const [bundle]=await tx`select id from app.work_bundles
          where tenant_id=${tenantId}::uuid and id=${body.bundle_id}::uuid`;
        const [evidence]=await tx`select e.id from app.evidence_index e
          join app.evidence_attributions a on a.tenant_id=e.tenant_id and a.evidence_index_id=e.id
          where e.tenant_id=${tenantId}::uuid and e.id=${body.source_evidence_id}::uuid
            and e.source_kind='original' and e.category='agreement' and a.state='confirmed'
            and a.bundle_id=${body.bundle_id}::uuid`;
        if (!bundle || !evidence) throw new ApiFault("DOMAIN_INVARIANT");
        const decisionHash=hash(body);
        const [decision]=await tx`insert into app.decisions
          (tenant_id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash)
          values (${tenantId}::uuid,${actor.userId}::uuid,'billing_agreement','approve_gross',
            ${tx.array([body.id],2950)},${tx.array([1],20)},
            ${tx.array([body.source_evidence_id],2950)},${body.reason},${decisionHash}) returning id`;
        if (!decision) throw new ApiFault("TEMPORARILY_UNAVAILABLE");
        await tx`insert into app.billing_agreements
          (tenant_id,id,bundle_id,source_evidence_id,approved_gross_minor,decision_id)
          values (${tenantId}::uuid,${body.id}::uuid,${body.bundle_id}::uuid,
            ${body.source_evidence_id}::uuid,${body.approved_gross_minor}::numeric,${decision.id}::uuid)`;
        return {status:201,body:{id:body.id,bundle_id:body.bundle_id,
          approved_gross_minor:body.approved_gross_minor,decision_id:decision.id}};
      });
    });
  }));

  app.post("/v1/invoices", async (request, reply) => execute(reply, async () => {
    const actor = await principal(request, services), tenantId = tenantHeader(request);
    const key = idempotencyKey(request), parsed = draftSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiFault("INVALID_CONTRACT");
    const body = parsed.data;
    if (new Set(body.lines.map(line => line.id)).size !== body.lines.length ||
        body.lines.some(line => line.invoiceId !== body.id || line.tenantId !== tenantId ||
          line.direction !== body.direction || line.stage !== body.stage || line.taxMode !== body.tax_mode) ||
        body.direction === "receivable" && (!body.bundle_id || !body.source_evidence_id ||
          !body.agreement_id || !body.sequence) ||
        body.direction === "payable" && (body.agreement_id !== null || body.sequence !== null))
      throw new ApiFault("INVALID_CONTRACT");
    return inAuthorizedTransaction(services.db, actor, async tx => {
      if (await membership(tx, tenantId, actor.userId) !== "owner") throw new ApiFault("NOT_FOUND");
      return once(tx, tenantId, actor.userId, "POST /v1/invoices", key, hash(body), async () => {
        if (body.source_evidence_id) {
          const [source] = await tx`select id from app.evidence_index
            where tenant_id=${tenantId}::uuid and id=${body.source_evidence_id}::uuid and source_kind='original'`;
          if (!source) throw new ApiFault("NOT_FOUND");
        }
        if (body.bundle_id) {
          const [bundle] = await tx`select id from app.work_bundles
            where tenant_id=${tenantId}::uuid and id=${body.bundle_id}::uuid`;
          if (!bundle) throw new ApiFault("NOT_FOUND");
        }
        if (body.direction === "receivable") {
          const [agreement] = await tx`select id from app.billing_agreements
            where tenant_id=${tenantId}::uuid and id=${body.agreement_id}::uuid
              and bundle_id=${body.bundle_id}::uuid and source_evidence_id=${body.source_evidence_id}::uuid`;
          if (!agreement) throw new ApiFault("DOMAIN_INVARIANT");
        }
        await tx`insert into app.invoices(tenant_id,id,direction,counterparty_id,status,stage,tax_mode,
          source_evidence_id,due_at,bundle_id,agreement_id,sequence)
          values (${tenantId}::uuid,${body.id}::uuid,${body.direction},
            ${body.counterparty_id}::uuid,'draft',${body.stage},${body.tax_mode},
            ${body.source_evidence_id}::uuid,${body.due_at},${body.bundle_id}::uuid,
            ${body.agreement_id}::uuid,${body.sequence})`;
        for (const line of body.lines) await tx`insert into app.invoice_lines
          (tenant_id,id,invoice_id,supply_minor,vat_minor,gross_minor,reverses_invoice_line_id)
          values (${tenantId}::uuid,${line.id}::uuid,${body.id}::uuid,
            ${line.supplyMinor}::numeric,${line.vatMinor}::numeric,${line.grossMinor}::numeric,
            ${line.reversesInvoiceLineId}::uuid)`;
        return { status:201, body:{ id:body.id,status:"draft",version:1,direction:body.direction,
          new_cost_minor:"0",tax_mode:body.tax_mode } };
      });
    });
  }));

  app.post("/v1/invoice-charge-links", async (request, reply) => execute(reply, async () => {
    const actor = await principal(request, services), tenantId = tenantHeader(request);
    const key = idempotencyKey(request), expected = expectedVersion(request);
    const parsed = linkBody.safeParse(request.body);
    if (!parsed.success || parsed.data.link.tenantId !== tenantId) throw new ApiFault("INVALID_CONTRACT");
    const { link, claim_complete: claimComplete } = parsed.data;
    return inAuthorizedTransaction(services.db, actor, async tx => {
      if (await membership(tx, tenantId, actor.userId) !== "owner") throw new ApiFault("NOT_FOUND");
      return once(tx, tenantId, actor.userId, "POST /v1/invoice-charge-links", key,
        hash({ link, claimComplete, expected }), async () => {
          const [parentLocked] = await tx`select i.id from app.invoices i
            join app.invoice_lines l on l.tenant_id=i.tenant_id and l.invoice_id=i.id
            where l.tenant_id=${tenantId}::uuid and l.id=${link.invoiceLineId}::uuid for update of i`;
          if (!parentLocked) throw new ApiFault("NOT_FOUND");
          await tx`select pg_advisory_xact_lock(hashtextextended(
            ${`${tenantId}:invoice-charge:${link.chargeCaseId}`},0))`;
          await tx`select pg_advisory_xact_lock(hashtextextended(
            ${`${tenantId}:invoice-line:${link.invoiceLineId}`},0))`;
          const [invoiceLine] = await tx`select l.id,l.invoice_id,l.supply_minor,l.vat_minor,l.gross_minor,
            l.reverses_invoice_line_id,i.direction,i.stage,i.tax_mode,i.status,i.version,i.counterparty_id
            from app.invoice_lines l join app.invoices i on i.tenant_id=l.tenant_id and i.id=l.invoice_id
            where l.tenant_id=${tenantId}::uuid and l.id=${link.invoiceLineId}::uuid`;
          if (!invoiceLine) throw new ApiFault("NOT_FOUND");
          if (Number(invoiceLine.version) !== expected) throw new ApiFault("VERSION_CONFLICT",Number(invoiceLine.version));
          if (invoiceLine.status !== "draft" || invoiceLine.direction !== "payable")
            throw new ApiFault("DOMAIN_INVARIANT");
          const lineGross = BigInt(String(invoiceLine.gross_minor));
          const linkGross = BigInt(link.grossMinor);
          if (lineGross === 0n || lineGross > 0n && linkGross < 0n ||
              lineGross < 0n && linkGross >= 0n) throw new ApiFault("DOMAIN_INVARIANT");
          const [priorLineTotal] = await tx`select coalesce(sum(gross_minor),0) as gross
            from app.invoice_charge_links where tenant_id=${tenantId}::uuid
              and invoice_line_id=${link.invoiceLineId}::uuid`;
          const lineLinked = BigInt(String(priorLineTotal?.gross ?? "0")) + linkGross;
          if (lineGross > 0n && lineLinked > lineGross || lineGross < 0n && lineLinked < lineGross)
            throw new ApiFault("DOMAIN_INVARIANT");
          const [charge] = await tx`select c.current_revision_id,c.status,r.confirmed_actual_minor,r.tax_mode,
            r.payload->>'partyId' as party_id
            from app.charge_cases c join app.charge_revisions r
              on r.tenant_id=c.tenant_id and r.id=c.current_revision_id
            where c.tenant_id=${tenantId}::uuid and c.id=${link.chargeCaseId}::uuid`;
          if (!charge || !["confirmed","adjusted"].includes(charge.status) ||
              link.chargeRevisionId !== charge.current_revision_id) throw new ApiFault("DOMAIN_INVARIANT");
          if (!charge.party_id || !invoiceLine.counterparty_id ||
              charge.party_id !== invoiceLine.counterparty_id) throw new ApiFault("DOMAIN_INVARIANT");
          const rows = await tx`select k.id,k.invoice_line_id,k.charge_case_id,k.charge_revision_id,
            k.supply_minor,k.vat_minor,k.gross_minor,k.reverses_link_id,
            l.invoice_id,l.reverses_invoice_line_id,i.direction,i.stage,i.tax_mode,
            l.supply_minor as line_supply,l.vat_minor as line_vat,l.gross_minor as line_gross
            from app.invoice_charge_links k join app.invoice_lines l
              on l.tenant_id=k.tenant_id and l.id=k.invoice_line_id
            join app.invoices i on i.tenant_id=l.tenant_id and i.id=l.invoice_id
            where k.tenant_id=${tenantId}::uuid and k.charge_case_id=${link.chargeCaseId}::uuid`;
          const toLine = (row: Record<string,unknown>) => ({ id:String(row.id),invoiceId:String(row.invoice_id),
            tenantId,direction:row.direction,stage:row.stage,
            supplyMinor:row.line_supply === null ? null : String(row.line_supply),
            vatMinor:row.line_vat === null ? null : String(row.line_vat),
            grossMinor:String(row.line_gross),taxMode:row.tax_mode,
            reversesInvoiceLineId:row.reverses_invoice_line_id });
          const currentLine = { id:link.invoiceLineId,invoiceId:String(invoiceLine.invoice_id),tenantId,
            direction:invoiceLine.direction,stage:invoiceLine.stage,
            supplyMinor:invoiceLine.supply_minor === null ? null : String(invoiceLine.supply_minor),
            vatMinor:invoiceLine.vat_minor === null ? null : String(invoiceLine.vat_minor),
            grossMinor:String(invoiceLine.gross_minor),taxMode:invoiceLine.tax_mode,
            reversesInvoiceLineId:invoiceLine.reverses_invoice_line_id };
          const lines = [...new Map([...rows.map(row => toLine({...row,id:row.invoice_line_id})),currentLine]
            .map(line => [line.id,line])).values()];
          const links = [...rows.map(row => ({ id:row.id,tenantId,invoiceLineId:row.invoice_line_id,
            chargeCaseId:row.charge_case_id,chargeRevisionId:row.charge_revision_id,
            supplyMinor:row.supply_minor === null ? null : String(row.supply_minor),
            vatMinor:row.vat_minor === null ? null : String(row.vat_minor),
            grossMinor:String(row.gross_minor),reversesLinkId:row.reverses_link_id })),link];
          try { reconcileInvoiceLinks(lines,links,[{tenantId,caseId:link.chargeCaseId,
            revisionId:link.chargeRevisionId,confirmedMinor:charge.confirmed_actual_minor === null
              ? null:String(charge.confirmed_actual_minor),taxMode:charge.tax_mode}],claimComplete); }
          catch { throw new ApiFault("DOMAIN_INVARIANT"); }
          await tx`insert into app.invoice_charge_links
            (tenant_id,id,invoice_line_id,charge_case_id,charge_revision_id,supply_minor,vat_minor,
              gross_minor,reverses_link_id)
            values (${tenantId}::uuid,${link.id}::uuid,${link.invoiceLineId}::uuid,
              ${link.chargeCaseId}::uuid,${link.chargeRevisionId}::uuid,
              ${link.supplyMinor}::numeric,${link.vatMinor}::numeric,${link.grossMinor}::numeric,
              ${link.reversesLinkId}::uuid)`;
          if (claimComplete) await tx`insert into app.invoice_reconciliation_exceptions
            (tenant_id,invoice_line_id,expected_gross_minor,linked_gross_minor,state)
            values (${tenantId}::uuid,${link.invoiceLineId}::uuid,${lineGross.toString()}::numeric,
              ${lineLinked.toString()}::numeric,${lineGross === lineLinked ? "resolved" : "open"})
            on conflict (tenant_id,invoice_line_id) do update set
              linked_gross_minor=excluded.linked_gross_minor,state=excluded.state,
              version=app.invoice_reconciliation_exceptions.version+1,updated_at=now()`;
          return { status:201,body:{ link_id:link.id,invoice_line_id:link.invoiceLineId,
            linked_gross_minor:lineLinked.toString(),unmatched_gross_minor:(lineGross-lineLinked).toString(),
            difference_exception:claimComplete && lineGross !== lineLinked,new_cost_minor:"0",
            invoice_status:"draft",draft_basis:true,
            tax_comparison_verified:charge.tax_mode !== "unknown" && invoiceLine.tax_mode !== "unknown" } };
        });
    });
  }));

  app.post<{Params:{id:string}}>("/v1/invoices/:id/approve", async (request, reply) => execute(reply, async () => {
    const actor = await principal(request, services), tenantId = tenantHeader(request);
    const key = idempotencyKey(request), expected = expectedVersion(request);
    const id = UuidSchema.safeParse(request.params.id);
    const parsed = z.object({ reason:z.string().trim().min(10).max(1000) }).strict().safeParse(request.body);
    if (!id.success || !parsed.success) throw new ApiFault("INVALID_CONTRACT");
    return inAuthorizedTransaction(services.db, actor, async tx => {
      if (await membership(tx, tenantId, actor.userId) !== "owner") throw new ApiFault("NOT_FOUND");
      return once(tx, tenantId, actor.userId, `POST /v1/invoices/${id.data}/approve`, key,
        hash({reason:parsed.data.reason,expected}), async () => {
          return approveInvoice(tx,tenantId,actor.userId,id.data,expected,parsed.data.reason);
        });
    });
  }));
}

export async function approveInvoice(tx:Tx,tenantId:string,userId:string,invoiceId:string,expected:number,reason:string){
          const [invoice] = await tx`select id,direction,counterparty_id,status,version,tax_mode,
            bundle_id,agreement_id,source_evidence_id from app.invoices
            where tenant_id=${tenantId}::uuid and id=${invoiceId}::uuid for update`;
          if (!invoice) throw new ApiFault("NOT_FOUND");
          if (Number(invoice.version) !== expected) throw new ApiFault("VERSION_CONFLICT",Number(invoice.version));
          if (invoice.status !== "draft" || !invoice.counterparty_id || !invoice.source_evidence_id ||
              invoice.tax_mode === "unknown") throw new ApiFault("DOMAIN_INVARIANT");
          const [source] = await tx`select id,category,source_kind from app.evidence_index
            where tenant_id=${tenantId}::uuid and id=${invoice.source_evidence_id}::uuid`;
          if (source?.source_kind !== "original") throw new ApiFault("DOMAIN_INVARIANT");
          const lines = await tx`select id,supply_minor,vat_minor,gross_minor from app.invoice_lines
            where tenant_id=${tenantId}::uuid and invoice_id=${invoiceId}::uuid`;
          if (!lines.length) throw new ApiFault("DOMAIN_INVARIANT");
          if (invoice.tax_mode !== "not_applicable" && lines.some(line =>
            line.supply_minor === null || line.vat_minor === null)) throw new ApiFault("DOMAIN_INVARIANT");
          if (invoice.tax_mode === "not_applicable" && lines.some(line => line.vat_minor !== null))
            throw new ApiFault("DOMAIN_INVARIANT");
          if (invoice.direction === "receivable") {
            const [invoiceBundle]=await tx`select work_order_id from app.work_bundles
              where tenant_id=${tenantId}::uuid and id=${invoice.bundle_id}::uuid`;
            if (!invoiceBundle) throw new ApiFault("NOT_FOUND");
            await tx`select pg_advisory_xact_lock(hashtextextended(
              ${`${tenantId}:contract-order:${invoiceBundle.work_order_id}`},0))`;
            await tx`select pg_advisory_xact_lock(hashtextextended(
              ${`${tenantId}:billing-agreement:${invoice.agreement_id}`},0))`;
            const [agreement] = await tx`select approved_gross_minor from app.billing_agreements
              where tenant_id=${tenantId}::uuid and id=${invoice.agreement_id}::uuid
                and bundle_id=${invoice.bundle_id}::uuid
                and source_evidence_id=${invoice.source_evidence_id}::uuid`;
            const [attribution] = await tx`select a.evidence_index_id from app.evidence_attributions a
              where a.tenant_id=${tenantId}::uuid and a.evidence_index_id=${invoice.source_evidence_id}::uuid
                and a.state='confirmed' and a.bundle_id=${invoice.bundle_id}::uuid`;
            if (source.category !== "agreement" || !attribution || !agreement)
              throw new ApiFault("DOMAIN_INVARIANT");
            const [prior] = await tx`select coalesce(sum(l.gross_minor),0) as amount
              from app.invoices i join app.invoice_lines l on l.tenant_id=i.tenant_id and l.invoice_id=i.id
              where i.tenant_id=${tenantId}::uuid and i.agreement_id=${invoice.agreement_id}::uuid
                and i.status='approved'`;
            const proposed = lines.reduce((sum,line) => sum+BigInt(String(line.gross_minor)),0n);
            if (proposed<=0n || BigInt(String(prior?.amount ?? "0"))+proposed >
                BigInt(String(agreement.approved_gross_minor))) throw new ApiFault("DOMAIN_INVARIANT");
            const [contract]=await tx`select count(*)::integer as line_count,
              coalesce(sum(supply_minor),0) as supply from app.contract_lines
              where tenant_id=${tenantId}::uuid and work_order_id=${invoiceBundle.work_order_id}::uuid
                and active`;
            if (Number(contract?.line_count)>0) {
              const [billed]=await tx`select coalesce(sum(l.supply_minor),0) as supply,
                count(*) filter (where l.supply_minor is null)::integer as unknown
                from app.invoices i join app.invoice_lines l
                  on l.tenant_id=i.tenant_id and l.invoice_id=i.id
                join app.work_bundles b on b.tenant_id=i.tenant_id and b.id=i.bundle_id
                where i.tenant_id=${tenantId}::uuid and b.work_order_id=
                  ${invoiceBundle.work_order_id}::uuid and i.direction='receivable'
                  and i.status='approved'`;
              if (Number(billed?.unknown)>0 || lines.some(line=>line.supply_minor===null) ||
                  BigInt(String(billed?.supply??0))+
                    lines.reduce((sum,line)=>sum+BigInt(String(line.supply_minor)),0n)>
                  BigInt(String(contract?.supply??0))) throw new ApiFault("DOMAIN_INVARIANT");
            }
          } else {
            for (const line of lines) {
              const [total] = await tx`select coalesce(sum(k.gross_minor),0) as amount,
                sum(k.supply_minor) as supply,sum(k.vat_minor) as vat,
                count(k.supply_minor)::int as supply_count,count(k.vat_minor)::int as vat_count,
                count(*)::int as links,
                count(*) filter (where k.charge_revision_id<>c.current_revision_id)::int as stale
                from app.invoice_charge_links k join app.charge_cases c
                  on c.tenant_id=k.tenant_id and c.id=k.charge_case_id
                where k.tenant_id=${tenantId}::uuid and k.invoice_line_id=${line.id}::uuid`;
              if (!total || Number(total.links)===0 || Number(total.stale)>0 ||
                  String(total.amount)!==String(line.gross_minor) ||
                  invoice.tax_mode !== "not_applicable" &&
                    (Number(total.supply_count)!==Number(total.links) ||
                     Number(total.vat_count)!==Number(total.links) ||
                     String(total.supply)!==String(line.supply_minor) ||
                     String(total.vat)!==String(line.vat_minor))) throw new ApiFault("DOMAIN_INVARIANT");
              const [open] = await tx`select id from app.invoice_reconciliation_exceptions
                where tenant_id=${tenantId}::uuid and invoice_line_id=${line.id}::uuid and state='open'`;
              if (open) throw new ApiFault("DOMAIN_INVARIANT");
            }
          }
          const decisionHash = hash({invoiceId:invoiceId,version:expected,reason:reason});
          const [decision] = await tx`insert into app.decisions
            (tenant_id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash)
            values (${tenantId}::uuid,${userId}::uuid,'invoice_approval','approve',
              ${tx.array([invoiceId],2950)},${tx.array([expected],20)},
              ${tx.array([invoice.source_evidence_id],2950)},${reason},${decisionHash}) returning id`;
          if (!decision) throw new ApiFault("TEMPORARILY_UNAVAILABLE");
          const [approved] = await tx`update app.invoices set status='approved',version=version+1,
            approval_decision_id=${decision.id}::uuid where tenant_id=${tenantId}::uuid and id=${invoiceId}::uuid
              and version=${expected} returning version`;
          if (!approved) throw new ApiFault("VERSION_CONFLICT");
          const gross = lines.reduce((sum,line) => sum+BigInt(String(line.gross_minor)),0n);
          return { status:201,body:{id:invoiceId,status:"approved",version:Number(approved.version),
            direction:invoice.direction,approved_gross_minor:gross.toString(),
            approval_decision_id:decision.id,payment_confirmed:false,new_cost_minor:"0"} };
}
