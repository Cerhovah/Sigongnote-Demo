import { createHash } from "node:crypto";
import { UuidSchema } from "@sigongnote/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { inAuthorizedTransaction } from "./auth.js";
import { ApiFault, execute, idempotencyKey, membership, once, principal,
  tenantHeader, type Services } from "./routes.js";

const sha=z.string().regex(/^[0-9a-f]{64}$/);
const draft=z.object({id:UuidSchema,channel:z.enum(["sms","email","os_share"]),
  recipient_label:z.string().trim().min(1).max(180).nullable(),
  recipient_address:z.string().trim().min(3).max(254).nullable(),
  payload_text:z.string().trim().min(1).max(4000),
  evidence_ids:z.array(UuidSchema).min(1).max(20),
  disclosure_scope:z.enum(["work_status","product_documents","approved_quote"]),
  expires_at:z.iso.datetime({offset:true}),
  reason:z.string().trim().min(10).max(1000)}).strict();
const handoff=z.object({recipient_address:z.string().trim().min(3).max(254).nullable(),
  payload_sha256:sha}).strict();
const cancel=z.object({reason:z.string().trim().min(10).max(1000)}).strict();
function hash(value:unknown) {return createHash("sha256").update(JSON.stringify(value)).digest("hex");}

export function registerExternalActionRoutes(app:FastifyInstance,services:Services) {
  app.post("/v1/external-actions",async(request,reply)=>execute(reply,async()=>{
    const actor=await principal(request,services),tenantId=tenantHeader(request),key=idempotencyKey(request);
    const parsed=draft.safeParse(request.body);
    if (!parsed.success || new Set(parsed.data.evidence_ids).size!==parsed.data.evidence_ids.length)
      throw new ApiFault("INVALID_CONTRACT");
    const body=parsed.data;
    if (body.channel==="os_share" ? body.recipient_address!==null || body.recipient_label!==null :
        body.channel==="sms" ? !/^\+[1-9][0-9]{7,14}$/.test(body.recipient_address??"") :
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.recipient_address??""))
      throw new ApiFault("INVALID_CONTRACT");
    if (new Date(body.expires_at).getTime()<=Date.now() ||
        new Date(body.expires_at).getTime()>Date.now()+7*86400000)
      throw new ApiFault("INVALID_CONTRACT");
    const normalizedAddress=body.channel==="email"?body.recipient_address?.toLowerCase()??null:
      body.recipient_address;
    const payloadHash=hash({channel:body.channel,recipient_label:body.recipient_label,
      recipient_address:normalizedAddress,
      payload_text:body.payload_text,evidence_ids:body.evidence_ids,
      disclosure_scope:body.disclosure_scope});
    return inAuthorizedTransaction(services.db,actor,async tx=>{
      if (await membership(tx,tenantId,actor.userId)!=="owner") throw new ApiFault("NOT_FOUND");
      return once(tx,tenantId,actor.userId,"POST /v1/external-actions",key,hash(body),async()=>{
        const evidence=await tx`select id from app.evidence_index
          where tenant_id=${tenantId}::uuid and id=any(${tx.array(body.evidence_ids,2950)})
            and source_kind='original'`;
        if (evidence.length!==body.evidence_ids.length) throw new ApiFault("NOT_FOUND");
        const [decision]=await tx`insert into app.decisions
          (tenant_id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,
            reason,payload_hash)
          values (${tenantId}::uuid,${actor.userId}::uuid,'external_handoff',
            'approve_exact_os_handoff',${tx.array([body.id],2950)},${tx.array([1],20)},
            ${tx.array(body.evidence_ids,2950)},${body.reason},${payloadHash}) returning id`;
        if (!decision) throw new ApiFault("TEMPORARILY_UNAVAILABLE");
        await tx`insert into app.external_handoffs
          (tenant_id,id,actor_id,approval_decision_id,channel,recipient_label,
            recipient_address,recipient_bound,payload_text,payload_sha256,evidence_ids,
            disclosure_scope,expires_at)
          values (${tenantId}::uuid,${body.id}::uuid,${actor.userId}::uuid,
            ${decision.id}::uuid,${body.channel},${body.recipient_label},
            ${normalizedAddress},${body.channel!=="os_share"},
            ${body.payload_text},${payloadHash},${tx.array(body.evidence_ids,2950)},
            ${body.disclosure_scope},${body.expires_at}::timestamptz)`;
        return {status:201,body:{id:body.id,state:"prepared",payload_sha256:payloadHash,
          recipient_label:body.recipient_label,recipient_address:normalizedAddress,
          recipient_bound:body.channel!=="os_share",expires_at:body.expires_at,
          delivery_status:"not_started",share_scope:body.disclosure_scope}};
      });
    });
  }));
  app.post<{Params:{id:string}}>("/v1/external-actions/:id/handoff",
    async(request,reply)=>execute(reply,async()=>{
      const actor=await principal(request,services),tenantId=tenantHeader(request),key=idempotencyKey(request);
      const id=UuidSchema.safeParse(request.params.id),parsed=handoff.safeParse(request.body);
      if (!id.success || !parsed.success) throw new ApiFault("INVALID_CONTRACT");
      return inAuthorizedTransaction(services.db,actor,async tx=>{
        if (await membership(tx,tenantId,actor.userId)!=="owner") throw new ApiFault("NOT_FOUND");
        const [live]=await tx`select state,expires_at from app.external_handoffs
          where tenant_id=${tenantId}::uuid and id=${id.data}::uuid for share`;
        if (!live) throw new ApiFault("NOT_FOUND");
        if (live.state==="cancelled" || !(live.expires_at instanceof Date) ||
            live.expires_at.getTime()<=Date.now())
          return {status:200,body:{id:id.data,handoff_status:"unavailable",
            delivery_verified:false,automatic_retry:false}};
        return once(tx,tenantId,actor.userId,`POST /v1/external-actions/${id.data}/handoff`,
          key,hash(parsed.data),async()=>{
            const [row]=await tx`select channel,recipient_label,recipient_address,recipient_bound,
              payload_text,payload_sha256,
              expires_at,state from app.external_handoffs
              where tenant_id=${tenantId}::uuid and id=${id.data}::uuid for update`;
            if (!row) throw new ApiFault("NOT_FOUND");
            if (row.state!=="prepared" || row.recipient_address!==parsed.data.recipient_address ||
                row.payload_sha256!==parsed.data.payload_sha256 ||
                !(row.expires_at instanceof Date) || row.expires_at.getTime()<=Date.now())
              throw new ApiFault("VERSION_CONFLICT");
            await tx`update app.external_handoffs set state='handoff_unknown',handoff_count=1
              where tenant_id=${tenantId}::uuid and id=${id.data}::uuid`;
            return {status:200,body:{id:id.data,channel:row.channel,
              recipient_label:row.recipient_label,payload_text:row.payload_text,
              recipient_address:row.recipient_address,recipient_bound:row.recipient_bound,
              payload_sha256:row.payload_sha256,handoff_status:"unknown",
              delivery_verified:false,automatic_retry:false}};
          });
      });
    }));
  app.post<{Params:{id:string}}>("/v1/external-actions/:id/cancel",
    async(request,reply)=>execute(reply,async()=>{
      const actor=await principal(request,services),tenantId=tenantHeader(request),key=idempotencyKey(request);
      const id=UuidSchema.safeParse(request.params.id),parsed=cancel.safeParse(request.body);
      if (!id.success || !parsed.success) throw new ApiFault("INVALID_CONTRACT");
      return inAuthorizedTransaction(services.db,actor,async tx=>{
        if (await membership(tx,tenantId,actor.userId)!=="owner") throw new ApiFault("NOT_FOUND");
        return once(tx,tenantId,actor.userId,`POST /v1/external-actions/${id.data}/cancel`,
          key,hash(parsed.data),async()=>{
            const [row]=await tx`select state from app.external_handoffs
              where tenant_id=${tenantId}::uuid and id=${id.data}::uuid for update`;
            if (!row) throw new ApiFault("NOT_FOUND");
            if (row.state==="cancelled") throw new ApiFault("VERSION_CONFLICT");
            await tx`update app.external_handoffs set state='cancelled'
              where tenant_id=${tenantId}::uuid and id=${id.data}::uuid`;
            return {status:200,body:{id:id.data,state:"cancelled",
              prior_handoff_unknown:row.state==="handoff_unknown",
              delivery_retracted:false}};
          });
      });
    }));
}
