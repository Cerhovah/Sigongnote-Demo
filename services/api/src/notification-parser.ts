import {createHash} from 'node:crypto';
import {z} from 'zod';
import {messageTextChunks} from './message-bundle.js';
import type {EvidenceChunk,ParseOutput} from './parse-worker.js';

const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const snapshotSchema=z.strictObject({kind:z.literal('notification_snapshot'),partial:z.literal(true),
 package_name:z.string().min(3).max(255),conversation_hash:z.string().regex(/^[a-f0-9]{64}$/i),
 notification_key_hash:z.string().regex(/^[a-f0-9]{64}$/i),content_fingerprint:z.string().regex(/^[a-f0-9]{64}$/i),
 update_index:z.number().int().nonnegative(),observed_at_epoch_ms:z.number().int().positive().max(8640000000000000),
 from_active_at_reconnect:z.boolean(),title:z.string().max(8192),body:z.string().max(65536)});

/** OS notification text is partial evidence; it never becomes a complete conversation. */
export function parseNotification(bytes:Uint8Array):{output:ParseOutput;chunks:EvidenceChunk[]} {
 const base={sourceHash:hash(bytes),parserVersion:'notification-snapshot-v1',processorVersion:'document-python-v1',
  schemaVersion:'parse-output-v1',decoderVersion:'notification-json-v1',modelVersion:null,promptVersion:null,excerptTruncated:false} as const;
 const empty=(status:'corrupt'|'unsupported'|'quarantined',issue:string)=>({output:{...base,status,spans:[],issues:[issue],coverage:{},evidence:{schemaVersion:'evidence-chunks-v1' as const,chunkCount:0,parserVersion:base.parserVersion,sourceStatus:status,coverage:{},completeExtractedText:false}},chunks:[]});
 if(bytes.byteLength>65536)return empty('quarantined','notification_input_limit');
 let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return empty('corrupt','notification_json_invalid');}
 if(!value||typeof value!=='object'||(value as {kind?:unknown}).kind!=='notification_snapshot')return empty('unsupported','json_source_not_supported');
 const parsed=snapshotSchema.safeParse(value);if(!parsed.success)return empty('corrupt','notification_snapshot_invalid');
 const source=parsed.data,chunks:EvidenceChunk[]=[];
 for(const [field,text] of [['title',source.title],['body',source.body]] as const){
  for(const [line,part] of text.split(/\r?\n/).entries())for(const chunk of messageTextChunks(part)){
   if(!chunk.text.trim())continue;
   chunks.push({ordinal:chunks.length,text:chunk.text,locator:`notification:${field}:${line+1}:${chunk.start}`,
    position:{field,line:line+1,character_start:chunk.start,character_end:chunk.start+chunk.text.length,character_unit:'utf16_code_unit'},contentHash:hash(chunk.text)});
  }
 }
 const coverage={partial_observation:true,observed_at:new Date(source.observed_at_epoch_ms).toISOString(),package_name:source.package_name,
  conversation_hash:source.conversation_hash,update_index:source.update_index,from_active_at_reconnect:source.from_active_at_reconnect};
 return {output:{...base,status:'partial',spans:chunks.map(c=>({text:c.text,locator:c.locator})),issues:['notification_partial_observation'],coverage,
  evidence:{schemaVersion:'evidence-chunks-v1',chunkCount:chunks.length,parserVersion:base.parserVersion,sourceStatus:'partial',coverage,completeExtractedText:false}},chunks};
}
