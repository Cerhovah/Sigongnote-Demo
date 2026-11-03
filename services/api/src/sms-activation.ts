import {createHash} from 'node:crypto';
import {z} from 'zod';
const digest=z.string().regex(/^[a-f0-9]{64}$/);
/** Accepted by a trusted operator from independent H08 evidence, never a client permission report. */
export const SmsActivationEvidence=z.strictObject({
 schema:z.literal('sms-activation-v1'),tenant_id:z.uuid(),user_id:z.uuid(),device_id:z.uuid(),source_id:z.uuid(),
 generation:z.number().int().positive(),scope_fingerprint:digest,processing_policy_id:z.string().min(1),
 application_id:z.literal('com.sigongnote.app.smssync'),certificate_sha256:digest,installation_fingerprint:digest,
 policy_evidence_sha256:digest,installer_evidence_sha256:digest,accepted_by:z.uuid(),
 accepted_at:z.iso.datetime(),expires_at:z.iso.datetime(),revoked_at:z.iso.datetime().nullable(),
}).refine(e=>Date.parse(e.expires_at)>Date.parse(e.accepted_at)&&Date.parse(e.expires_at)-Date.parse(e.accepted_at)<=90*86400000);
export function smsActivation(source:Record<string,any>,now=Date.now()){
 const blocked=(state:string)=>({state,ready:false});
 if(source.kind!=='sms'||source.platform!=='android')return blocked('unsupported_install');
 const parsed=SmsActivationEvidence.safeParse(source.sms_activation);if(!parsed.success)return blocked('evidence_missing');
 const e=parsed.data;if(e.revoked_at)return blocked('revoked');
 if(Date.parse(e.accepted_at)>now||Date.parse(e.expires_at)<=now)return blocked('expired');
 if(e.tenant_id!==source.tenant_id||e.user_id!==source.user_id||e.device_id!==source.device_id||e.source_id!==source.id||e.generation!==Number(source.generation)||e.scope_fingerprint!==source.scope_fingerprint||e.processing_policy_id!==source.scope?.processing_policy_id||source.scope?.capture_method!=='sms_provider'||!['work_dedicated','ai_screened'].includes(source.scope?.scope_mode))return blocked('scope_changed');
 return {state:'qualified',ready:true,application_id:e.application_id,certificate_sha256:e.certificate_sha256,installation_fingerprint:e.installation_fingerprint,expires_at:e.expires_at};
}
export function effectiveCaptureCapability(source:Record<string,any>){return source.kind==='sms'?(smsActivation(source).ready?'passive':'policy_gated'):source.capability;}
/** Per-company/actor/provider record identity survives app reinstall without exposing phone numbers. */
export function smsDocumentId(tenant:string,user:string,key:string){
 if(!/^[a-f0-9]{64}$/.test(key))throw Error('INVALID_MESSAGE_KEY');
 const bytes=createHash('sha256').update(`sms-document-v1:${tenant}:${user}:${key}`).digest().subarray(0,16);bytes[6]=(bytes[6]!&15)|80;bytes[8]=(bytes[8]!&63)|128;
 const h=bytes.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
