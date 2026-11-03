import type {WorkRequest} from './work-client.js';
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const pick=(value:unknown,keys:string[])=>Object.fromEntries(Object.entries(record(value)).filter(([key])=>keys.includes(key)));
const list=(value:unknown)=>Array.isArray(value)?value:[];
/** Activity keeps the words the user sent and product replies, never a second source-text archive. */
export function activityRequestSummary(r:WorkRequest){
 let input:unknown=r;if('command' in r){try{input=JSON.parse(r.command);}catch{return {message:'업무 요청'};}}
 const result=pick(input,['text','q','recipient','recipient_confirmation','amount_minor','margin_bps','tax_mode','tax_bps','format','action','intent','cost_choice','next_review_at','scope','valid_days','max_amount_minor','alias','outcome']);
 if(r.route==='work.command')return {...result,effects:list(record(input).effects).map(e=>pick(e,['kind','quantity','ordered','unit','amount_minor','date','party','action']))};
 return result;
}
export function activityResultSummary(route:string,value:unknown){
 const v=record(value);
 if(route==='conversation.turn')return {text:v.text,status:v.status,cards:list(v.cards).map(card=>pick(card,['title','project_name'])),document_draft:pick(v.document_draft,['type'])};
 if(route==='materials.list')return {count:list(v.materials).length,materials:list(v.materials).map(m=>pick(m,['title','categories','status','project_name']))};
 if(route==='materials.detail'||route==='materials.message')return {message:route==='materials.detail'?'자료 내용을 확인했습니다.':'문자 내용을 확인했습니다.',...pick(v.revision,['status']),...pick(v.organization,['categories','state'])};
 if(route==='materials.original'||route==='documents.file')return {message:'파일 열기·저장·공유 요청을 처리했습니다.'};
 if(route.startsWith('documents.')){const d=record(v.document);return {...pick(v,['state','status','recorded']),document:{...pick(d,['type','document_number','date']),totals:pick(d.totals,['supply','tax','total'])},documents:list(v.documents).map(d=>pick(d,['type','number','total','state']))};}
 if(route==='work.reply'||route==='work.command')return pick(v,['text','changed','deferred','needs_answer','memory_cost_minor']);
 if(route==='voice.result')return pick(v,['transcript']);
 return pick(v,['message','text','state','status','saved','recorded','automatic','changed']);
}
