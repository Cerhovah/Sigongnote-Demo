import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { UuidSchema } from "@sigongnote/contracts";
import { allocateScopeSupply, applyContractOperation, isScopeReduction,
  parseTradePack } from "@sigongnote/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { inAuthorizedTransaction, type Tx } from "./auth.js";
import { ApiFault, execute, idempotencyKey, membership, once, principal,
  tenantHeader, type Services } from "./routes.js";

const packs=new Map(["generic","joinery","wet-trade"].map(name=>{
  const pack=parseTradePack(JSON.parse(readFileSync(new URL(
    `../../../trade-packs/${name}/1.0.0.json`,import.meta.url),"utf8")));
  return [name,pack] as const;
}));
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const scopeLine=z.object({id:UuidSchema,display_name:z.string().trim().min(1).max(180),
  quantity_value:z.string().regex(/^-?(0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/),
  unit_code:z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  operation:z.enum(["add","delta","replace","remove"]),
  target_contract_line_id:UuidSchema.nullable(),
  expected_line_version:z.number().int().positive().nullable(),
  cost_line_ids:z.array(UuidSchema).max(100)}).strict();
const approveBody=z.object({id:UuidSchema,expected_quote_version:z.number().int().positive(),
  scope_lines:z.array(scopeLine).min(1).max(100),
  customer_exclusions:z.array(z.string().trim().min(1).max(180)).max(20),
  customer_disclosure_attested:z.literal(true),
  reason:z.string().trim().min(10).max(1000)}).strict();
const acceptBody=z.object({id:UuidSchema,approval_id:UuidSchema,
  expected_quote_version:z.number().int().positive(),
  acceptance_evidence_id:UuidSchema,
  accepted_snapshot_sha256:z.string().regex(/^[0-9a-f]{64}$/),
  manual_agreement_match_attested:z.literal(true),
  new_project_id:UuidSchema.nullable(),new_order_id:UuidSchema.nullable(),
  new_bundle_id:UuidSchema.nullable(),new_order_name:z.string().trim().min(1).max(180).nullable(),
  new_bundle_name:z.string().trim().min(1).max(180).nullable(),
  reason:z.string().trim().min(10).max(1000)}).strict();
const cancelBody=z.object({expected_quote_version:z.number().int().positive(),
  reason:z.string().trim().min(10).max(1000)}).strict();

export async function quoteSnapshot(tx:Tx,tenantId:string,id:string,lock=false) {
  const rows=lock?await tx`select q.*,r.state,r.base_cost_minor,r.supply_minor,
    r.vat_minor,r.total_minor,r.margin_bps,r.vat_mode,r.condition_tags,r.cost_coverage,
    r.basis_sha256,r.id as revision_id,r.version as revision_version
    from app.quotes q join app.quote_revisions r on r.tenant_id=q.tenant_id
      and r.id=q.current_revision_id
    where q.tenant_id=${tenantId}::uuid and q.id=${id}::uuid for update of q`:
    await tx`select q.*,r.state,r.base_cost_minor,r.supply_minor,
      r.vat_minor,r.total_minor,r.margin_bps,r.vat_mode,r.condition_tags,r.cost_coverage,
      r.basis_sha256,r.id as revision_id,r.version as revision_version
      from app.quotes q join app.quote_revisions r on r.tenant_id=q.tenant_id
        and r.id=q.current_revision_id
      where q.tenant_id=${tenantId}::uuid and q.id=${id}::uuid`;
  const row=rows[0];
  if (!row) throw new ApiFault("NOT_FOUND");
  return row;
}
export async function quoteCurrent(tx:Tx,tenantId:string,row:Record<string,unknown>) {
  const [bundle]=await tx`select trade_pack_id,trade_pack_version,trade_pack_hash,work_order_id
    from app.work_bundles where tenant_id=${tenantId}::uuid and id=${String(row.bundle_id)}::uuid`;
  if (!bundle || bundle.trade_pack_hash!==row.trade_pack_hash ||
      bundle.trade_pack_id!==row.trade_pack_id || bundle.trade_pack_version!==row.trade_pack_version)
    return false;
  if (row.target_order_id) {
    const [order]=await tx`select version from app.work_orders
      where tenant_id=${tenantId}::uuid and id=${String(row.target_order_id)}::uuid`;
    if (!order || Number(order.version)!==Number(row.expected_order_version)) return false;
  }
  const [stale]=await tx`select count(*)::integer as count from app.quote_lines l
    left join app.rate_observations r on r.tenant_id=l.tenant_id and r.id=l.source_rate_id
    left join app.document_revisions d on d.tenant_id=r.tenant_id and d.id=r.source_revision_id
    where l.tenant_id=${tenantId}::uuid and l.revision_id=${String(row.revision_id)}::uuid and
      (l.cost_minor is null or r.id is null or r.valid_until <
        (now() at time zone 'Asia/Seoul')::date or
        r.observed_on + 90 < (now() at time zone 'Asia/Seoul')::date or
        r.tax_mode not in ('exclusive','not_applicable') or
        not (r.condition_tags <@ ${tx.array(row.condition_tags as string[],25)}) or
        exists(select 1 from app.document_revisions latest
          where latest.tenant_id=d.tenant_id and latest.document_id=d.document_id
            and latest.revision_number>d.revision_number))`;
  return Number(stale?.count)===0;
}

export function registerQuoteLifecycleRoutes(app:FastifyInstance,services:Services) {
  app.get<{Params:{id:string}}>("/v1/quotes/:id/approved-snapshot",
    async(request,reply)=>execute(reply,async()=>{
      const actor=await principal(request,services),tenantId=tenantHeader(request);
      const quoteId=UuidSchema.safeParse(request.params.id);
      if (!quoteId.success) throw new ApiFault("INVALID_CONTRACT");
      return inAuthorizedTransaction(services.db,actor,async tx=>{
        if (await membership(tx,tenantId,actor.userId)!=="owner")
          throw new ApiFault("NOT_FOUND");
        const quote=await quoteSnapshot(tx,tenantId,quoteId.data);
        if (quote.status!=="approved" && quote.status!=="accepted")
          throw new ApiFault("NOT_FOUND");
        if (quote.status==="approved" && !(await quoteCurrent(tx,tenantId,quote)))
          throw new ApiFault("DOMAIN_INVARIANT");
        const [approval]=await tx`select id,snapshot,snapshot_sha256
          from app.quote_approvals where tenant_id=${tenantId}::uuid
            and quote_id=${quoteId.data}::uuid and revision_id=${String(quote.revision_id)}::uuid`;
        if (!approval) throw new ApiFault("NOT_FOUND");
        return {status:200,body:{approval_id:approval.id,quote_id:quoteId.data,
          snapshot:approval.snapshot,snapshot_sha256:approval.snapshot_sha256,
          pdf_state:"not_rendered",delivery_verified:false}};
      });
    }));
  app.post<{Params:{id:string}}>("/v1/quotes/:id/approve",async(request,reply)=>execute(reply,async()=>{
    const actor=await principal(request,services),tenantId=tenantHeader(request),key=idempotencyKey(request);
    const quoteId=UuidSchema.safeParse(request.params.id),parsed=approveBody.safeParse(request.body);
    if (!quoteId.success || !parsed.success) throw new ApiFault("INVALID_CONTRACT");
    const body=parsed.data,allCostIds=body.scope_lines.flatMap(item=>item.cost_line_ids);
    if (new Set(body.scope_lines.map(item=>item.id)).size!==body.scope_lines.length ||
        new Set(allCostIds).size!==allCostIds.length ||
        new Set(body.scope_lines.filter(item=>item.target_contract_line_id)
          .map(item=>item.target_contract_line_id)).size!==
          body.scope_lines.filter(item=>item.target_contract_line_id).length)
      throw new ApiFault("INVALID_CONTRACT");
    return inAuthorizedTransaction(services.db,actor,async tx=>{
      if (await membership(tx,tenantId,actor.userId)!=="owner") throw new ApiFault("NOT_FOUND");
      return once(tx,tenantId,actor.userId,`POST /v1/quotes/${quoteId.data}/approve`,key,
        hash(body),async()=>{
          const quote=await quoteSnapshot(tx,tenantId,quoteId.data,true);
          if (Number(quote.version)!==body.expected_quote_version)
            throw new ApiFault("VERSION_CONFLICT",Number(quote.version));
          if (quote.status!=="draft" || quote.state!=="draft_ready" ||
              !(await quoteCurrent(tx,tenantId,quote))) throw new ApiFault("DOMAIN_INVARIANT");
          const pack=packs.get(String(quote.trade_pack_id));
          if (!pack || pack.version!==quote.trade_pack_version ||
              pack.contentHash!==quote.trade_pack_hash) throw new ApiFault("DOMAIN_INVARIANT");
          const costs=await tx`select id,cost_minor,source_rate_id from app.quote_lines
            where tenant_id=${tenantId}::uuid and revision_id=${quote.revision_id}::uuid`;
          if (allCostIds.length!==costs.length ||
              costs.some(item=>!allCostIds.includes(String(item.id))))
            throw new ApiFault("DOMAIN_INVARIANT");
          const costById=new Map(costs.map(item=>[String(item.id),BigInt(String(item.cost_minor))]));
          const [targetOrder]=quote.target_order_id?await tx`select id,version from app.work_orders
            where tenant_id=${tenantId}::uuid and id=${quote.target_order_id}::uuid for share`:[];
          const targets=body.scope_lines.filter(item=>item.target_contract_line_id)
            .map(item=>item.target_contract_line_id as string);
          const current=targets.length?await tx`select id,work_order_id,unit_code,quantity_value,
            supply_minor,version,active from app.contract_lines
            where tenant_id=${tenantId}::uuid and id=any(${tx.array(targets,2950)}) for share`:[];
          if (current.length!==targets.length) throw new ApiFault("NOT_FOUND");
          const allocations=allocateScopeSupply(body.scope_lines.map(item=>({id:item.id,
            costMinor:item.cost_line_ids.reduce((sum,id)=>sum+(costById.get(id)??0n),0n).toString()})),
            String(quote.supply_minor));
          const scoped=body.scope_lines.map(item=>{
            if (!pack.quoteTemplate.unitCodes.includes(item.unit_code))
              throw new ApiFault("DOMAIN_INVARIANT");
            const supply=allocations.get(item.id);
            if (supply===undefined) throw new ApiFault("DOMAIN_INVARIANT");
            const target=current.find(line=>line.id===item.target_contract_line_id);
            if (quote.kind!=="amendment" && item.operation!=="add" ||
                (item.operation==="add")!==(item.target_contract_line_id===null &&
                  item.expected_line_version===null) ||
                (target && (target.work_order_id!==targetOrder?.id || !target.active ||
                  target.unit_code!==item.unit_code ||
                  Number(target.version)!==item.expected_line_version)))
              throw new ApiFault("DOMAIN_INVARIANT");
            if (item.operation!=="add" && !target) throw new ApiFault("NOT_FOUND");
            let projection:ReturnType<typeof applyContractOperation>;
            try { projection=applyContractOperation(target?{quantityValue:String(target.quantity_value),
              supplyMinor:String(target.supply_minor)}:null,item.operation,item.quantity_value,supply); }
            catch { throw new ApiFault("DOMAIN_INVARIANT"); }
            if (item.operation==="remove" && item.cost_line_ids.length!==0)
              throw new ApiFault("DOMAIN_INVARIANT");
            return {...item,cost_minor:item.cost_line_ids.reduce((sum,id)=>sum+
              (costById.get(id)??0n),0n).toString(),supply_minor:supply,
              previous_quantity_value:target?String(target.quantity_value):null,
              resulting_quantity_value:projection.quantityValue};
          });
          const evidence=costs.length?await tx`select distinct r.evidence_id from app.quote_lines l
            join app.rate_observations r on r.tenant_id=l.tenant_id and r.id=l.source_rate_id
            where l.tenant_id=${tenantId}::uuid and l.revision_id=${quote.revision_id}::uuid`:[];
          const evidenceIds=evidence.map(item=>String(item.evidence_id));
          const customerSnapshot={quote_id:quoteId.data,revision_id:quote.revision_id,
            kind:quote.kind,trade_pack_id:quote.trade_pack_id,
            vat_mode:quote.vat_mode,supply_minor:String(quote.supply_minor),
            vat_minor:String(quote.vat_minor),total_minor:String(quote.total_minor),
            exclusions:body.customer_exclusions,
            scope_lines:scoped.map(item=>({id:item.id,display_name:item.display_name,
              quantity_value:item.quantity_value,unit_code:item.unit_code,
              operation:item.operation,supply_minor:item.supply_minor,
              previous_quantity_value:item.previous_quantity_value,
              resulting_quantity_value:item.resulting_quantity_value}))};
          const snapshotHash=hash(customerSnapshot);
          const [decision]=await tx`insert into app.decisions
            (tenant_id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash)
            values (${tenantId}::uuid,${actor.userId}::uuid,'quote_approval','approve_quote_scope',
              ${tx.array([quoteId.data],2950)},${tx.array([body.expected_quote_version],20)},
              ${tx.array(evidenceIds,2950)},${body.reason},${snapshotHash}) returning id`;
          await tx`insert into app.quote_approvals
            (tenant_id,id,quote_id,revision_id,decision_id,actor_id,snapshot,snapshot_sha256)
            values (${tenantId}::uuid,${body.id}::uuid,${quoteId.data}::uuid,
              ${quote.revision_id}::uuid,${decision?.id}::uuid,${actor.userId}::uuid,
              ${tx.json(customerSnapshot)},${snapshotHash})`;
          for (const [position,item] of scoped.entries()) await tx`insert into app.quote_scope_lines
            (tenant_id,id,approval_id,position,display_name,quantity_value,unit_code,
              operation,target_contract_line_id,expected_line_version,cost_line_ids,
              cost_minor,supply_minor)
            values (${tenantId}::uuid,${item.id}::uuid,${body.id}::uuid,${position+1},
              ${item.display_name},${item.quantity_value},${item.unit_code},${item.operation},
              ${item.target_contract_line_id}::uuid,${item.expected_line_version},
              ${tx.array(item.cost_line_ids,2950)},${item.cost_minor}::numeric,
              ${item.supply_minor}::numeric)`;
          await tx`update app.quotes set status='approved',version=version+1
            where tenant_id=${tenantId}::uuid and id=${quoteId.data}::uuid`;
          return {status:201,body:{approval_id:body.id,quote_id:quoteId.data,
            quote_version:body.expected_quote_version+1,revision_id:quote.revision_id,
            snapshot_sha256:snapshotHash,customer_snapshot:customerSnapshot,
            pdf_state:"not_rendered",external_share_allowed:false}};
        });
    });
  }));

  app.post<{Params:{id:string}}>("/v1/quotes/:id/accept",async(request,reply)=>execute(reply,async()=>{
    const actor=await principal(request,services),tenantId=tenantHeader(request),key=idempotencyKey(request);
    const quoteId=UuidSchema.safeParse(request.params.id),parsed=acceptBody.safeParse(request.body);
    if (!quoteId.success || !parsed.success) throw new ApiFault("INVALID_CONTRACT");
    const body=parsed.data;
    return inAuthorizedTransaction(services.db,actor,async tx=>{
      if (await membership(tx,tenantId,actor.userId)!=="owner") throw new ApiFault("NOT_FOUND");
      return once(tx,tenantId,actor.userId,`POST /v1/quotes/${quoteId.data}/accept`,key,
        hash(body),async()=>{
          const quote=await quoteSnapshot(tx,tenantId,quoteId.data,true);
          if (Number(quote.version)!==body.expected_quote_version)
            throw new ApiFault("VERSION_CONFLICT",Number(quote.version));
          if (quote.status!=="approved" || !(await quoteCurrent(tx,tenantId,quote)))
            throw new ApiFault("DOMAIN_INVARIANT");
          const [approval]=await tx`select a.id,a.revision_id,a.snapshot_sha256,a.created_at,
            d.evidence_ids
            from app.quote_approvals a join app.decisions d
              on d.tenant_id=a.tenant_id and d.id=a.decision_id
            where a.tenant_id=${tenantId}::uuid and a.id=${body.approval_id}::uuid
              and a.quote_id=${quoteId.data}::uuid and a.revision_id=${quote.revision_id}::uuid`;
          if (!approval) throw new ApiFault("NOT_FOUND");
          if (body.accepted_snapshot_sha256!==approval.snapshot_sha256)
            throw new ApiFault("DOMAIN_INVARIANT");
          const [acceptanceEvidence]=await tx`select e.revision_id,e.locator,b.sha256
            from app.evidence_index e
            join app.document_revisions r on r.tenant_id=e.tenant_id and r.id=e.revision_id
            join app.evidence_blobs b on b.tenant_id=r.tenant_id and b.id=r.blob_id
            where e.tenant_id=${tenantId}::uuid and e.id=${body.acceptance_evidence_id}::uuid
              and e.source_kind='original' and e.category='agreement'
              and e.recorded_at>=${approval.created_at}::timestamptz
              and not exists(select 1 from app.document_revisions newer
                where newer.tenant_id=r.tenant_id and newer.document_id=r.document_id
                  and newer.revision_number>r.revision_number)
              and not exists(select 1 from app.export_batches output
                where output.tenant_id=e.tenant_id and output.output_sha256=b.sha256)`;
          if (!acceptanceEvidence) throw new ApiFault("NOT_FOUND");
          const locator=acceptanceEvidence.locator as {position?:{quote_snapshot_sha256?:unknown}};
          const marked=locator.position?.quote_snapshot_sha256;
          if (marked!==undefined && marked!==approval.snapshot_sha256)
            throw new ApiFault("DOMAIN_INVARIANT");
          const scope=await tx`select * from app.quote_scope_lines
            where tenant_id=${tenantId}::uuid and approval_id=${body.approval_id}::uuid
            order by position`;
          if (!scope.length) throw new ApiFault("DOMAIN_INVARIANT");
          let orderId:string,bundleId:string|null=null;
          if (quote.kind==="new") {
            if (!body.new_project_id || !body.new_order_id || !body.new_bundle_id ||
                !body.new_order_name || !body.new_bundle_name)
              throw new ApiFault("INVALID_CONTRACT");
            const [project]=await tx`select id from app.projects
              where tenant_id=${tenantId}::uuid and id=${body.new_project_id}::uuid`;
            if (!project) throw new ApiFault("NOT_FOUND");
            orderId=body.new_order_id;bundleId=body.new_bundle_id;
            await tx`insert into app.work_orders(tenant_id,id,project_id,display_name)
              values (${tenantId}::uuid,${orderId}::uuid,${body.new_project_id}::uuid,
                ${body.new_order_name})`;
          } else {
            if (body.new_project_id || body.new_order_id || body.new_order_name ||
                (quote.kind==="amendment" && (body.new_bundle_id || body.new_bundle_name)) ||
                (quote.kind==="additional" && (!body.new_bundle_id || !body.new_bundle_name)))
              throw new ApiFault("INVALID_CONTRACT");
            orderId=String(quote.target_order_id);
            await tx`select pg_advisory_xact_lock(hashtextextended(
              ${`${tenantId}:contract-order:${orderId}`},0))`;
            const [order]=await tx`select version from app.work_orders
              where tenant_id=${tenantId}::uuid and id=${orderId}::uuid for update`;
            if (!order || Number(order.version)!==Number(quote.expected_order_version))
              throw new ApiFault("VERSION_CONFLICT",Number(order?.version??0));
            if (quote.kind==="additional") bundleId=body.new_bundle_id;
          }
          if (bundleId) await tx`insert into app.work_bundles
            (tenant_id,id,work_order_id,display_name,trade_pack_id,trade_pack_version,trade_pack_hash)
            values (${tenantId}::uuid,${bundleId}::uuid,${orderId}::uuid,
              ${body.new_bundle_name},${quote.trade_pack_id},${quote.trade_pack_version},
              ${quote.trade_pack_hash})`;
          const [decision]=await tx`insert into app.decisions
            (tenant_id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash)
            values (${tenantId}::uuid,${actor.userId}::uuid,'quote_acceptance','accept_quote_scope',
              ${tx.array([quoteId.data],2950)},${tx.array([body.expected_quote_version],20)},
              ${tx.array([...new Set([...(approval.evidence_ids as string[]),
                body.acceptance_evidence_id])],2950)},${body.reason},
              ${hash({body,approval_snapshot_sha256:approval.snapshot_sha256,
                source_revision_id:acceptanceEvidence.revision_id,
                source_blob_sha256:acceptanceEvidence.sha256})}) returning id`;
          await tx`insert into app.quote_acceptances
            (tenant_id,id,approval_id,quote_id,revision_id,decision_id,
              acceptance_evidence_id,acceptance_source_revision_id,
              acceptance_source_blob_sha256,work_order_id,work_bundle_id)
            values (${tenantId}::uuid,${body.id}::uuid,${body.approval_id}::uuid,
              ${quoteId.data}::uuid,${quote.revision_id}::uuid,${decision?.id}::uuid,
              ${body.acceptance_evidence_id}::uuid,${acceptanceEvidence.revision_id}::uuid,
              ${acceptanceEvidence.sha256},${orderId}::uuid,${bundleId}::uuid)`;
          for (const item of scope) {
            const targetId=item.operation==="add"?String(item.id):String(item.target_contract_line_id);
            const [current]=item.operation==="add"?[]:await tx`select * from app.contract_lines
              where tenant_id=${tenantId}::uuid and id=${targetId}::uuid
                and work_order_id=${orderId}::uuid for update`;
            if (item.operation!=="add" && (!current?.active ||
                Number(current.version)!==Number(item.expected_line_version) ||
                current.unit_code!==item.unit_code)) throw new ApiFault("VERSION_CONFLICT",
                Number(current?.version??0));
            const prior=current?{quantityValue:String(current.quantity_value),
              supplyMinor:String(current.supply_minor)}:null;
            let next:ReturnType<typeof applyContractOperation>;
            try { next=applyContractOperation(prior,item.operation,
              String(item.quantity_value),String(item.supply_minor)); }
            catch { throw new ApiFault("DOMAIN_INVARIANT"); }
            if (prior && isScopeReduction(prior.quantityValue,next.quantityValue)) {
              const [performed]=await tx`select 1 from app.outcomes o
                join app.work_bundles b on b.tenant_id=o.tenant_id and b.id=o.bundle_id
                where o.tenant_id=${tenantId}::uuid and b.work_order_id=${orderId}::uuid
                  and o.scope_completed limit 1`;
              if (performed) throw new ApiFault("DOMAIN_INVARIANT");
            }
            if (item.operation==="add") await tx`insert into app.contract_lines
              (tenant_id,id,work_order_id,work_bundle_id,display_name,unit_code,
                quantity_value,supply_minor)
              values (${tenantId}::uuid,${targetId}::uuid,${orderId}::uuid,
                ${bundleId??String(quote.bundle_id)}::uuid,
                ${item.display_name},${item.unit_code},${next.quantityValue},
                ${next.supplyMinor}::numeric)`;
            else await tx`update app.contract_lines set quantity_value=${next.quantityValue},
              supply_minor=${next.supplyMinor}::numeric,version=version+1,
              active=${item.operation!=="remove"}
              where tenant_id=${tenantId}::uuid and id=${targetId}::uuid`;
            await tx`insert into app.contract_line_revisions
              (tenant_id,id,contract_line_id,version,acceptance_id,operation,
                previous_quantity_value,previous_supply_minor,quantity_value,supply_minor)
              values (${tenantId}::uuid,${randomUUID()}::uuid,${targetId}::uuid,
                ${current?Number(current.version)+1:1},${body.id}::uuid,${item.operation},
                ${prior?.quantityValue??null},${prior?.supplyMinor??null}::numeric,
                ${next.quantityValue},${next.supplyMinor}::numeric)`;
          }
          if (quote.kind!=="new") await tx`update app.work_orders set version=version+1,
            updated_at=now() where tenant_id=${tenantId}::uuid and id=${orderId}::uuid`;
          if (quote.kind==="amendment") {
            const [billed]=await tx`select coalesce(sum(l.supply_minor),0) as amount,
              count(*) filter (where l.supply_minor is null)::integer as unknown
              from app.invoices i join app.invoice_lines l
                on l.tenant_id=i.tenant_id and l.invoice_id=i.id
              join app.work_bundles b on b.tenant_id=i.tenant_id and b.id=i.bundle_id
              where i.tenant_id=${tenantId}::uuid and b.work_order_id=${orderId}::uuid
                and i.direction='receivable' and i.status='approved'`;
            const [contract]=await tx`select coalesce(sum(supply_minor),0) as amount
              from app.contract_lines where tenant_id=${tenantId}::uuid
                and work_order_id=${orderId}::uuid and active`;
            if (Number(billed?.unknown)>0 ||
                BigInt(String(billed?.amount??0))>BigInt(String(contract?.amount??0)))
              throw new ApiFault("DOMAIN_INVARIANT");
          }
          await tx`update app.quotes set status='accepted',version=version+1
            where tenant_id=${tenantId}::uuid and id=${quoteId.data}::uuid`;
          return {status:201,body:{acceptance_id:body.id,quote_id:quoteId.data,
            quote_version:body.expected_quote_version+1,work_order_id:orderId,
            work_bundle_id:bundleId,contract_line_effects:scope.length,
            historical_results_preserved:true}};
        });
    });
  }));

  app.post<{Params:{id:string}}>("/v1/quotes/:id/cancel",async(request,reply)=>execute(reply,async()=>{
    const actor=await principal(request,services),tenantId=tenantHeader(request),key=idempotencyKey(request);
    const quoteId=UuidSchema.safeParse(request.params.id),parsed=cancelBody.safeParse(request.body);
    if (!quoteId.success || !parsed.success) throw new ApiFault("INVALID_CONTRACT");
    const body=parsed.data;
    return inAuthorizedTransaction(services.db,actor,async tx=>{
      if (await membership(tx,tenantId,actor.userId)!=="owner") throw new ApiFault("NOT_FOUND");
      return once(tx,tenantId,actor.userId,`POST /v1/quotes/${quoteId.data}/cancel`,key,
        hash(body),async()=>{
          const quote=await quoteSnapshot(tx,tenantId,quoteId.data,true);
          if (Number(quote.version)!==body.expected_quote_version)
            throw new ApiFault("VERSION_CONFLICT",Number(quote.version));
          if (quote.status==="accepted") throw new ApiFault("DOMAIN_INVARIANT");
          await tx`insert into app.decisions
            (tenant_id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash)
            values (${tenantId}::uuid,${actor.userId}::uuid,'quote_cancel','cancel_quote',
              ${tx.array([quoteId.data],2950)},${tx.array([body.expected_quote_version],20)},
              ${tx.array([],2950)},${body.reason},${hash(body)})`;
          await tx`update app.quotes set status='cancelled',version=version+1
            where tenant_id=${tenantId}::uuid and id=${quoteId.data}::uuid`;
          return {status:200,body:{id:quoteId.data,status:"cancelled",
            version:body.expected_quote_version+1}};
        });
    });
  }));
}
