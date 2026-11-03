import {reusableOutcome} from "@sigongnote/domain";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { UuidSchema } from "@sigongnote/contracts";
import { parseTradePack } from "@sigongnote/domain";
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
const quantity=z.string().regex(/^[1-9][0-9]{0,11}(?:\.[0-9]{1,6})?$/);
const tags=z.array(z.string().trim().min(1).max(80)).max(12);
const outcomeBody=z.object({id:UuidSchema,bundle_id:UuidSchema,expected_outcome_version:z.number().int().min(0),
  scope_completed:z.boolean(),quantity_value:quantity,unit_code:z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  owner_labor_included:z.boolean().nullable(),revisit_count:z.number().int().min(0).max(999),
  transport_count:z.number().int().min(0).max(999),defect_count:z.number().int().min(0).max(999),
  condition_tags:tags,evidence_ids:z.array(UuidSchema).min(1).max(20),
  reason:z.string().trim().min(10).max(1000)}).strict();
const rateBody=z.object({id:UuidSchema,trade_pack_id:z.enum(["generic","joinery","wet-trade"]),
  trade_pack_version:z.literal("1.0.0"),category:z.enum(["material","labor","transport","equipment","revisit","other",
    "defect","waste","owner_labor","allocated_overhead"]),
  unit_code:z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  rate_minor:z.string().regex(/^(0|[1-9][0-9]{0,14})$/),
  observed_on:z.iso.date(),valid_until:z.iso.date(),delivery_included:z.boolean().nullable(),
  processing_included:z.boolean().nullable(),condition_tags:tags,evidence_id:UuidSchema,
  tax_mode:z.enum(["unknown","exclusive","inclusive","not_applicable"]),
  external_origin_attested:z.literal(true),
  reason:z.string().trim().min(10).max(1000)}).strict();
function hash(value:unknown) {return createHash("sha256").update(JSON.stringify(value)).digest("hex");}
function koreaToday() {return new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Seoul",
  year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());}

export async function currentSource(tx:Tx,tenantId:string,bundleId:string) {
  const local=await tx`select c.id,c.status,c.category,c.version,c.current_revision_id,
    r.confirmed_actual_minor,r.tax_mode,
    exists(select 1 from app.charge_allocation_batches a
      where a.tenant_id=c.tenant_id and a.charge_case_id=c.id) as has_prior_allocation
    from app.charge_cases c
    left join app.charge_revisions r on r.tenant_id=c.tenant_id and r.id=c.current_revision_id
    where c.tenant_id=${tenantId}::uuid and c.bundle_id=${bundleId}::uuid
    order by c.id for share of c`;
  const costRows=await tx`select v.charge_case_id,v.allocated_minor,v.allocation_state,
    c.current_revision_id,cr.tax_mode as cost_tax_mode,cr.evidence_ids as cost_evidence_ids,b.id as allocation_batch_id,b.charge_version
    from app.current_bundle_costs v
    join app.charge_cases c on c.tenant_id=v.tenant_id and c.id=v.charge_case_id
    join app.charge_revisions cr on cr.tenant_id=c.tenant_id and cr.id=c.current_revision_id
    left join app.charge_allocation_batches b on b.tenant_id=c.tenant_id
      and b.charge_case_id=c.id and b.charge_version=c.version
      and v.allocation_state='allocated'
    where v.tenant_id=${tenantId}::uuid and v.bundle_id=${bundleId}::uuid
    order by v.charge_case_id,v.allocation_state`;
  const fingerprint=hash({local:local.map(row=>[row.id,row.status,String(row.version),
    row.current_revision_id,String(row.confirmed_actual_minor),row.has_prior_allocation]),
    costs:costRows.map(row=>[row.charge_case_id,String(row.allocated_minor),
      row.allocation_state,row.allocation_batch_id,String(row.charge_version)])});
  return {local,costRows,fingerprint};
}

