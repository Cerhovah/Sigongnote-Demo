import { createHash } from "node:crypto";
import { UuidSchema } from "@sigongnote/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { inAuthorizedTransaction } from "./auth.js";
import { ApiFault, execute, idempotencyKey, membership, once, principal,
  tenantHeader, type Services } from "./routes.js";

const sha=z.string().regex(/^[0-9a-f]{64}$/);
const line=z.object({charge_case_id:UuidSchema,expected_version:z.number().int().positive(),
  work_date:z.iso.date(),work_type:z.string().trim().min(1).max(100),
  work_items:z.array(z.object({location:z.string().trim().min(1).max(180),
    description:z.string().trim().min(1).max(500)}).strict()).min(1).max(50)}).strict();
const prepare=z.object({id:UuidSchema,adapter_version:z.literal("labor-ledger-v1/1.0.0"),
  source_sha256:sha,header_fingerprint:sha,lines:z.array(line).min(1).max(100),
  reason:z.string().trim().min(10).max(1000)}).strict();
const voidBody=z.object({reason:z.string().trim().min(10).max(1000)}).strict();

function canonical(value:unknown):string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value!==null && typeof value==="object") return `{${Object.entries(value)
    .sort(([a],[b])=>a<b?-1:a>b?1:0)
    .map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function hash(value:unknown) {return createHash("sha256").update(canonical(value)).digest("hex");}

export function registerExportRoutes(app:FastifyInstance,services:Services) {
  app.post("/v1/exports",async(request,reply)=>execute(reply,async()=>{
    const actor=await principal(request,services),tenantId=tenantHeader(request),key=idempotencyKey(request);
    const parsed=prepare.safeParse(request.body);
    if (!parsed.success || new Set(parsed.data.lines.map(item=>item.charge_case_id)).size!==
        parsed.data.lines.length) throw new ApiFault("INVALID_CONTRACT");
    const body=parsed.data;
    return inAuthorizedTransaction(services.db,actor,async tx=>{
      if (await membership(tx,tenantId,actor.userId)!=="owner") throw new ApiFault("NOT_FOUND");
      return once(tx,tenantId,actor.userId,"POST /v1/exports",key,hash(body),async()=>{
        const caseIds=body.lines.map(item=>item.charge_case_id);
        const rows=await tx`select c.id,c.version,c.status,c.category,c.identity_state,
          c.current_revision_id,r.payload,r.confirmed_actual_minor,r.evidence_ids,
          p.display_name as project_label,
          exists (select 1 from app.charge_allocation_batches a
            where a.tenant_id=c.tenant_id and a.charge_case_id=c.id) as has_allocation
          from app.charge_cases c
          join app.charge_revisions r on r.tenant_id=c.tenant_id and r.id=c.current_revision_id
          join app.work_bundles b on b.tenant_id=c.tenant_id and b.id=c.bundle_id
          join app.work_orders o on o.tenant_id=b.tenant_id and o.id=b.work_order_id
          left join app.projects p on p.tenant_id=o.tenant_id and p.id=o.project_id
          where c.tenant_id=${tenantId}::uuid and c.id=any(${tx.array(caseIds,2950)})
          for share of c`;
        if (rows.length!==caseIds.length) throw new ApiFault("NOT_FOUND");
        const byId=new Map(rows.map(row=>[String(row.id),row]));
        const bundles=body.lines.map(item=>{
          const row=byId.get(item.charge_case_id);
          if (row?.status!=="confirmed" || row.category!=="labor" ||
              row.identity_state!=="confirmed_distinct" ||
              Number(row.version)!==item.expected_version || !row.project_label || row.has_allocation)
            throw new ApiFault("DOMAIN_INVARIANT");
          const payload=row.payload as Record<string,unknown>;
          const quantity=payload.billingQuantity as {value?:string;unitCode?:string}|null;
          const unit=quantity?.unitCode==="day"?"일":quantity?.unitCode==="lump"?"식":
            quantity?.unitCode==="ea"?"EA":null;
          const amount=String(row.confirmed_actual_minor);
          if (!unit || !quantity || !/^[1-9][0-9]{0,11}$/.test(quantity.value??"") ||
              !/^(0|[1-9][0-9]{0,14})$/.test(amount)) throw new ApiFault("DOMAIN_INVARIANT");
          return {charge_case_id:item.charge_case_id,amount_minor:amount,
            billing_quantity:quantity.value,unit,work_date:item.work_date,
            project_label:String(row.project_label),work_type:item.work_type,
            work_items:item.work_items,payment_basis:"unknown",
            evidence_ids:row.evidence_ids as string[]};
        });
        const evidenceIds=[...new Set(bundles.flatMap(item=>item.evidence_ids))];
        if (evidenceIds.length>100) throw new ApiFault("DOMAIN_INVARIANT");
        const [decision]=await tx`insert into app.decisions
          (tenant_id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash)
          values (${tenantId}::uuid,${actor.userId}::uuid,'internal_export','approve_internal_packet',
            ${tx.array([body.id],2950)},${tx.array([1],20)},
            ${tx.array(evidenceIds,2950)},${body.reason},${hash(body)}) returning id`;
        if (!decision) throw new ApiFault("TEMPORARILY_UNAVAILABLE");
        const snapshot={adapter_version:body.adapter_version,approval_decision_id:String(decision.id),bundles};
        const snapshotHash=hash(snapshot);
        await tx`insert into app.export_batches
          (tenant_id,id,approval_decision_id,adapter_version,source_sha256,
            header_fingerprint,snapshot,snapshot_sha256,charge_case_ids,charge_revision_ids)
          values (${tenantId}::uuid,${body.id}::uuid,${decision.id}::uuid,${body.adapter_version},
            ${body.source_sha256},${body.header_fingerprint},${tx.json(snapshot)},${snapshotHash},
            ${tx.array(caseIds,2950)},
            ${tx.array(body.lines.map(item=>String(byId.get(item.charge_case_id)?.current_revision_id)),2950)})`;
        for (const item of body.lines) await tx`insert into app.export_batch_lines
          (tenant_id,batch_id,charge_case_id,charge_revision_id)
          values (${tenantId}::uuid,${body.id}::uuid,${item.charge_case_id}::uuid,
            ${byId.get(item.charge_case_id)?.current_revision_id}::uuid)`;
        return {status:201,body:{id:body.id,state:"prepared",audience:"internal",
          source_sha256:body.source_sha256,header_fingerprint:body.header_fingerprint,
          snapshot_sha256:snapshotHash,approved_snapshot:snapshot,
          delivery_verified:false}};
      });
    });
  }));
  app.post<{Params:{id:string}}>("/v1/exports/:id/void",async(request,reply)=>execute(reply,async()=>{
    const actor=await principal(request,services),tenantId=tenantHeader(request),key=idempotencyKey(request);
    const id=UuidSchema.safeParse(request.params.id),parsed=voidBody.safeParse(request.body);
    if (!id.success || !parsed.success) throw new ApiFault("INVALID_CONTRACT");
    return inAuthorizedTransaction(services.db,actor,async tx=>{
      if (await membership(tx,tenantId,actor.userId)!=="owner") throw new ApiFault("NOT_FOUND");
      return once(tx,tenantId,actor.userId,`POST /v1/exports/${id.data}/void`,key,
        hash(parsed.data),async()=>{
          const [row]=await tx`select state,snapshot from app.export_batches
            where tenant_id=${tenantId}::uuid and id=${id.data}::uuid for update`;
          if (!row) throw new ApiFault("NOT_FOUND");
          if (row.state!=="prepared") throw new ApiFault("VERSION_CONFLICT");
          const snapshot=row.snapshot as {bundles:{evidence_ids:string[]}[]};
          const evidenceIds=[...new Set(snapshot.bundles.flatMap(item=>item.evidence_ids))];
          await tx`insert into app.decisions
            (tenant_id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash)
            values (${tenantId}::uuid,${actor.userId}::uuid,'internal_export','void_internal_packet',
              ${tx.array([id.data],2950)},${tx.array([1],20)},
              ${tx.array(evidenceIds,2950)},${parsed.data.reason},${hash(parsed.data)})`;
          await tx`update app.export_batches set state='void'
            where tenant_id=${tenantId}::uuid and id=${id.data}::uuid`;
          await tx`update app.export_batch_lines set active=false
            where tenant_id=${tenantId}::uuid and batch_id=${id.data}::uuid and active`;
          return {status:200,body:{id:id.data,state:"void",output_sha256:null}};
        });
    });
  }));
  app.get<{Params:{id:string}}>("/v1/exports/:id",async(request,reply)=>execute(reply,async()=>{
    const actor=await principal(request,services),tenantId=tenantHeader(request);
    const id=UuidSchema.safeParse(request.params.id);
    if (!id.success) throw new ApiFault("INVALID_CONTRACT");
    return inAuthorizedTransaction(services.db,actor,async tx=>{
      if (await membership(tx,tenantId,actor.userId)!=="owner") throw new ApiFault("NOT_FOUND");
      const [row]=await tx`select id,state,audience,source_sha256,header_fingerprint,
        snapshot_sha256,snapshot,output_sha256,charge_case_ids,charge_revision_ids
        from app.export_batches
        where tenant_id=${tenantId}::uuid and id=${id.data}::uuid`;
      if (!row) throw new ApiFault("NOT_FOUND");
      const cases=await tx`select id,current_revision_id,status from app.charge_cases
        where tenant_id=${tenantId}::uuid and id=any(${tx.array(row.charge_case_ids as string[],2950)})`;
      const revisions=new Map(cases.map(item=>[String(item.id),item]));
      if ((row.charge_case_ids as string[]).some((caseId,index)=>{
        const current=revisions.get(caseId);
        return current?.status!=="confirmed" ||
          String(current.current_revision_id)!==(row.charge_revision_ids as string[])[index];
      })) throw new ApiFault("VERSION_CONFLICT");
      return {status:200,body:{id:row.id,state:row.state,audience:row.audience,
        source_sha256:row.source_sha256,header_fingerprint:row.header_fingerprint,
        snapshot_sha256:row.snapshot_sha256,approved_snapshot:row.snapshot,
        output_sha256:row.output_sha256}};
    });
  }));
}
