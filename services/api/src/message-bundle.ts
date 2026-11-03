import {createHash} from 'node:crypto';
import {z} from 'zod';

export const MESSAGE_MIME='application/vnd.sigongnote.message+json';
export const MESSAGE_MAX_BYTES=8*1024*1024;
const part=z.strictObject({id:z.string().regex(/^[0-9]{1,20}$/),mime:z.enum(['image/jpeg','image/png','image/webp']),
 bytes_base64:z.string().max(7*1024*1024).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)});
const bundle=z.strictObject({schema:z.literal('sms-sync-v1'),kind:z.enum(['sms','mms']),
 message_key:z.string().regex(/^[a-f0-9]{64}$/),direction:z.enum(['received','sent']),
 occurred_at:z.iso.datetime({offset:false}),body:z.string().max(65536),
 parts:z.array(part).max(20),missing_parts:z.number().int().min(0).max(1000)})
 .refine(v=>v.kind==='mms'||(v.parts.length===0&&v.missing_parts===0))
 .refine(v=>new Set(v.parts.map(p=>p.id)).size===v.parts.length);
export type MessageBundle=z.infer<typeof bundle>;
export function readMessageBundle(bytes:Uint8Array):MessageBundle{
 if(bytes.length>MESSAGE_MAX_BYTES)throw new Error('MESSAGE_TOO_LARGE');
 const value=bundle.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
 let size=0;
 for(const p of value.parts){const data=Buffer.from(p.bytes_base64,'base64');size+=data.length;
  if(!data.length||data.toString('base64')!==p.bytes_base64||size>5*1024*1024)throw new Error('MESSAGE_PART_INVALID');
  const valid=p.mime==='image/jpeg'?data.subarray(0,3).equals(Buffer.from('ffd8ff','hex')):
   p.mime==='image/png'?data.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):
   data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WEBP';
  if(!valid)throw new Error('MESSAGE_PART_INVALID');
 }
 return value;
}
type Excerpt={status:string;spans:{text:string;locator:string}[];excerptTruncated:boolean;issues:string[]};
/** UTF-16 wire limits must never cut a Unicode scalar between its surrogates. */
export function* messageTextChunks(text:string){
 for(let start=0;start<text.length;){
  let end=Math.min(start+1000,text.length);
  if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]!))end--;
  const value=text.slice(start,end);
  if(value.trim())yield {start,text:value};
  start=end;
 }
}
/** Keep the message and its image evidence together. A missing image is never an empty successful parse. */
export async function parseMessageBundle(bytes:Uint8Array,parseImage:(bytes:Uint8Array,mime:string)=>Promise<Excerpt>){
 const value=readMessageBundle(bytes),spans:{text:string;locator:string}[]=[],issues:string[]=[];
 let partial=value.missing_parts>0,truncated=false;
 if(partial)issues.push('message_attachments_missing');
 const lines=value.body.split(/\r?\n/);for(let i=0;i<lines.length;i++){
  for(const chunk of messageTextChunks(lines[i]!))spans.push({text:chunk.text,locator:`message:body:${i+1}:${chunk.start}`});
 }
 for(const p of value.parts){
  const out=await parseImage(Buffer.from(p.bytes_base64,'base64'),p.mime);
   // Dependency/process/timeout failures must retry the durable job, not freeze the same original as partial forever.
   if(out.issues.some(code=>['OCR_ENGINE_UNAVAILABLE','OCR_EXECUTION_FAILED','OCR_ENGINE_FAILED','ocr_failed'].includes(code)))throw new Error('MESSAGE_IMAGE_RETRY');
   partial||=out.status!=='complete';truncated||=out.excerptTruncated;
   for(const s of out.spans)spans.push({text:s.text,locator:`message:part:${p.id}:${s.locator}`.slice(0,300)});
   if(out.status!=='complete')issues.push(`message_image_${out.status}`);
 }
 if(!spans.length){partial=true;issues.push('message_no_readable_text');}
 truncated||=spans.length>1000;
 return {status:partial||truncated?'partial':'complete',sourceHash:createHash('sha256').update(bytes).digest('hex'),
  parserVersion:'sms-sync-v1',spans:spans.slice(0,1000),excerptTruncated:truncated,issues:[...new Set(issues)],
  processorVersion:'document-python-v1',schemaVersion:'parse-output-v1',decoderVersion:'message-bundle-v1',modelVersion:null,promptVersion:null};
}
