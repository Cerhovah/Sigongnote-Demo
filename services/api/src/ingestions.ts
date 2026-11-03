import {effectiveCaptureCapability,smsDocumentId} from './sms-activation.js';
import {requireSmsWorkDecision,smsTriageInputHash} from './sms-triage.js';
import {readMessageBundle,MESSAGE_MAX_BYTES} from './message-bundle.js';
import {processorForMime} from "./long-audio.js";
import {registerCaptureDurability} from "./capture-durability.js";
import { sourceAllowsMime, sourcePolicyCurrent, captureLane } from "./capture-scope.js";
import { createHash, randomUUID } from "node:crypto";
import {
  IngestionCompleteRequestSchema, IngestionPrepareRequestSchema,
  IngestionPrepareResponseSchema, IngestionReceiptResponseSchema, UuidSchema,
  makeApiError, type ErrorCode,
} from "@sigongnote/contracts";
import type { FastifyInstance } from "fastify";
import { inAuthorizedTransaction } from "./auth.js";
import { ApiFault, execute, idempotencyKey, membership, once, principal,
  tenantHeader, type Services } from "./routes.js";

export type StorageGateway = {
  readBytes?(path:string,maxBytes:number):Promise<Uint8Array>;
  readUrl?(path:string):Promise<string>;
  sign(path: string): Promise<string>;
  verify(path: string, expectedSha256: string, expectedLength: number):
    Promise<{matches: boolean; sniffedMime: string} | null>;
  remove(path: string): Promise<void>;
};

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
function errorResult(code: ErrorCode, currentVersion?: number) {
  const { status, body } = makeApiError(code, randomUUID(),
    currentVersion === undefined ? undefined :
      { current_version: currentVersion, action: "refresh_diff" });
  return { status, body };
}
export function sniffMime(bytes: Uint8Array): string {
  const prefix = Buffer.from(bytes.subarray(0, 16));
  if (prefix.subarray(0, 4).toString() === "%PDF") return "application/pdf";
  if (prefix.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (prefix.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) return "image/jpeg";
  if(prefix.subarray(0,4).toString()==="AC10")return "image/vnd.dwg";
  if(prefix.subarray(0,5).toString()==="#!AMR")return "audio/amr";
  if(prefix.subarray(0,4).toString()==="fLaC")return "audio/flac";
  if(prefix.subarray(0,4).toString()==="OggS")return "audio/ogg";
  if(prefix.subarray(0,3).toString()==="ID3")return "audio/mpeg";
  if(prefix[0]===255 && prefix[1]!==undefined && (prefix[1]&0xf6)===0xf0)return "audio/aac";
  if(prefix[0]===255 && prefix[1]!==undefined && (prefix[1]&0xe0)===0xe0)return "audio/mpeg";
  if(prefix.subarray(0,4).toString()==="RIFF" && prefix.subarray(8,12).toString()==="WAVE")return "audio/wav";
  if(prefix.subarray(0,4).toString()==="RIFF" && prefix.subarray(8,12).toString()==="WEBP")return "image/webp";
  if(prefix.subarray(4,8).toString()==="ftyp"){
    const brand=prefix.subarray(8,12).toString();
    if(["M4A ","M4B "].includes(brand))return "audio/mp4";
    if(["heic","heix","hevc","hevx"].includes(brand))return "image/heic";
    if(["mif1","msf1"].includes(brand))return "image/heif";
    return "video/mp4";
  }
  if (prefix.subarray(0, 2).toString() === "PK") return "application/zip";
  if (prefix.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex"))) {
    return "application/x-ole-storage";
  }
  const decoded = new TextDecoder("utf-8", { fatal: true });
  try {
    const text = decoded.decode(bytes);
    if (![...text].some(character => {
      const code = character.charCodeAt(0);
      return code < 32 && code !== 9 && code !== 10 && code !== 13;
    })) return "text/plain";
  } catch { /* Binary payload stays unclassified. */ }
  return "application/octet-stream";
}

export function registerIngestionRoutes(app: FastifyInstance, services: Services,
  storage: StorageGateway) {
  registerCaptureDurability(app,services,storage);
  app.post("/v1/ingestions", async (request, reply) => execute(reply, async () => {
    const actor = await principal(request, services);
    const tenantId = tenantHeader(request);
    const key = idempotencyKey(request);
    if (request.body && typeof request.body === "object" && "byte_length" in request.body &&
        typeof request.body.byte_length === "number" && request.body.byte_length > 209715200) {
      throw new ApiFault("PAYLOAD_TOO_LARGE");
    }
    const parsed = IngestionPrepareRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiFault("INVALID_CONTRACT");
    const body = parsed.data;
    if(body.declared_mime==='application/vnd.sigongnote.message+json'&&body.byte_length>MESSAGE_MAX_BYTES)throw new ApiFault('PAYLOAD_TOO_LARGE');
    if(!body.source_id && !sourceAllowsMime(null,null,body.declared_mime))throw new ApiFault('SOURCE_SCOPE_MISMATCH');
    const bodyHash = sha256(JSON.stringify(body));
    return inAuthorizedTransaction(services.db, actor, async tx => {
      if (!(["owner", "operator"].includes(await membership(tx, tenantId, actor.userId)))) {
        throw new ApiFault("FORBIDDEN");
      }
      if (body.source_id) {
        const [source] = await tx`select s.*,d.platform,d.active as device_active
          from app.capture_sources s join app.devices d
            on d.tenant_id = s.tenant_id and d.id = s.device_id
          where s.tenant_id = ${tenantId}::uuid and s.id = ${body.source_id}::uuid
            and s.user_id = ${actor.userId}::uuid for share of s`;
        if (!source) throw new ApiFault("NOT_FOUND");
        if (!source.active || !source.device_active ||
            !source.server_upload_consent ||
            Number(source.generation) !== body.source_generation ||
            effectiveCaptureCapability(source) === "unsupported" ||
            effectiveCaptureCapability(source) === "policy_gated" ||
            !sourcePolicyCurrent(source.scope,source.processing_policy,services.capturePolicy)) {
          throw new ApiFault("SOURCE_EXPIRED");
        }
        if (!sourceAllowsMime(source.kind,source.scope,body.declared_mime))throw new ApiFault("SOURCE_SCOPE_MISMATCH");
        if(source.scope?.scope_mode==='ai_screened')await requireSmsWorkDecision(tx,tenantId,actor.userId,String(source.id),Number(source.generation),body.sha256);
      }
      return once(tx, tenantId, actor.userId, "POST /v1/ingestions", key, bodyHash,
        async () => {
          if (body.document_id) {
            const [document] = await tx`select version from app.documents
              where tenant_id = ${tenantId}::uuid and id = ${body.document_id}::uuid`;
            if (!document) throw new ApiFault("NOT_FOUND");
            if (Number(document.version) !== body.expected_version) {
              throw new ApiFault("VERSION_CONFLICT", Number(document.version));
            }
            const [predecessor] = await tx`select id from app.document_revisions
              where tenant_id = ${tenantId}::uuid and id = ${body.predecessor_revision_id ?? null}::uuid
                and document_id = ${body.document_id}::uuid
                and revision_number = ${document.version}`;
            if (!predecessor) throw new ApiFault("INVALID_CONTRACT");
          }
          const [capture] = await tx`select id from app.upload_intents
            where tenant_id = ${tenantId}::uuid and actor_id = ${actor.userId}::uuid
              and client_capture_id = ${body.client_capture_id}::uuid
              and status in ('prepared','verified')`;
          if (capture) throw new ApiFault("IDEMPOTENCY_CONFLICT");
          const id = randomUUID();
          const path = `${tenantId}/${id}`;
          const [intent] = await tx`insert into app.upload_intents
            (tenant_id,id,actor_id,client_capture_id,idempotency_key,request_hash,
              claimed_sha256,claimed_byte_length,declared_mime,storage_key,
              document_id,predecessor_revision_id,expected_version,
              source_id,source_generation)
            values (${tenantId}::uuid,${id}::uuid,${actor.userId}::uuid,
              ${body.client_capture_id}::uuid,${key}::uuid,${bodyHash},${body.sha256},
              ${body.byte_length},${body.declared_mime},${path},
              ${body.document_id ?? null}::uuid,
              ${body.predecessor_revision_id ?? null}::uuid,
              ${body.expected_version ?? null},${body.source_id ?? null}::uuid,
              ${body.source_generation ?? null})
            returning expires_at`;
          if (!intent) throw new ApiFault("TEMPORARILY_UNAVAILABLE");
          const signedUrl = await storage.sign(path);
          const url = new URL(signedUrl);
          const signature = url.searchParams.get("token");
          if (!signature) throw new ApiFault("TEMPORARILY_UNAVAILABLE");
          const endpoint = new URL("/storage/v1/upload/resumable",url).toString();
          return { status: 201, body: IngestionPrepareResponseSchema.parse({
            ingestion_id: id, state: "prepared", upload_url: signedUrl,
            expires_at: (intent.expires_at as Date).toISOString(),
            upload:{protocol:"tus",endpoint,signature,
              bucket:"sigongnote-originals",object_name:path,chunk_bytes:6291456,
              authorization:"user_bearer+signature",
              metadata_keys:"bucketName,objectName,contentType",upsert:false},
          }) };
        });
    });
  }));

  app.post<{ Params: { id: string } }>("/v1/ingestions/:id/abandon",
    async (request, reply) => execute(reply, async () => {
      const actor = await principal(request, services);
      const tenantId = tenantHeader(request);
      const key = idempotencyKey(request);
      const ingestionId = UuidSchema.safeParse(request.params.id);
      const parsed = IngestionCompleteRequestSchema.safeParse(request.body);
      if (!ingestionId.success || !parsed.success) throw new ApiFault("INVALID_CONTRACT");
      const body = parsed.data;
      let removePath: string | undefined;
      const result = await inAuthorizedTransaction(services.db, actor, async tx => {
        if (!["owner", "operator"].includes(await membership(tx, tenantId, actor.userId))) {
          throw new ApiFault("FORBIDDEN");
        }
        return once(tx, tenantId, actor.userId,
          `POST /v1/ingestions/${ingestionId.data}/abandon`, key,
          sha256(JSON.stringify(body)), async () => {
            const [intent] = await tx`select status,rejection_reason,storage_key,
                claimed_sha256,claimed_byte_length
              from app.upload_intents where tenant_id = ${tenantId}::uuid
                and id = ${ingestionId.data}::uuid and actor_id = ${actor.userId}::uuid
              for update`;
            if (!intent) throw new ApiFault("NOT_FOUND");
            if (body.sha256 !== intent.claimed_sha256 ||
                body.byte_length !== Number(intent.claimed_byte_length)) {
              throw new ApiFault("IDEMPOTENCY_CONFLICT");
            }
            if (intent.status === "verified") throw new ApiFault("IDEMPOTENCY_CONFLICT");
            if (intent.status === "prepared") {
              await tx`update app.upload_intents set status='rejected',
                rejection_reason='client_abandoned'
                where tenant_id = ${tenantId}::uuid and id = ${ingestionId.data}::uuid`;
              removePath = String(intent.storage_key);
            }
            return { status:200, body:{ingestion_id:ingestionId.data,
              state:"rejected", reason:intent.status === "prepared" ?
                "client_abandoned" : String(intent.rejection_reason)} };
          });
      });
      if (removePath) {
        try { await storage.remove(removePath); }
        catch { /* C44 orphan reconciliation removes failed upload bytes. */ }
      }
      return result;
    }));

  app.post<{ Params: { id: string } }>("/v1/ingestions/:id/complete", async (request, reply) =>
    execute(reply, async () => {
      const actor = await principal(request, services);
      const tenantId = tenantHeader(request);
      const key = idempotencyKey(request);
      const ingestionId = UuidSchema.safeParse(request.params.id);
      const parsed = IngestionCompleteRequestSchema.safeParse(request.body);
      if (!ingestionId.success || !parsed.success) throw new ApiFault("INVALID_CONTRACT");
      const body = parsed.data;
      const route = `POST /v1/ingestions/${ingestionId.data}/complete`;
      const bodyHash = sha256(JSON.stringify(body));
      // Storage can take minutes for a 200 MiB original. Never hold an intent
      // or source lock while reading it; the final transaction fences revoke.
      const preflight = await inAuthorizedTransaction(services.db, actor, async tx => {
        if (!["owner", "operator"].includes(await membership(tx, tenantId, actor.userId))) {
          throw new ApiFault("FORBIDDEN");
        }
        const [intent] = await tx`select storage_key,status,source_id,source_generation,expires_at,declared_mime
          from app.upload_intents where tenant_id = ${tenantId}::uuid
            and id = ${ingestionId.data}::uuid and actor_id = ${actor.userId}::uuid`;
        if (!intent) throw new ApiFault("NOT_FOUND");
        let sourceReady = true;
        if (intent.status === "prepared" && intent.source_id) {
          const [source] = await tx`select s.*,d.platform,d.active as device_active
            from app.capture_sources s join app.devices d
              on d.tenant_id = s.tenant_id and d.id = s.device_id
            where s.tenant_id = ${tenantId}::uuid and s.id = ${intent.source_id}::uuid
              and s.user_id = ${actor.userId}::uuid`;
          if (!source || !source.active || !source.device_active ||
              !source.server_upload_consent ||
              Number(source.generation) !== Number(intent.source_generation) ||
              effectiveCaptureCapability(source) === "unsupported" ||
              effectiveCaptureCapability(source) === "policy_gated" ||
              !sourcePolicyCurrent(source.scope,source.processing_policy,services.capturePolicy)) sourceReady = false;
        }
        return { status:200, body:{ prepared:intent.status === "prepared" &&
            (intent.expires_at as Date) > new Date() && sourceReady,
          path:String(intent.storage_key),message:intent.declared_mime==='application/vnd.sigongnote.message+json' } };
      });
      if (!preflight) throw new ApiFault("UNAUTHENTICATED");
      const { prepared, path, message } = preflight.body as {prepared:boolean;path:string;message:boolean};
      const verification = prepared
        ? await storage.verify(path,body.sha256,body.byte_length) : null;
      if (prepared && !verification) throw new ApiFault("TEMPORARILY_UNAVAILABLE");
      let messageKey:string|undefined,messageInputHash:string|undefined;
      if(prepared&&verification?.matches&&message){
        if(!storage.readBytes)throw new ApiFault('TEMPORARILY_UNAVAILABLE');
        const bytes=await storage.readBytes(path,MESSAGE_MAX_BYTES);
        if(bytes.length!==body.byte_length||sha256(bytes)!==body.sha256)throw new ApiFault('DOMAIN_INVARIANT');
        try{const message=readMessageBundle(bytes);messageKey=message.message_key;messageInputHash=smsTriageInputHash({...message,has_parts:message.parts.length>0});}catch{throw new ApiFault('INVALID_CONTRACT');}
      }
      let redundantPath: string | undefined;
      let rejectedPath: string | undefined;
      const result = await inAuthorizedTransaction(services.db, actor, async tx => {
        if (!(["owner", "operator"].includes(await membership(tx, tenantId, actor.userId)))) {
          throw new ApiFault("FORBIDDEN");
        }
        return once(tx, tenantId, actor.userId, route, key, bodyHash, async () => {
          const [link] = await tx`select source_id,source_generation
            from app.upload_intents where tenant_id = ${tenantId}::uuid
              and id = ${ingestionId.data}::uuid and actor_id = ${actor.userId}::uuid`;
          if (!link) throw new ApiFault("NOT_FOUND");
          let sourceScope:Record<string,unknown>|undefined;
          if (link.source_id) {
            const [source] = await tx`select s.*,d.platform,d.active as device_active
              from app.capture_sources s join app.devices d
                on d.tenant_id = s.tenant_id and d.id = s.device_id
              where s.tenant_id = ${tenantId}::uuid and s.id = ${link.source_id}::uuid
                and s.user_id = ${actor.userId}::uuid for update of s`;
            if (!source || !source.active || !source.device_active ||
                !source.server_upload_consent ||
                Number(source.generation) !== Number(link.source_generation) ||
                effectiveCaptureCapability(source) === "unsupported" ||
                effectiveCaptureCapability(source) === "policy_gated" ||
                !sourcePolicyCurrent(source.scope,source.processing_policy,services.capturePolicy)) {
              return errorResult("SOURCE_EXPIRED");
            }
            sourceScope=source;
          }
          const [intent] = await tx`select claimed_sha256,claimed_byte_length,
            declared_mime,storage_key,status,rejection_reason,expires_at,
            completed_revision_id,deduplicated,
            document_id,predecessor_revision_id,expected_version
            from app.upload_intents where tenant_id = ${tenantId}::uuid
              and id = ${ingestionId.data}::uuid and actor_id = ${actor.userId}::uuid
            for update`;
          if (!intent) throw new ApiFault("NOT_FOUND");
          if (body.sha256 !== intent.claimed_sha256 ||
              body.byte_length !== Number(intent.claimed_byte_length)) {
            throw new ApiFault("IDEMPOTENCY_CONFLICT");
          }
          if (intent.status === "verified") {
            const [previous] = await tx`select r.id as revision_id,r.document_id,r.blob_id,r.revision_number,
              j.id as job_id from app.document_revisions r
              left join app.jobs j on j.tenant_id = r.tenant_id
                and j.evidence_revision_id = r.id and j.job_type = 'parse_original'
                and j.processor_version = case when r.declared_mime like 'audio/%' then 'long-audio-v1' else 'document-python-v1' end
              where r.tenant_id = ${tenantId}::uuid
                and r.id = ${intent.completed_revision_id}::uuid`;
            if (!previous) throw new ApiFault("TEMPORARILY_UNAVAILABLE");
            return { status: 200, body: IngestionReceiptResponseSchema.parse({
              ingestion_id: ingestionId.data, state: previous.job_id ? "queued" : "verified",
              blob_id: previous.blob_id, document_id: previous.document_id,
              revision_id: previous.revision_id, revision_number:Number(previous.revision_number), job_id: previous.job_id ?? undefined,
              deduplicated: intent.deduplicated,
            }) };
          }
          if (intent.status === "rejected") {
            const reason = String(intent.rejection_reason);
            return errorResult(reason === "scope_mismatch" ? "SOURCE_SCOPE_MISMATCH" : reason === "hash_mismatch" ? "DOMAIN_INVARIANT" :
              reason === "stale_document" ? "VERSION_CONFLICT" : "SOURCE_EXPIRED");
          }
          if(sourceScope?.scope && (sourceScope.scope as {scope_mode?:string}).scope_mode==='ai_screened'){
            try{
              if(!messageInputHash)throw new ApiFault('SOURCE_SCOPE_MISMATCH');
              await requireSmsWorkDecision(tx,tenantId,actor.userId,String(link.source_id),Number(link.source_generation),body.sha256,messageInputHash);
            }catch(e){
              if(!(e instanceof ApiFault)||e.code!=='SOURCE_SCOPE_MISMATCH')throw e;
              await tx`update app.upload_intents set status='rejected',rejection_reason='scope_mismatch' where tenant_id=${tenantId}::uuid and id=${ingestionId.data}::uuid`;
              rejectedPath=String(intent.storage_key);
              return errorResult('SOURCE_SCOPE_MISMATCH');
            }
          }
          if (intent.status !== "prepared") throw new ApiFault("DOMAIN_INVARIANT");
          if ((intent.expires_at as Date) <= new Date()) {
            await tx`update app.upload_intents set status = 'rejected',
              rejection_reason = 'expired'
              where tenant_id = ${tenantId}::uuid and id = ${ingestionId.data}::uuid`;
            rejectedPath = String(intent.storage_key);
            return errorResult("SOURCE_EXPIRED");
          }
          if (!verification) throw new ApiFault("TEMPORARILY_UNAVAILABLE");
          if (!verification.matches) {
            await tx`update app.upload_intents set status = 'rejected',
              rejection_reason = 'hash_mismatch'
              where tenant_id = ${tenantId}::uuid and id = ${ingestionId.data}::uuid`;
            rejectedPath = String(intent.storage_key);
            return errorResult("DOMAIN_INVARIANT");
          }
          // A generic MP4 brand/octet-stream is only an audio candidate in an explicit
          // recording scope. The network-free decoder must prove audio-only before STT.
          const audioCandidate=sourceScope?.kind==='call_recording'&&String(intent.declared_mime).startsWith('audio/')&&['video/mp4','application/octet-stream'].includes(verification.sniffedMime);
          const revisionMime=verification.sniffedMime.startsWith('audio/')?verification.sniffedMime:String(intent.declared_mime);
          const checkedMime=intent.declared_mime==='application/vnd.sigongnote.message+json' && verification.sniffedMime==='text/plain'?String(intent.declared_mime):verification.sniffedMime;
          if((intent.declared_mime==='application/vnd.sigongnote.message+json' && !sourceScope) || (sourceScope && !audioCandidate && (!sourceAllowsMime(sourceScope.kind,sourceScope.scope,String(intent.declared_mime)) || !sourceAllowsMime(sourceScope.kind,sourceScope.scope,checkedMime)))){
            await tx`update app.upload_intents set status='rejected',rejection_reason='scope_mismatch'
              where tenant_id=${tenantId}::uuid and id=${ingestionId.data}::uuid`;
            rejectedPath=String(intent.storage_key);
            return errorResult("SOURCE_SCOPE_MISMATCH");
          }
          let documentId: string | undefined;
          const stableMessage=sourceScope?.kind==='sms'&&messageKey?smsDocumentId(tenantId,actor.userId,messageKey):undefined;
          if(stableMessage){
            await tx`select pg_advisory_xact_lock(hashtextextended(${stableMessage},0))`;
            const [existingMessage]=await tx`select version from app.documents where tenant_id=${tenantId}::uuid and id=${stableMessage}::uuid`;
            if((intent.document_id&&intent.document_id!==stableMessage)||(!intent.document_id&&existingMessage))return errorResult('VERSION_CONFLICT',Number(existingMessage?.version??1));
          }
          let revisionNumber = 1;
          if (intent.document_id) {
            const [document] = await tx`select version from app.documents
              where tenant_id = ${tenantId}::uuid and id = ${intent.document_id}::uuid
              for update`;
            if (!document) throw new ApiFault("NOT_FOUND");
            const current = Number(document.version);
            const [predecessor] = await tx`select id from app.document_revisions
              where tenant_id = ${tenantId}::uuid
                and id = ${intent.predecessor_revision_id}::uuid
                and document_id = ${intent.document_id}::uuid
                and revision_number = ${current}`;
            if (current !== Number(intent.expected_version) || !predecessor) {
              await tx`update app.upload_intents set status = 'rejected',
                rejection_reason = 'stale_document'
                where tenant_id = ${tenantId}::uuid and id = ${ingestionId.data}::uuid`;
              rejectedPath = String(intent.storage_key);
              return errorResult("VERSION_CONFLICT", current);
            }
            documentId = String(intent.document_id);
            revisionNumber = current + 1;
          }
          await tx`select pg_advisory_xact_lock(hashtextextended(
            ${`${tenantId}:${body.sha256}:${body.byte_length}`}, 0))`;
          const [existing] = await tx`select id,storage_location from app.evidence_blobs
            where tenant_id = ${tenantId}::uuid and sha256 = ${body.sha256}
              and byte_length = ${body.byte_length}`;
          const deduplicated = existing?.storage_location === 'server';
          if (deduplicated) redundantPath = String(intent.storage_key);
          if (existing?.storage_location === 'device') {
            const [promoted] = await tx`update app.evidence_blobs set storage_key=${intent.storage_key},storage_location='server',
              sniffed_mime=${verification.sniffedMime},scan_state='pending'
              where tenant_id=${tenantId}::uuid and id=${existing.id}::uuid and storage_location='device' returning id`;
            if (!promoted) throw new ApiFault('TEMPORARILY_UNAVAILABLE');
          }
          let blobId = existing?.id as string | undefined;
          if (!blobId) {
            const [blob] = await tx`insert into app.evidence_blobs
              (tenant_id,sha256,byte_length,sniffed_mime,storage_key)
              values (${tenantId}::uuid,${body.sha256},${body.byte_length},
                ${verification.sniffedMime},${intent.storage_key}) returning id`;
            blobId = blob?.id as string | undefined;
          }
          if (!blobId) throw new ApiFault("TEMPORARILY_UNAVAILABLE");
          if (documentId) {
            await tx`update app.documents set version = ${revisionNumber}
              where tenant_id = ${tenantId}::uuid and id = ${documentId}::uuid`;
          } else {
            const [document] = await tx`insert into app.documents (tenant_id,id)
              values (${tenantId}::uuid,${stableMessage??randomUUID()}::uuid) returning id`;
            if (!document) throw new ApiFault("TEMPORARILY_UNAVAILABLE");
            documentId = String(document.id);
          }
          const [generated] = await tx`select app.is_generated_document(${tenantId}::uuid,${body.sha256}) own`;
          const [revision] = await tx`insert into app.document_revisions
            (tenant_id,document_id,revision_number,predecessor_id,blob_id,declared_mime,generated_output)
            values (${tenantId}::uuid,${documentId}::uuid,${revisionNumber},
              ${intent.predecessor_revision_id}::uuid,${blobId}::uuid,
              ${revisionMime},${generated?.own===true}) returning id`;
          if (!revision) throw new ApiFault("TEMPORARILY_UNAVAILABLE");
          if(generated?.own){
            await tx`update app.upload_intents set status='verified',completed_revision_id=${revision.id}::uuid,deduplicated=${deduplicated},completed_at=now() where tenant_id=${tenantId}::uuid and id=${ingestionId.data}::uuid`;
            return {status:200,body:IngestionReceiptResponseSchema.parse({ingestion_id:ingestionId.data,state:'verified',blob_id:blobId,document_id:documentId,revision_id:revision.id,revision_number:revisionNumber,deduplicated})};
          }
          const [job] = await tx`insert into app.jobs
            (tenant_id,job_type,evidence_revision_id,processor_version,input_hash,work_lane)
            values (${tenantId}::uuid,'parse_original',${revision.id}::uuid,
              ${processorForMime(revisionMime)},${body.sha256},${captureLane(sourceScope?.scope)}) returning id`;
          if (!job) throw new ApiFault("TEMPORARILY_UNAVAILABLE");
          await tx`insert into app.outbox (tenant_id,job_id,topic,operation_key)
            values (${tenantId}::uuid,${job.id}::uuid,'parse_original_ready',
              ${`parse_original:${job.id}`})`;
          await tx`update app.upload_intents set status = 'verified',
            completed_revision_id = ${revision.id}::uuid,deduplicated = ${deduplicated},
            completed_at = now()
            where tenant_id = ${tenantId}::uuid and id = ${ingestionId.data}::uuid`;
          if (link.source_id) await tx`update app.capture_sources
            set last_server_ack_at = now(),updated_at = now()
            where tenant_id = ${tenantId}::uuid and id = ${link.source_id}::uuid`;
          return { status: 200, body: IngestionReceiptResponseSchema.parse({
            ingestion_id: ingestionId.data, state: "queued", blob_id: blobId,
            document_id: documentId, revision_id: revision.id, revision_number:revisionNumber, job_id: job.id,
            deduplicated,
          }) };
        });
      });
      if (rejectedPath) {
        try {
          await storage.remove(rejectedPath);
        } catch { /* C44 orphan reconciliation removes failed upload bytes. */ }
      }
      if (redundantPath) {
        try {
          await storage.remove(redundantPath);
        } catch { /* C44 orphan reconciliation removes any remaining redundant object. */ }
      }
      return result;
    }));
}
