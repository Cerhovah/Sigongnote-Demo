import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { UuidSchema } from "@sigongnote/contracts";
import { calculateQuote, parseTradePack } from "@sigongnote/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { inAuthorizedTransaction } from "./auth.js";
import { ApiFault, execute, idempotencyKey, membership, once, principal,
  tenantHeader, type Services } from "./routes.js";

const packs=new Map(["generic","joinery","wet-trade"].map(name=>{
  const pack=parseTradePack(JSON.parse(readFileSync(new URL(
    `../../../trade-packs/${name}/1.0.0.json`,import.meta.url),"utf8")));
  return [name,pack] as const;
}));
const code=z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const quantity=z.string().regex(/^(0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/)
  .refine(value=>Number(value)>0);
const coverage=z.object({category:code,state:z.enum(["included","excluded","unknown"]),
  reason:z.string().trim().min(3).max(300).nullable()}).strict();
const line=z.object({id:UuidSchema,category:code,quantity_value:quantity,unit_code:code,
  source_rate_id:UuidSchema.nullable()}).strict();
const bodySchema=z.object({id:UuidSchema,revision_id:UuidSchema,bundle_id:UuidSchema,
  kind:z.enum(["new","additional","amendment"]),target_order_id:UuidSchema.nullable(),
  expected_order_version:z.number().int().positive().nullable(),
  margin_bps:z.number().int().min(0).max(9999),
  vat_mode:z.enum(["exclusive","inclusive","not_applicable","unknown"]),
  condition_tags:z.array(z.string().trim().min(1).max(80)).max(12),
  cost_coverage:z.array(coverage).min(1).max(20),
  lines:z.array(line).min(1).max(100)}).strict();
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const today=()=>new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Seoul",
  year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());

