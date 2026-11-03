import {z} from 'zod';
import {CapturePolicySchema} from './schemas.js';

export type CapturePolicy=z.infer<typeof CapturePolicySchema>;
export type CaptureProcessor=NonNullable<CapturePolicy['processors']>[number];
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
 ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;
/** The complete validated policy participates in consent/currentness; optional fields are never projected away. */
export function canonicalCapturePolicy(value:unknown):string|null{
 const parsed=CapturePolicySchema.safeParse(value);return parsed.success?JSON.stringify(canonical(parsed.data)):null;
}
export function capturePolicyEqual(first:unknown,second:unknown):boolean{
 const a=canonicalCapturePolicy(first);return a!==null&&a===canonicalCapturePolicy(second);
}
/** A processor only grants its named channel. Root provider remains authoritative for semantic/context processing. */
export function capturePolicyProcessor(value:unknown,purpose:'long_stt'):CaptureProcessor|undefined{
 if(purpose!=='long_stt')return;
 const parsed=CapturePolicySchema.safeParse(value);if(!parsed.success||!parsed.data.external_processing)return;
 const policy=parsed.data,explicit=policy.processors?.find(item=>item.purpose===purpose);
 if(explicit)return explicit;
 // Preserve the existing single-provider policy without adding any new provider authorization.
 if(policy.processors||!['openai','clova_speech'].includes(policy.provider))return;
 return {purpose,provider:policy.provider as CaptureProcessor['provider'],processing_location:policy.processing_location,
  storage_location:policy.storage_location,retention:policy.retention};
}
