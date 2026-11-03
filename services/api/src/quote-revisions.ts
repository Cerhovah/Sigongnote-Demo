import { createHash, randomUUID } from "node:crypto";
import { UuidSchema } from "@sigongnote/contracts";
import { calculateQuote } from "@sigongnote/domain";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import { inAuthorizedTransaction } from "./auth.js";
import { quoteCurrent,quoteSnapshot } from "./quote-lifecycle.js";
import { ApiFault,execute,idempotencyKey,membership,once,principal,
  tenantHeader,type Services } from "./routes.js";

const reviseBody=z.object({id:UuidSchema,expected_quote_version:z.number().int().positive(),
  margin_bps:z.number().int().min(0).max(9999),
  reason:z.string().trim().min(10).max(1000)}).strict();
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function registerQuoteRevisionRoutes(app:FastifyInstance,services:Services) {
  app.post<{Params:{id:string}}>("/v1/quotes/:id/revise",async(request,reply)=>execute(reply,async()=>{
    const actor=await principal(request,services),tenantId=tenantHeader(request),key=idempotencyKey(request);
    const parsedId=UuidSchema.safeParse(request.params.id),parsed=reviseBody.safeParse(request.body);
    if (!parsedId.success || !parsed.success) throw new ApiFault("INVALID_CONTRACT");
    const body=parsed.data;
    return inAuthorizedTransaction(services.db,actor,async tx=>{
      if (await membership(tx,tenantId,actor.userId)!=="owner") throw new ApiFault("NOT_FOUND");
      return once(tx,tenantId,actor.userId,`POST /v1/quotes/${parsedId.data}/revise`,key,
        hash(body),async()=>{
          const quote=await quoteSnapshot(tx,tenantId,parsedId.data,true);
          if (Number(quote.version)!==body.expected_quote_version)
            throw new ApiFault("VERSION_CONFLICT",Number(quote.version));
          if (quote.status==="accepted" || quote.status==="cancelled" ||
              quote.state!=="draft_ready" || !(await quoteCurrent(tx,tenantId,quote)))
            throw new ApiFault("DOMAIN_INVARIANT");
          const lines=await tx`select id,position,category,quantity_value,unit_code,
            source_rate_id,source_revision_id,source_blob_sha256,rate_minor
            from app.quote_lines where tenant_id=${tenantId}::uuid
              and revision_id=${String(quote.revision_id)}::uuid order by position`;
          if (!lines.length || lines.some(item=>item.source_rate_id===null ||
              item.rate_minor===null)) throw new ApiFault("DOMAIN_INVARIANT");
          let result:ReturnType<typeof calculateQuote>;
          try { result=calculateQuote(lines.map(item=>({category:String(item.category),
            quantity:String(item.quantity_value),unitCode:String(item.unit_code),
            rateMinor:String(item.rate_minor),included:true,exclusionReason:null,
            rateFresh:true,sourceRateId:String(item.source_rate_id)})),
            body.margin_bps,quote.vat_mode as "exclusive"|"inclusive"|"not_applicable"|"unknown"); }
          catch { throw new ApiFault("DOMAIN_INVARIANT"); }
          if (result.state!=="draft_ready") throw new ApiFault("DOMAIN_INVARIANT");
          const revisionVersion=Number(quote.revision_version)+1;
          await tx`insert into app.quote_revisions
            (tenant_id,id,quote_id,version,supersedes_id,actor_id,state,margin_bps,vat_mode,
              condition_tags,cost_coverage,missing,basis_sha256,
              base_cost_minor,supply_minor,vat_minor,total_minor,revision_reason)
            values (${tenantId}::uuid,${body.id}::uuid,${parsedId.data}::uuid,
              ${revisionVersion},${String(quote.revision_id)}::uuid,${actor.userId}::uuid,
              'draft_ready',${body.margin_bps},${quote.vat_mode},
              ${tx.array(quote.condition_tags as string[],25)},
              ${tx.json(quote.cost_coverage as postgres.JSONValue)},${tx.json([])},
              ${String(quote.basis_sha256)},
              ${result.baseCostMinor}::numeric,${result.supplyMinor}::numeric,
              ${result.vatMinor}::numeric,${result.totalMinor}::numeric,${body.reason})`;
          for (const [index,line] of lines.entries()) await tx`insert into app.quote_lines
            (tenant_id,id,revision_id,position,category,quantity_value,unit_code,included,
              source_rate_id,source_revision_id,source_blob_sha256,rate_minor,cost_minor,
              source_quote_line_id)
            values (${tenantId}::uuid,${randomUUID()}::uuid,${body.id}::uuid,${line.position},
              ${line.category},${line.quantity_value},${line.unit_code},true,
              ${line.source_rate_id}::uuid,${line.source_revision_id}::uuid,
              ${line.source_blob_sha256},${String(line.rate_minor)}::numeric,
              ${result.lines[index]?.costMinor??null}::numeric,${line.id}::uuid)`;
          await tx`update app.quotes set status='draft',current_revision_id=${body.id}::uuid,
            version=version+1 where tenant_id=${tenantId}::uuid and id=${parsedId.data}::uuid`;
          return {status:201,body:{id:parsedId.data,revision_id:body.id,
            revision_version:revisionVersion,quote_version:body.expected_quote_version+1,
            state:"draft_ready",old_supply_minor:String(quote.supply_minor),
            supply_minor:result.supplyMinor,vat_minor:result.vatMinor,
            total_minor:result.totalMinor,basis_sha256:quote.basis_sha256,
            external_share_allowed:false}};
        });
    });
  }));

  app.get<{Params:{id:string}}>("/v1/quotes/:id/compare",async(request,reply)=>execute(reply,async()=>{
    const actor=await principal(request,services),tenantId=tenantHeader(request);
    const parsedId=UuidSchema.safeParse(request.params.id);
    if (!parsedId.success) throw new ApiFault("INVALID_CONTRACT");
    return inAuthorizedTransaction(services.db,actor,async tx=>{
      if (await membership(tx,tenantId,actor.userId)!=="owner") throw new ApiFault("NOT_FOUND");
      const [quote]=await tx`select id from app.quotes
        where tenant_id=${tenantId}::uuid and id=${parsedId.data}::uuid`;
      if (!quote) throw new ApiFault("NOT_FOUND");
      const revisions=await tx`select id,version,state,margin_bps,vat_mode,
        base_cost_minor,supply_minor,vat_minor,total_minor,basis_sha256,
        revision_reason,created_at from app.quote_revisions
        where tenant_id=${tenantId}::uuid and quote_id=${parsedId.data}::uuid
        order by version desc limit 2`;
      if (revisions.length<2) return {status:200,body:{available:false,quote_id:parsedId.data}};
      const [after,before]=revisions;
      if (!after || !before) throw new ApiFault("TEMPORARILY_UNAVAILABLE");
      const amount=(value:unknown)=>value===null?null:String(value);
      const difference=after.supply_minor===null || before.supply_minor===null?null:
        (BigInt(String(after.supply_minor))-BigInt(String(before.supply_minor))).toString();
      return {status:200,body:{available:true,quote_id:parsedId.data,
        before:{id:before.id,version:Number(before.version),state:before.state,
          margin_bps:Number(before.margin_bps),base_cost_minor:amount(before.base_cost_minor),
          supply_minor:amount(before.supply_minor),vat_minor:amount(before.vat_minor),
          total_minor:amount(before.total_minor),basis_sha256:before.basis_sha256},
        after:{id:after.id,version:Number(after.version),state:after.state,
          margin_bps:Number(after.margin_bps),base_cost_minor:amount(after.base_cost_minor),
          supply_minor:amount(after.supply_minor),vat_minor:amount(after.vat_minor),
          total_minor:amount(after.total_minor),basis_sha256:after.basis_sha256,
          revision_reason:after.revision_reason},supply_delta_minor:difference}};
    });
  }));
}
