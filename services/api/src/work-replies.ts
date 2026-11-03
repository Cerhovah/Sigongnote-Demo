import type {CapturePolicy} from './capture-scope.js';
import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {WorkEffectSchema,type WorkEffect} from '@sigongnote/domain';
import {inAuthorizedTransaction} from './auth.js';
import {ApiFault,execute,principal,tenantHeader,type Services} from './routes.js';
import {executeWorkCommand,readWorkIssues} from './work-decisions.js';
const request=z.strictObject({command_id:z.uuid(),question_id:z.uuid(),question_version:z.number().int().positive(),text:z.string().trim().min(1).max(2000)});
/** Short voice transcription and typed answers enter this same deterministic boundary. */
export function replyEffects(text:string,effects:WorkEffect[]){
 const value=text.trim().replace(/[.!。]$/,'');
 if(/^(이대로 반영|그대로 해|그대로 해줘|네|맞아요|반영해줘|반영해 주세요)$/.test(value))return {effects};
 if(/^(내일 다시|내일 다시 확인|내일 확인해줘|보류)$/.test(value))return {effects:[],defer:true};
 if(effects.length===1){const e=effects[0]!;
  if(e.kind==='acceptance'){const m=/^([0-9]+(?:\.[0-9]{1,3})?)\s*(.+?)\s*(?:로|로 반영해줘|받았어|받았어요)$/.exec(value);if(m&&m[2]===e.unit){const parsed=WorkEffectSchema.safeParse({...e,quantity:m[1]});if(parsed.success)return {effects:[parsed.data]};}}
  if(e.kind==='schedule'){const m=/^(\d{4}-\d{2}-\d{2})(?:로|로 바꿔줘|로 변경)$/.exec(value);if(m){const parsed=WorkEffectSchema.safeParse({...e,date:m[1]});if(parsed.success)return {effects:[parsed.data]};}}
  if(e.kind==='quality'){const m=/^조치\s*[:：]\s*(.{1,200})$/.exec(value);if(m)return {effects:[{kind:'quality' as const,action:m[1]!}]};}
 }
 return null;
}
export function registerWorkReplies(app:FastifyInstance,services:Services){
 app.post('/v1/work/replies',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),p=request.safeParse(req.body);if(!p.success)throw new ApiFault('INVALID_CONTRACT');const b=p.data;
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   return replyOnce(tx,tenant,actor.userId,b,services.capturePolicy);
  });
 }));
}
import {once} from './routes.js';
import {workHash} from './work-decisions.js';
import type {Tx} from './auth.js';
export async function replyOnce(tx:Tx,tenant:string,user:string,b:z.infer<typeof request>,capturePolicy?:CapturePolicy){
 return once(tx,tenant,user,'POST /v1/work-replies',b.command_id,workHash(b),async()=>{
  const {questions}=await readWorkIssues(tx,tenant,user,false,capturePolicy),issue=questions.find(q=>q.id===b.question_id&&q.version===b.question_version);if(!issue)throw new ApiFault('VERSION_CONFLICT');
  if(/^(내일 다시|내일 다시 확인|내일 확인해줘|보류)[.!]?$/.test(b.text.trim()))return executeWorkCommand(tx,tenant,user,{command_id:b.command_id,intent:'defer',targets:[{type:'work_issue',id:issue.id,version:issue.version}],evidence_refs:issue.source_refs,effects:[],policy_version:1,next_review_at:new Date(Date.now()+86400000).toISOString()},undefined,capturePolicy);
  if(issue.proposal.blocked)return {status:200,body:{needs_answer:true,text:String(issue.proposal.blocked)}};
  const options=issue.proposal.cost_options??{};
  if(Object.keys(options).length){const choice=/^(하자|하자 보완|하자 보완 비용)(?:이야|이에요|으로)?[.!]?$/.test(b.text)?'defect':/^(변경|변경 추가비|변경 비용)(?:이야|이에요|으로)?[.!]?$/.test(b.text)?'change':null;
   if(!choice||!options[choice])return {status:200,body:{needs_answer:true,text:'이 추가비는 하자 보완 비용인가요, 변경 추가비인가요? “하자 보완” 또는 “변경 추가비”로 답해 주세요.'}};
   return executeWorkCommand(tx,tenant,user,{command_id:b.command_id,intent:'answer',targets:[{type:'work_issue',id:issue.id,version:issue.version}],evidence_refs:issue.source_refs,effects:[...issue.proposal.effects,options[choice]],cost_choice:choice,policy_version:1},undefined,capturePolicy);
  }
  const parsed=replyEffects(b.text,issue.proposal.effects);if(!parsed)return {status:200,body:{needs_answer:true,text:'이대로 반영, 내일 다시 확인, 8개로, 2030-01-01로 중 필요한 답을 말씀해 주세요. 조치는 “조치: 다시 방문”처럼 적어 주세요.'}};
  return executeWorkCommand(tx,tenant,user,{command_id:b.command_id,intent:parsed.defer?'defer':'answer',targets:[{type:'work_issue',id:issue.id,version:issue.version}],evidence_refs:issue.source_refs,effects:parsed.effects,policy_version:1,...(parsed.defer?{next_review_at:new Date(Date.now()+86400000).toISOString()}:{})},undefined,capturePolicy);
 });
}