export function registerQuoteRoutes(app:FastifyInstance,services:Services) {
  app.post("/v1/quotes",async(request,reply)=>execute(reply,async()=>{
    const actor=await principal(request,services),tenantId=tenantHeader(request),key=idempotencyKey(request);
    const parsed=bodySchema.safeParse(request.body);
    if (!parsed.success) throw new ApiFault("INVALID_CONTRACT");
    const body=parsed.data;
    if (new Set(body.condition_tags).size!==body.condition_tags.length ||
        new Set(body.cost_coverage.map(item=>item.category)).size!==body.cost_coverage.length ||
        new Set(body.lines.map(item=>item.id)).size!==body.lines.length ||
        (body.target_order_id===null)!==(body.expected_order_version===null) ||
        (body.kind==="new")!==(body.target_order_id===null && body.expected_order_version===null))
      throw new ApiFault("INVALID_CONTRACT");
    return inAuthorizedTransaction(services.db,actor,async tx=>{
      if (await membership(tx,tenantId,actor.userId)!=="owner") throw new ApiFault("NOT_FOUND");
      return once(tx,tenantId,actor.userId,"POST /v1/quotes",key,hash(body),async()=>{
        const [bundle]=await tx`select trade_pack_id,trade_pack_version,trade_pack_hash,work_order_id
          from app.work_bundles where tenant_id=${tenantId}::uuid and id=${body.bundle_id}::uuid`;
        const pack=packs.get(String(bundle?.trade_pack_id));
        if (!bundle || !pack || bundle.trade_pack_version!==pack.version ||
            bundle.trade_pack_hash!==pack.contentHash) throw new ApiFault("DOMAIN_INVARIANT");
        if (body.kind!=="new") {
          const [order]=await tx`select version from app.work_orders
            where tenant_id=${tenantId}::uuid and id=${body.target_order_id}::uuid for share`;
          if (!order || bundle.work_order_id!==body.target_order_id) throw new ApiFault("NOT_FOUND");
          if (Number(order.version)!==body.expected_order_version)
            throw new ApiFault("VERSION_CONFLICT",Number(order.version));
        }
        const expected=[...pack.costCategories,"owner_labor","allocated_overhead"];
        if (new Set(expected).size!==expected.length || body.cost_coverage.length!==expected.length ||
            expected.some(category=>!body.cost_coverage.some(item=>item.category===category)) ||
            body.cost_coverage.some(item=>item.state==="excluded"?!item.reason:
              item.reason!==null)) throw new ApiFault("INVALID_CONTRACT");
        for (const item of body.cost_coverage) {
          if (item.state==="included" && !body.lines.some(entry=>entry.category===item.category))
            throw new ApiFault("DOMAIN_INVARIANT");
          if (item.state!=="included" && body.lines.some(entry=>entry.category===item.category))
            throw new ApiFault("DOMAIN_INVARIANT");
        }
        if (body.lines.some(entry=>!expected.includes(entry.category) ||
            !pack.quoteTemplate.unitCodes.includes(entry.unit_code)))
          throw new ApiFault("DOMAIN_INVARIANT");
        const sourceIds=[...new Set(body.lines.map(entry=>entry.source_rate_id)
          .filter((id):id is string=>id!==null))];
        const rates=sourceIds.length?await tx`select r.id,r.category,r.unit_code,r.rate_minor,r.tax_mode,
          r.observed_on::text as observed_on,r.valid_until::text as valid_until,
          r.condition_tags,r.evidence_id,r.source_revision_id,r.source_blob_sha256,
          d.document_id,r.trade_pack_id,r.trade_pack_version,
          (select max(next.revision_number) from app.document_revisions next
            where next.tenant_id=d.tenant_id and next.document_id=d.document_id) as latest_revision_number,
          d.revision_number as source_revision_number
          from app.rate_observations r join app.document_revisions d
            on d.tenant_id=r.tenant_id and d.id=r.source_revision_id
          where r.tenant_id=${tenantId}::uuid and r.id=any(${tx.array(sourceIds,2950)})`:[];
        if (rates.length!==sourceIds.length) throw new ApiFault("NOT_FOUND");
        const now=today();
        const computed=body.lines.map(entry=>{
          const rate=rates.find(item=>item.id===entry.source_rate_id);
          if (rate && (rate.category!==entry.category || rate.unit_code!==entry.unit_code ||
              rate.trade_pack_id!==pack.packId || rate.trade_pack_version!==pack.version))
            throw new ApiFault("DOMAIN_INVARIANT");
          const observed=rate?String(rate.observed_on):"";
          const age=rate?Math.floor((Date.parse(`${now}T00:00:00Z`)-
            Date.parse(`${observed}T00:00:00Z`))/86_400_000):0;
          const fresh=Boolean(rate && observed<=now && age<=90 && now<=String(rate.valid_until) &&
            ["exclusive","not_applicable"].includes(String(rate.tax_mode)) &&
            Number(rate.latest_revision_number)===Number(rate.source_revision_number) &&
            (rate.condition_tags as string[]).every(tag=>body.condition_tags.includes(tag)));
          return {category:entry.category,quantity:entry.quantity_value,unitCode:entry.unit_code,
            rateMinor:rate?String(rate.rate_minor):null,included:true,exclusionReason:null,
            rateFresh:fresh,sourceRateId:entry.source_rate_id};
        });
        let result:ReturnType<typeof calculateQuote>;
        try { result=calculateQuote(computed,body.margin_bps,body.vat_mode); }
        catch { throw new ApiFault("INVALID_CONTRACT"); }
        const missing=[...result.missing,...body.cost_coverage.filter(item=>item.state==="unknown")
          .map(item=>`${item.category}_unknown`)];
        const ready=result.state==="draft_ready" && missing.length===0;
        const basis=hash({bundle_id:body.bundle_id,pack_hash:pack.contentHash,
          rates:rates.map(item=>[item.id,String(item.rate_minor),item.source_revision_id,
            item.source_blob_sha256]),conditions:body.condition_tags,coverage:body.cost_coverage});
        await tx`insert into app.quotes
          (tenant_id,id,actor_id,bundle_id,trade_pack_id,trade_pack_version,trade_pack_hash,
            kind,target_order_id,expected_order_version)
          values (${tenantId}::uuid,${body.id}::uuid,${actor.userId}::uuid,${body.bundle_id}::uuid,
            ${pack.packId},${pack.version},${pack.contentHash},${body.kind},
            ${body.target_order_id}::uuid,${body.expected_order_version})`;
        await tx`insert into app.quote_revisions
          (tenant_id,id,quote_id,version,actor_id,state,margin_bps,vat_mode,
            condition_tags,cost_coverage,missing,basis_sha256,
            base_cost_minor,supply_minor,vat_minor,total_minor)
          values (${tenantId}::uuid,${body.revision_id}::uuid,${body.id}::uuid,1,
            ${actor.userId}::uuid,${ready?"draft_ready":"needs_inputs"},
            ${body.margin_bps},${body.vat_mode},${tx.array(body.condition_tags,25)},
            ${tx.json(body.cost_coverage)},${tx.json(missing)},${basis},
            ${ready?result.baseCostMinor:null}::numeric,
            ${ready?result.supplyMinor:null}::numeric,
            ${ready?result.vatMinor:null}::numeric,
            ${ready?result.totalMinor:null}::numeric)`;
        for (const [index,entry] of body.lines.entries()) {
          const rate=rates.find(item=>item.id===entry.source_rate_id);
          await tx`insert into app.quote_lines
            (tenant_id,id,revision_id,position,category,quantity_value,unit_code,included,
              source_rate_id,source_revision_id,source_blob_sha256,rate_minor,cost_minor)
            values (${tenantId}::uuid,${entry.id}::uuid,${body.revision_id}::uuid,${index+1},
              ${entry.category},${entry.quantity_value},${entry.unit_code},true,
              ${entry.source_rate_id}::uuid,${rate?.source_revision_id??null}::uuid,
              ${rate?.source_blob_sha256??null},${rate?String(rate.rate_minor):null}::numeric,
              ${result.lines[index]?.costMinor??null}::numeric)`;
        }
        await tx`update app.quotes set current_revision_id=${body.revision_id}::uuid
          where tenant_id=${tenantId}::uuid and id=${body.id}::uuid`;
        return {status:201,body:{id:body.id,revision_id:body.revision_id,version:1,
          state:ready?"draft_ready":"needs_inputs",missing,base_cost_minor:ready?result.baseCostMinor:null,
          supply_minor:ready?result.supplyMinor:null,vat_minor:ready?result.vatMinor:null,
          total_minor:ready?result.totalMinor:null,basis_sha256:basis,external_share_allowed:false}};
      });
    });
  }));
  app.get<{Params:{id:string}}>("/v1/quotes/:id",async(request,reply)=>execute(reply,async()=>{
    const actor=await principal(request,services),tenantId=tenantHeader(request);
    const parsed=UuidSchema.safeParse(request.params.id);
    if (!parsed.success) throw new ApiFault("INVALID_CONTRACT");
    return inAuthorizedTransaction(services.db,actor,async tx=>{
      if (await membership(tx,tenantId,actor.userId)!=="owner") throw new ApiFault("NOT_FOUND");
      const [row]=await tx`select q.id,q.bundle_id,q.kind,q.status,q.version,q.target_order_id,
        q.expected_order_version,q.trade_pack_hash,r.id as revision_id,r.state,
        r.margin_bps,r.vat_mode,r.condition_tags,r.cost_coverage,r.missing,r.basis_sha256,
        r.base_cost_minor,r.supply_minor,r.vat_minor,r.total_minor
        from app.quotes q join app.quote_revisions r on r.tenant_id=q.tenant_id
          and r.id=q.current_revision_id
        where q.tenant_id=${tenantId}::uuid and q.id=${parsed.data}::uuid`;
      if (!row) throw new ApiFault("NOT_FOUND");
      const lines=await tx`select id,position,category,quantity_value,unit_code,included,
        exclusion_reason,source_rate_id,source_revision_id,source_blob_sha256,
        rate_minor,cost_minor from app.quote_lines
        where tenant_id=${tenantId}::uuid and revision_id=${row.revision_id}::uuid order by position`;
      const staleRates=await tx`select r.id from app.quote_lines l
        join app.rate_observations r on r.tenant_id=l.tenant_id and r.id=l.source_rate_id
        join app.document_revisions d on d.tenant_id=r.tenant_id and d.id=r.source_revision_id
        where l.tenant_id=${tenantId}::uuid and l.revision_id=${row.revision_id}::uuid
          and (r.valid_until < (now() at time zone 'Asia/Seoul')::date or
            r.observed_on + 90 < (now() at time zone 'Asia/Seoul')::date or
            exists(select 1 from app.document_revisions latest
              where latest.tenant_id=d.tenant_id and latest.document_id=d.document_id
                and latest.revision_number>d.revision_number))`;
      const [order]=row.target_order_id?await tx`select version from app.work_orders
        where tenant_id=${tenantId}::uuid and id=${row.target_order_id}::uuid`:[];
      const [bundle]=await tx`select trade_pack_hash from app.work_bundles
        where tenant_id=${tenantId}::uuid and id=${row.bundle_id}::uuid`;
      const stale=staleRates.length>0 || bundle?.trade_pack_hash!==row.trade_pack_hash ||
        Boolean(row.target_order_id &&
        Number(order?.version)!==Number(row.expected_order_version));
      return {status:200,body:{...row,version:Number(row.version),stale,
        base_cost_minor:row.base_cost_minor===null?null:String(row.base_cost_minor),
        supply_minor:row.supply_minor===null?null:String(row.supply_minor),
        vat_minor:row.vat_minor===null?null:String(row.vat_minor),
        total_minor:row.total_minor===null?null:String(row.total_minor),
        lines:lines.map(item=>({...item,rate_minor:item.rate_minor===null?null:String(item.rate_minor),
          cost_minor:item.cost_minor===null?null:String(item.cost_minor)})),
        external_share_allowed:false}};
    });
  }));
}
