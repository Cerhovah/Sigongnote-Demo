import { createHash } from "node:crypto";
import { UuidSchema } from "@sigongnote/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { inAuthorizedTransaction } from "./auth.js";
import { ApiFault, execute, idempotencyKey, membership, once, principal, tenantHeader,
  type Services } from "./routes.js";

const productBody=z.object({id:UuidSchema,product_key:z.string().trim().min(1).max(120),
  revision_number:z.number().int().positive(),document_revision_id:UuidSchema,
  evidence_id:UuidSchema}).strict();
const prepareBody=z.object({id:UuidSchema,bundle_id:UuidSchema,
  recipient_label:z.string().trim().min(1).max(180),
  product_document_ids:z.array(UuidSchema).min(1).max(20)}).strict();
const submitBody=z.object({expected_version:z.literal(1),evidence_id:UuidSchema,
  reason:z.string().trim().min(10).max(1000)}).strict();
const replyBody=z.object({expected_version:z.number().int().min(2),
  reply_status:z.enum(["approved","conditionally_approved","revision_requested","rejected"]),
  scope_product_document_ids:z.array(UuidSchema).min(1).max(20),
  conditions:z.string().trim().min(1).max(2000).nullable(),evidence_id:UuidSchema,
  observed_at:z.iso.datetime({offset:true}),
  reason:z.string().trim().min(10).max(1000)}).strict();
const defectBody=z.object({id:UuidSchema,original_bundle_id:UuidSchema,
  original_charge_case_id:UuidSchema.nullable(),reported_evidence_id:UuidSchema,
  description:z.string().trim().min(10).max(1000),reason:z.string().trim().min(10).max(1000)}).strict();
function hash(value:unknown) {return createHash("sha256").update(JSON.stringify(value)).digest("hex");}