export function registerOutcomeRoutes(app:FastifyInstance,services:Services) {
  app.post("/v1/outcomes",async(request,reply)=>execute(reply,async()=>{
    const actor=await principal(request,services),tenantId=tenantHeader(request),key=idempotencyKey(request);
    const parsed=outcomeBody.safeParse(request.body);
    if (!parsed.success || new Set(parsed.data.evidence_ids).size!==parsed.data.evidence_ids.length ||
        new Set(parsed.data.condition_tags).size!==parsed.data.condition_tags.length)
      throw new ApiFault("INVALID_CONTRACT");
    const body=parsed.data;
    return inAuthorizedTransaction(services.db,actor,async tx=>{
      if (await membership(tx,tenantId,actor.userId)!=="owner") throw new ApiFault("NOT_FOUND");
      return once(tx,tenantId,actor.userId,"POST /v1/outcomes",key,hash(body),async()=>{
        await tx`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:outcome:${body.bundle_id}`},0))`;
        const [bundle]=await tx`select trade_pack_id,trade_pack_version,trade_pack_hash
          from app.work_bundles where tenant_id=${tenantId}::uuid and id=${body.bundle_id}::uuid`;
        const pack=packs.get(String(bundle?.trade_pack_id));
        if (!bundle || !pack || bundle.trade_pack_version!==pack.version ||
            bundle.trade_pack_hash!==pack.contentHash ||
            !pack.units.some(unit=>unit.code===body.unit_code)) throw new ApiFault("DOMAIN_INVARIANT");
        const [latest]=await tx`select id,version from app.outcomes
          where tenant_id=${tenantId}::uuid and bundle_id=${body.bundle_id}::uuid
          order by version desc limit 1`;
        if (Number(latest?.version??0)!==body.expected_outcome_version)
          throw new ApiFault("VERSION_CONFLICT",Number(latest?.version??0));
        const evidence=await tx`select e.id from app.evidence_index e
          join app.evidence_attributions a on a.tenant_id=e.tenant_id and a.evidence_index_id=e.id
          where e.tenant_id=${tenantId}::uuid and e.id=any(${tx.array(body.evidence_ids,2950)})
            and e.source_kind='original' and a.state='confirmed'
            and a.bundle_id=${body.bundle_id}::uuid`;
        if (evidence.length!==body.evidence_ids.length) throw new ApiFault("DOMAIN_INVARIANT");
        const {local,costRows,fingerprint}=await currentSource(tx,tenantId,body.bundle_id);
        const unknown=local.filter(row=>!["confirmed","adjusted"].includes(row.status) ||
          row.confirmed_actual_minor===null || ((row.category==="overhead" || row.has_prior_allocation) &&
            !costRows.some(cost=>cost.charge_case_id===row.id))).length+(local.length===0?1:0);
        const cost=costRows.length && unknown===0?costRows.reduce((sum,row)=>
          sum+BigInt(String(row.allocated_minor)),0n).toString():null;
        const revisions=[...new Set(costRows.map(row=>String(row.current_revision_id)))];
        const allocationBatches=[...new Set(costRows.map(row=>row.allocation_batch_id)
          .filter((value):value is string=>typeof value==="string"))];
        // No settlement-close claim until payable/receivable links are independently verified.
        const settlementState="unknown";
        const eligible=reusableOutcome({quantity:body.quantity_value,actualCost:cost,unknownCosts:unknown,completed:body.scope_completed,ownerLabor:body.owner_labor_included,observedOn:koreaToday(),asOf:koreaToday(),conditions:body.condition_tags,targetConditions:body.condition_tags,current:true});
        const [decision]=await tx`insert into app.decisions
          (tenant_id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash)
          values (${tenantId}::uuid,${actor.userId}::uuid,'outcome_record','record_observed_result',
            ${tx.array([body.bundle_id],2950)},${tx.array([body.expected_outcome_version],20)},
            ${tx.array(body.evidence_ids,2950)},${body.reason},${hash(body)}) returning id`;
        if (!decision) throw new ApiFault("TEMPORARILY_UNAVAILABLE");
        await tx`insert into app.outcomes
          (tenant_id,id,bundle_id,version,supersedes_id,decision_id,source_charge_revision_ids,
            source_allocation_batch_ids,source_state_sha256,
            actual_cost_minor,unknown_cost_cases,settlement_state,scope_completed,
            quantity_value,unit_code,owner_labor_included,revisit_count,transport_count,
            defect_count,condition_tags,learning_eligible)
          values (${tenantId}::uuid,${body.id}::uuid,${body.bundle_id}::uuid,
            ${body.expected_outcome_version+1},${latest?.id??null}::uuid,${decision.id}::uuid,
            ${tx.array(revisions,2950)},${tx.array(allocationBatches,2950)},${fingerprint},
            ${cost}::numeric,${unknown},${settlementState},
            ${body.scope_completed},${body.quantity_value},${body.unit_code},
            ${body.owner_labor_included},${body.revisit_count},${body.transport_count},
            ${body.defect_count},${tx.array(body.condition_tags,25)},${eligible})`;
        return {status:201,body:{id:body.id,bundle_id:body.bundle_id,
          version:body.expected_outcome_version+1,actual_cost_minor:cost,
          unknown_cost_cases:unknown,settlement_state:settlementState,
          learning_eligible:eligible,source_charge_revision_ids:revisions}};
      });
    });
  }));
  app.get<{Params:{id:string}}>("/v1/outcomes/:id",async(request,reply)=>execute(reply,async()=>{
    const actor=await principal(request,services),tenantId=tenantHeader(request);
    const id=UuidSchema.safeParse(request.params.id);
    if (!id.success) throw new ApiFault("INVALID_CONTRACT");
    return inAuthorizedTransaction(services.db,actor,async tx=>{
      if (await membership(tx,tenantId,actor.userId)!=="owner") throw new ApiFault("NOT_FOUND");
      const [row]=await tx`select id,bundle_id,version,actual_cost_minor,unknown_cost_cases,
        settlement_state,learning_eligible,quantity_value,scope_completed,owner_labor_included,condition_tags,created_at,source_charge_revision_ids,
        source_allocation_batch_ids,source_state_sha256 from app.outcomes
        where tenant_id=${tenantId}::uuid and id=${id.data}::uuid`;
      if (!row) throw new ApiFault("NOT_FOUND");
      const current=await currentSource(tx,tenantId,String(row.bundle_id));
      const stale=current.fingerprint!==row.source_state_sha256;
      return {status:200,body:{id:row.id,bundle_id:row.bundle_id,version:Number(row.version),
        actual_cost_minor:row.actual_cost_minor===null?null:String(row.actual_cost_minor),
        unknown_cost_cases:Number(row.unknown_cost_cases),settlement_state:row.settlement_state,
        learning_eligible:reusableOutcome({quantity:String(row.quantity_value),actualCost:row.actual_cost_minor===null?null:String(row.actual_cost_minor),unknownCosts:Number(row.unknown_cost_cases),completed:row.scope_completed,ownerLabor:row.owner_labor_included,observedOn:new Date(row.created_at).toISOString().slice(0,10),asOf:koreaToday(),conditions:row.condition_tags,targetConditions:row.condition_tags,current:!stale}),stale,
        source_charge_revision_ids:row.source_charge_revision_ids,
        source_allocation_batch_ids:row.source_allocation_batch_ids}};
    });
  }));
  app.post("/v1/rate-observations",async(request,reply)=>execute(reply,async()=>{
    const actor=await principal(request,services),tenantId=tenantHeader(request),key=idempotencyKey(request);
    const parsed=rateBody.safeParse(request.body);
    if (!parsed.success || new Set(parsed.data.condition_tags).size!==parsed.data.condition_tags.length)
      throw new ApiFault("INVALID_CONTRACT");
    const body=parsed.data,pack=packs.get(body.trade_pack_id);
    if (!pack || pack.version!==body.trade_pack_version ||
        ![...pack.costCategories,"owner_labor","allocated_overhead"].includes(body.category) ||
        !pack.units.some(unit=>unit.code===body.unit_code) ||
        body.valid_until<body.observed_on || body.observed_on>koreaToday())
      throw new ApiFault("DOMAIN_INVARIANT");
    return inAuthorizedTransaction(services.db,actor,async tx=>{
      if (await membership(tx,tenantId,actor.userId)!=="owner") throw new ApiFault("NOT_FOUND");
      return once(tx,tenantId,actor.userId,"POST /v1/rate-observations",key,hash(body),async()=>{
        const [evidence]=await tx`select e.id,e.revision_id,b.sha256 from app.evidence_index e
          join app.document_revisions r on r.tenant_id=e.tenant_id and r.id=e.revision_id
          join app.evidence_blobs b on b.tenant_id=r.tenant_id and b.id=r.blob_id
          where e.tenant_id=${tenantId}::uuid and e.id=${body.evidence_id}::uuid
            and e.source_kind='original' and e.category in ('agreement','drawing_material')
            and not exists (select 1 from app.export_batches output
              where output.tenant_id=e.tenant_id and output.output_sha256=b.sha256)`;
        if (!evidence) throw new ApiFault("NOT_FOUND");
        const [decision]=await tx`insert into app.decisions
          (tenant_id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash)
          values (${tenantId}::uuid,${actor.userId}::uuid,'rate_observation','confirm_source_rate',
            ${tx.array([body.id],2950)},${tx.array([1],20)},
            ${tx.array([body.evidence_id],2950)},${body.reason},${hash(body)}) returning id`;
        if (!decision) throw new ApiFault("TEMPORARILY_UNAVAILABLE");
        await tx`insert into app.rate_observations
          (tenant_id,id,actor_id,decision_id,evidence_id,source_revision_id,source_blob_sha256,
            trade_pack_id,trade_pack_version,category,unit_code,rate_minor,tax_mode,
            external_origin_attested,observed_on,valid_until,delivery_included,
            processing_included,condition_tags)
          values (${tenantId}::uuid,${body.id}::uuid,${actor.userId}::uuid,${decision.id}::uuid,
            ${body.evidence_id}::uuid,${evidence.revision_id}::uuid,${evidence.sha256},
            ${body.trade_pack_id},${body.trade_pack_version},
            ${body.category},${body.unit_code},${body.rate_minor}::numeric,${body.tax_mode},
            ${body.external_origin_attested},
            ${body.observed_on}::date,${body.valid_until}::date,${body.delivery_included},
            ${body.processing_included},${tx.array(body.condition_tags,25)})`;
        return {status:201,body:{id:body.id,rate_minor:body.rate_minor,
          observed_on:body.observed_on,valid_until:body.valid_until,
          freshness_limit_days:90,source_evidence_id:body.evidence_id}};
      });
    });
  }));
}