export function registerSubmittalRoutes(app:FastifyInstance,services:Services) {
  app.post("/v1/product-documents",async(request,reply)=>execute(reply,async()=>{
    const actor=await principal(request,services),tenantId=tenantHeader(request),key=idempotencyKey(request);
    const parsed=productBody.safeParse(request.body);
    if (!parsed.success) throw new ApiFault("INVALID_CONTRACT");
    const body=parsed.data;
    return inAuthorizedTransaction(services.db,actor,async tx=>{
      const role=await membership(tx,tenantId,actor.userId);
      if (role!=="owner" && role!=="operator") throw new ApiFault("NOT_FOUND");
      return once(tx,tenantId,actor.userId,"POST /v1/product-documents",key,hash(body),async()=>{
        await tx`select pg_advisory_xact_lock(hashtextextended(
          ${`${tenantId}:product:${body.product_key}`},0))`;
        const [source]=await tx`select id from app.evidence_index
          where tenant_id=${tenantId}::uuid and id=${body.evidence_id}::uuid
            and revision_id=${body.document_revision_id}::uuid and source_kind='original'
            and category='drawing_material' and scope in ('product_reference','company_common')`;
        const [latest]=await tx`select max(revision_number)::int as number from app.product_documents
          where tenant_id=${tenantId}::uuid and product_key=${body.product_key}`;
        if (!source || body.revision_number!==Number(latest?.number??0)+1)
          throw new ApiFault("DOMAIN_INVARIANT");
        await tx`insert into app.product_documents
          (tenant_id,id,product_key,revision_number,document_revision_id,evidence_id)
          values (${tenantId}::uuid,${body.id}::uuid,${body.product_key},${body.revision_number},
            ${body.document_revision_id}::uuid,${body.evidence_id}::uuid)`;
        return {status:201,body:{id:body.id,product_key:body.product_key,
          revision_number:body.revision_number,site_approved:false}};
      });
    });
  }));

  app.post("/v1/submittals",async(request,reply)=>execute(reply,async()=>{
    const actor=await principal(request,services),tenantId=tenantHeader(request),key=idempotencyKey(request);
    const parsed=prepareBody.safeParse(request.body);
    if (!parsed.success || new Set(parsed.data.product_document_ids).size!==
        parsed.data.product_document_ids.length) throw new ApiFault("INVALID_CONTRACT");
    const body=parsed.data;
    return inAuthorizedTransaction(services.db,actor,async tx=>{
      if (await membership(tx,tenantId,actor.userId)!=="owner") throw new ApiFault("NOT_FOUND");
      return once(tx,tenantId,actor.userId,"POST /v1/submittals",key,hash(body),async()=>{
        const [bundle]=await tx`select id from app.work_bundles
          where tenant_id=${tenantId}::uuid and id=${body.bundle_id}::uuid`;
        const docs=await tx`select id,document_revision_id from app.product_documents
          where tenant_id=${tenantId}::uuid
            and id=any(${tx.array(body.product_document_ids,2950)})`;
        if (!bundle || docs.length!==body.product_document_ids.length) throw new ApiFault("NOT_FOUND");
        await tx`insert into app.submittals(tenant_id,id,bundle_id,recipient_label)
          values (${tenantId}::uuid,${body.id}::uuid,${body.bundle_id}::uuid,${body.recipient_label})`;
        for (const doc of docs) await tx`insert into app.submittal_items
          (tenant_id,submittal_id,product_document_id,pinned_revision_id)
          values (${tenantId}::uuid,${body.id}::uuid,${doc.id}::uuid,
            ${doc.document_revision_id}::uuid)`;
        return {status:201,body:{id:body.id,version:1,status:"prepared",
          document_revision_ids:docs.map(item=>item.document_revision_id),site_approved:false}};
      });
    });
  }));

  app.post<{Params:{id:string}}>("/v1/submittals/:id/submit",async(request,reply)=>execute(reply,async()=>{
    const actor=await principal(request,services),tenantId=tenantHeader(request),key=idempotencyKey(request);
    const id=UuidSchema.safeParse(request.params.id),parsed=submitBody.safeParse(request.body);
    if (!id.success || !parsed.success) throw new ApiFault("INVALID_CONTRACT");
    const body=parsed.data;
    return inAuthorizedTransaction(services.db,actor,async tx=>{
      if (await membership(tx,tenantId,actor.userId)!=="owner") throw new ApiFault("NOT_FOUND");
      return once(tx,tenantId,actor.userId,`POST /v1/submittals/${id.data}/submit`,key,hash(body),async()=>{
        const [submission]=await tx`select bundle_id,version,submitted_evidence_id from app.submittals
          where tenant_id=${tenantId}::uuid and id=${id.data}::uuid for update`;
        if (!submission) throw new ApiFault("NOT_FOUND");
        if (Number(submission.version)!==1 || submission.submitted_evidence_id)
          throw new ApiFault("VERSION_CONFLICT",Number(submission.version));
        const [source]=await tx`select e.id from app.evidence_index e
          join app.evidence_attributions a on a.tenant_id=e.tenant_id and a.evidence_index_id=e.id
          where e.tenant_id=${tenantId}::uuid and e.id=${body.evidence_id}::uuid
            and e.source_kind='original' and a.state='confirmed'
            and a.bundle_id=${submission.bundle_id}::uuid
            and not exists (select 1 from app.submittal_items item
              join app.product_documents p on p.tenant_id=item.tenant_id
                and p.id=item.product_document_id
              where item.tenant_id=e.tenant_id and item.submittal_id=${id.data}::uuid
                and p.evidence_id=e.id)`;
        if (!source) throw new ApiFault("DOMAIN_INVARIANT");
        const [decision]=await tx`insert into app.decisions
          (tenant_id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash)
          values (${tenantId}::uuid,${actor.userId}::uuid,'submittal_submission','record_sent',
            ${tx.array([id.data],2950)},${tx.array([1],20)},
            ${tx.array([body.evidence_id],2950)},${body.reason},${hash(body)}) returning id`;
        await tx`update app.submittals set version=2,submitted_evidence_id=${body.evidence_id}::uuid,
          submit_decision_id=${decision?.id}::uuid
          where tenant_id=${tenantId}::uuid and id=${id.data}::uuid`;
        return {status:201,body:{id:id.data,version:2,status:"submitted",
          delivery_verified:false,site_approved:false}};
      });
    });
  }));

  app.post<{Params:{id:string}}>("/v1/submittals/:id/reply",async(request,reply)=>execute(reply,async()=>{
    const actor=await principal(request,services),tenantId=tenantHeader(request),key=idempotencyKey(request);
    const id=UuidSchema.safeParse(request.params.id),parsed=replyBody.safeParse(request.body);
    if (!id.success || !parsed.success || new Set(parsed.data.scope_product_document_ids).size!==
        parsed.data.scope_product_document_ids.length ||
        (parsed.data.reply_status==="conditionally_approved" && !parsed.data.conditions))
      throw new ApiFault("INVALID_CONTRACT");
    const body=parsed.data;
    return inAuthorizedTransaction(services.db,actor,async tx=>{
      if (await membership(tx,tenantId,actor.userId)!=="owner") throw new ApiFault("NOT_FOUND");
      return once(tx,tenantId,actor.userId,`POST /v1/submittals/${id.data}/reply`,key,hash(body),async()=>{
        const [submission]=await tx`select bundle_id,version,submitted_evidence_id from app.submittals
          where tenant_id=${tenantId}::uuid and id=${id.data}::uuid for update`;
        if (!submission) throw new ApiFault("NOT_FOUND");
        if (!submission.submitted_evidence_id || Number(submission.version)!==body.expected_version)
          throw new ApiFault("VERSION_CONFLICT",Number(submission.version));
        const items=await tx`select product_document_id from app.submittal_items
          where tenant_id=${tenantId}::uuid and submittal_id=${id.data}::uuid
            and product_document_id=any(${tx.array(body.scope_product_document_ids,2950)})`;
        const [source]=await tx`select e.id from app.evidence_index e
          join app.evidence_attributions a on a.tenant_id=e.tenant_id and a.evidence_index_id=e.id
          where e.tenant_id=${tenantId}::uuid and e.id=${body.evidence_id}::uuid
            and e.source_kind='original' and a.state='confirmed'
            and a.bundle_id=${submission.bundle_id}::uuid`;
        if (items.length!==body.scope_product_document_ids.length || !source ||
            body.evidence_id===submission.submitted_evidence_id) throw new ApiFault("DOMAIN_INVARIANT");
        const nextVersion=body.expected_version+1;
        const [lastObserved]=await tx`select max(observed_at) as value from app.submittal_replies
          where tenant_id=${tenantId}::uuid and submittal_id=${id.data}::uuid`;
        const [decision]=await tx`insert into app.decisions
          (tenant_id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash)
          values (${tenantId}::uuid,${actor.userId}::uuid,'submittal_reply',${body.reply_status},
            ${tx.array([id.data],2950)},${tx.array([body.expected_version],20)},
            ${tx.array([body.evidence_id],2950)},${body.reason},${hash(body)}) returning id`;
        await tx`insert into app.submittal_replies
          (tenant_id,submittal_id,version,reply_status,scope_product_document_ids,
            conditions,evidence_id,observed_at,decision_id)
          values (${tenantId}::uuid,${id.data}::uuid,${nextVersion},${body.reply_status},
            ${tx.array(body.scope_product_document_ids,2950)},${body.conditions},
            ${body.evidence_id}::uuid,${body.observed_at}::timestamptz,${decision?.id}::uuid)`;
        await tx`update app.submittals set version=${nextVersion}
          where tenant_id=${tenantId}::uuid and id=${id.data}::uuid`;
        return {status:201,body:{id:id.data,version:nextVersion,status:body.reply_status,
          scope_product_document_ids:body.scope_product_document_ids,
          conditions:body.conditions,approval_scope:"pinned_revisions_only",
          observed_time_basis:"owner_confirmed",
          out_of_order_reply:lastObserved?.value instanceof Date &&
            new Date(body.observed_at)<lastObserved.value}};
      });
    });
  }));

  app.get<{Params:{id:string}}>("/v1/submittals/:id",async(request,reply)=>execute(reply,async()=>{
    const actor=await principal(request,services),tenantId=tenantHeader(request);
    const id=UuidSchema.safeParse(request.params.id);
    if (!id.success) throw new ApiFault("INVALID_CONTRACT");
    return inAuthorizedTransaction(services.db,actor,async tx=>{
      const role=await membership(tx,tenantId,actor.userId);
      if (!["owner","operator","accountant"].includes(role)) throw new ApiFault("NOT_FOUND");
      const [submission]=await tx`select bundle_id,recipient_label,version,submitted_evidence_id
        from app.submittals where tenant_id=${tenantId}::uuid and id=${id.data}::uuid`;
      if (!submission) throw new ApiFault("NOT_FOUND");
      const items=await tx`select item.product_document_id,item.pinned_revision_id,
        p.product_key,p.revision_number,
        (select max(revision_number) from app.product_documents latest
          where latest.tenant_id=p.tenant_id and latest.product_key=p.product_key) as latest_revision_number
        from app.submittal_items item join app.product_documents p
          on p.tenant_id=item.tenant_id and p.id=item.product_document_id
        where item.tenant_id=${tenantId}::uuid and item.submittal_id=${id.data}::uuid`;
      const replies=await tx`select reply_status,scope_product_document_ids,conditions,evidence_id,
        observed_at,version
        from app.submittal_replies where tenant_id=${tenantId}::uuid and submittal_id=${id.data}::uuid
        order by observed_at desc,version desc`;
      const [replyRow]=replies;
      const [lastRecorded]=await tx`select observed_at from app.submittal_replies
        where tenant_id=${tenantId}::uuid and submittal_id=${id.data}::uuid
        order by version desc limit 1`;
      const scoped=items.map(item=>{
        const reply=replies.find(row=>(row.scope_product_document_ids as string[])
          .includes(item.product_document_id));
        return {product_document_id:item.product_document_id,
          pinned_revision_id:item.pinned_revision_id,revision_number:Number(item.revision_number),
          newer_revision_available:Number(item.latest_revision_number)>Number(item.revision_number),
          site_status:reply?.reply_status??"awaiting_reply"};
      });
      return {status:200,body:{id:id.data,bundle_id:submission.bundle_id,
        recipient_label:submission.recipient_label,version:Number(submission.version),
        submission_status:submission.submitted_evidence_id?"submitted":"prepared",
        product_documents:scoped,
        latest_reply:replyRow??null,site_approved:scoped.every(item=>item.site_status==="approved"),
        conditions_open:scoped.some(item=>item.site_status==="conditionally_approved"),
        out_of_order_reply:lastRecorded?.observed_at instanceof Date &&
          replyRow?.observed_at instanceof Date && lastRecorded.observed_at<replyRow.observed_at,
        approval_scope:"pinned_revisions_only"}};
    });
  }));

  app.post("/v1/defect-cases",async(request,reply)=>execute(reply,async()=>{
    const actor=await principal(request,services),tenantId=tenantHeader(request),key=idempotencyKey(request);
    const parsed=defectBody.safeParse(request.body);
    if (!parsed.success) throw new ApiFault("INVALID_CONTRACT");
    const body=parsed.data;
    return inAuthorizedTransaction(services.db,actor,async tx=>{
      if (await membership(tx,tenantId,actor.userId)!=="owner") throw new ApiFault("NOT_FOUND");
      return once(tx,tenantId,actor.userId,"POST /v1/defect-cases",key,hash(body),async()=>{
        const [bundle]=await tx`select id from app.work_bundles
          where tenant_id=${tenantId}::uuid and id=${body.original_bundle_id}::uuid`;
        const [source]=await tx`select e.id from app.evidence_index e
          join app.evidence_attributions a on a.tenant_id=e.tenant_id and a.evidence_index_id=e.id
          where e.tenant_id=${tenantId}::uuid and e.id=${body.reported_evidence_id}::uuid
            and e.source_kind='original' and e.category='inspection_defect'
            and a.state='confirmed' and a.bundle_id=${body.original_bundle_id}::uuid`;
        if (!bundle || !source) throw new ApiFault("DOMAIN_INVARIANT");
        if (body.original_charge_case_id) {
          const [charge]=await tx`select id from app.charge_cases
            where tenant_id=${tenantId}::uuid and id=${body.original_charge_case_id}::uuid
              and bundle_id=${body.original_bundle_id}::uuid`;
          if (!charge) throw new ApiFault("DOMAIN_INVARIANT");
        }
        const [decision]=await tx`insert into app.decisions
          (tenant_id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash)
          values (${tenantId}::uuid,${actor.userId}::uuid,'defect_link','link_original_work',
            ${tx.array([body.id,body.original_bundle_id],2950)},${tx.array([1,1],20)},
            ${tx.array([body.reported_evidence_id],2950)},${body.reason},${hash(body)}) returning id`;
        await tx`insert into app.defect_cases
          (tenant_id,id,original_bundle_id,original_charge_case_id,reported_evidence_id,
            decision_id,description)
          values (${tenantId}::uuid,${body.id}::uuid,${body.original_bundle_id}::uuid,
            ${body.original_charge_case_id}::uuid,${body.reported_evidence_id}::uuid,
            ${decision?.id}::uuid,${body.description})`;
        return {status:201,body:{id:body.id,original_bundle_id:body.original_bundle_id,
          liability:"unknown",customer_charge_minor:null,existing_cost_changed:false}};
      });
    });
  }));
}
