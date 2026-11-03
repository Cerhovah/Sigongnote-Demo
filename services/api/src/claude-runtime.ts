/**
 * Claude Agent SDK runtime. Every product judgement (요청 이해·의미 추출·문자 선별·맥락 복원) goes through
 * `query()` of @anthropic-ai/claude-agent-sdk: one subprocess per call, no built-in file/shell tools,
 * only in-process MCP tools that this server binds to the caller's tenant. Structured output is the
 * only channel back into the product; model text never grants an effect.
 *
 * Configuration (secrets only via process.env; never logged):
 *   ANTHROPIC_API_KEY                product key (or an SDK credential such as ANTHROPIC_BASE_URL + CLAUDE_CODE_USE_*)
 *   CLAUDE_AGENT_ENABLED=true|false  explicit switch; defaults to on when a credential exists
 *   CLAUDE_AGENT_MODEL               default claude-sonnet-5 (사용자 지정 기본 모델)
 *   CLAUDE_AGENT_PRICE_JSON          optional ProductPrice override; otherwise the built-in conservative KRW table
 *   CLAUDE_AGENT_MAX_USD             per-call budget ceiling (default 0.5)
 */
import {z} from 'zod';
import {ProductPriceSchema,type ProductAiConfig,type ProductPrice} from './product-ai-config.js';

export const DEFAULT_CLAUDE_MODEL='claude-sonnet-5';
export const CLAUDE_RUNTIME='claude-agent-sdk';
/** Conservative KRW per million tokens (list USD × 1,500 KRW/USD, rounded up). Review before valid_until. */
const PRICE_TABLE:Record<string,{input:number;output:number}>={
 'claude-sonnet-5':{input:3000,output:15000},'claude-sonnet-5-5':{input:3000,output:15000},
 'claude-haiku-5-5':{input:150,output:750},'claude-opus-5-5':{input:6000,output:30000},'claude-opus-5':{input:7500,output:37500},
 'claude-fable-5-1':{input:15000,output:75000},'sonnet':{input:3000,output:15000},'haiku':{input:150,output:750},'opus':{input:6000,output:30000},
};
export function claudePrice(model:string,env:NodeJS.ProcessEnv=process.env):ProductPrice{
 if(env.CLAUDE_AGENT_PRICE_JSON){const price=ProductPriceSchema.parse(JSON.parse(env.CLAUDE_AGENT_PRICE_JSON));if(price.provider!=='anthropic'||price.model!==model)throw Error('PRODUCT_AI_PRICE_INVALID');return price;}
 const row=PRICE_TABLE[model]??PRICE_TABLE['claude-sonnet-5']!;
 return {version:'anthropic-list-2026-10-conservative-krw',provider:'anthropic',model,input_krw_per_million:row.input,output_krw_per_million:row.output,valid_until:'2027-01-01T00:00:00.000Z',conversion_note:'USD list price x 1500 KRW, rounded up; cache tokens charged as input'};
}
export type ClaudeRuntimeConfig={model:string;price:ProductPrice;maxBudgetUsd:number;maxTurns:number;effort:'low'|'medium'|'high';credential:'api_key'|'sdk_session'};
/** Present when a credential exists and CLAUDE_AGENT_ENABLED is not 'false'. Malformed price JSON throws (never a silent fallback). */
export function claudeRuntimeConfig(env:NodeJS.ProcessEnv=process.env,now=Date.now()):ClaudeRuntimeConfig|undefined{
 // AI_PROVIDER=fixture is the explicit "no model" mode: no planner, no restoration, no transport, even with a credential.
 if(env.CLAUDE_AGENT_ENABLED==='false'||env.AI_PROVIDER==='fixture')return undefined;
 const apiKey=Boolean(env.ANTHROPIC_API_KEY&&env.ANTHROPIC_API_KEY.length>=20&&!/\s/.test(env.ANTHROPIC_API_KEY));
 const session=Boolean(env.ANTHROPIC_BASE_URL||env.CLAUDE_CODE_USE_BEDROCK||env.CLAUDE_CODE_USE_VERTEX||env.CLAUDE_CODE_USE_FOUNDRY||env.CLAUDE_CODE_USE_CCR_V2||env.ANTHROPIC_AUTH_TOKEN);
 if(!apiKey&&!session&&env.CLAUDE_AGENT_ENABLED!=='true')return undefined;
 const model=(env.CLAUDE_AGENT_MODEL??DEFAULT_CLAUDE_MODEL).trim();if(!/^[a-zA-Z0-9_.:-]{1,100}$/.test(model))throw Error('PRODUCT_AI_MODEL_INVALID');
 const price=claudePrice(model,env);if(Date.parse(price.valid_until)<=now)throw Error('PRODUCT_AI_PRICE_INVALID');
 const maxBudgetUsd=Number(env.CLAUDE_AGENT_MAX_USD??'0.5');if(!(maxBudgetUsd>0&&maxBudgetUsd<=5))throw Error('PRODUCT_AI_BUDGET_INVALID');
 return {model,price,maxBudgetUsd,maxTurns:12,effort:'medium',credential:apiKey?'api_key':'sdk_session'};
}
/** Adapter for the existing product-AI ledger (reserve → submit → finish with KRW from this price). */
export function claudeProductAiConfig(runtime:ClaudeRuntimeConfig,env:NodeJS.ProcessEnv=process.env):ProductAiConfig{
 return {provider:'anthropic',key:env.ANTHROPIC_API_KEY??'sdk-session-credential-not-a-key',model:runtime.model,price:runtime.price,maxOutputTokens:4096,runtime:CLAUDE_RUNTIME};
}

export type ClaudeUsage={input_tokens:number;output_tokens:number;cache_creation_input_tokens:number;cache_read_input_tokens:number};
export type ClaudeResult<T>={value:T;usage:ClaudeUsage;costUsd:number;receipt:string;turns:number;durationMs:number;model:string;toolCalls:string[]};
export class ClaudeInvalidOutput extends Error{constructor(readonly usage:ClaudeUsage,readonly receipt:string,readonly reason:string){super('MODEL_RESPONSE_INVALID');}}
export class ClaudeUnavailable extends Error{constructor(readonly reason:string){super('CLAUDE_PROVIDER_UNAVAILABLE');}}
export type ClaudeTool={name:string;description:string;schema:Record<string,z.ZodTypeAny>;handler:(args:any)=>Promise<unknown>};
export type ClaudeSubagent={name:string;description:string;prompt:string;model?:string;tools?:string[];maxTurns?:number};
export type ClaudeRequest<T>={system:string;prompt:string;schema:Record<string,unknown>;parse:(value:unknown)=>T;tools?:ClaudeTool[]|undefined;subagents?:ClaudeSubagent[]|undefined;model?:string|undefined;maxTurns?:number|undefined;maxBudgetUsd?:number|undefined;effort?:'low'|'medium'|'high'|undefined;signal?:AbortSignal|undefined};
export type ClaudeRunner=<T>(request:ClaudeRequest<T>,runtime:ClaudeRuntimeConfig)=>Promise<ClaudeResult<T>>;

const usageOf=(u:any):ClaudeUsage=>({input_tokens:Number(u?.input_tokens??0),output_tokens:Number(u?.output_tokens??0),cache_creation_input_tokens:Number(u?.cache_creation_input_tokens??0),cache_read_input_tokens:Number(u?.cache_read_input_tokens??0)});
const toolResult=(value:unknown)=>({content:[{type:'text' as const,text:typeof value==='string'?value:JSON.stringify(value)}]});
let sdkModule:Promise<typeof import('@anthropic-ai/claude-agent-sdk')>|undefined;
const sdk=()=>sdkModule??=import('@anthropic-ai/claude-agent-sdk');

/** One query = one subprocess. Only MCP tools bound here are reachable; built-ins are disabled; no project settings are loaded. */
export const runClaude:ClaudeRunner=async function runClaude<T>(request:ClaudeRequest<T>,runtime:ClaudeRuntimeConfig):Promise<ClaudeResult<T>>{
 const {query,tool,createSdkMcpServer}=await sdk();
 const started=Date.now();const toolCalls:string[]=[];
 const tools=(request.tools??[]).map(t=>tool(t.name,t.description,t.schema,async(args:any)=>{toolCalls.push(t.name);try{return toolResult(await t.handler(args));}catch(error){return {...toolResult({error:error instanceof Error?error.message.slice(0,200):'TOOL_FAILED'}),isError:true};}}));
 const server=tools.length?createSdkMcpServer({name:'sigongnote',version:'1.0.0',tools}):undefined;
 const allowedTools=[...tools.map(t=>`mcp__sigongnote__${t.name}`),...(request.subagents?.length?['Agent']:[])];
 const agents=request.subagents?.length?Object.fromEntries(request.subagents.map(a=>[a.name,{description:a.description,prompt:a.prompt,model:a.model??runtime.model,tools:a.tools??tools.map(t=>`mcp__sigongnote__${t.name}`),maxTurns:a.maxTurns??6}])):undefined;
 const controller=new AbortController();const onAbort=()=>controller.abort();request.signal?.addEventListener('abort',onAbort,{once:true});
 const env:Record<string,string|undefined>={...process.env,CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
 let receipt='',model=request.model??runtime.model,usage=usageOf(null),costUsd=0,turns=0,structured:unknown,failure:string|undefined;
 try{
  const stream=query({prompt:request.prompt,options:{model,systemPrompt:request.system,tools:[],...(server?{mcpServers:{sigongnote:server}}:{}),allowedTools,...(agents?{agents}:{}),permissionMode:'dontAsk',settingSources:[],persistSession:false,maxTurns:request.maxTurns??runtime.maxTurns,maxBudgetUsd:request.maxBudgetUsd??runtime.maxBudgetUsd,effort:request.effort??runtime.effort,outputFormat:{type:'json_schema',schema:request.schema as never},abortController:controller,env}});
  for await(const message of stream){
   if(message.type==='system'&&message.subtype==='init'){receipt=message.session_id;model=message.model||model;}
   if(message.type==='result'){
    receipt=message.session_id||receipt;usage=usageOf(message.usage);costUsd=Number(message.total_cost_usd??0);turns=Number(message.num_turns??0);
    if(message.subtype==='success'){structured=message.structured_output;if(structured===undefined)failure='structured_output_missing';}
    else failure=message.subtype;
   }
  }
 }catch(error){
  if(!receipt)throw new ClaudeUnavailable(error instanceof Error?error.message.slice(0,200):'QUERY_FAILED');
  failure??=error instanceof Error?error.message.slice(0,120):'QUERY_FAILED';
 }finally{request.signal?.removeEventListener('abort',onAbort);}
 if(!receipt)throw new ClaudeUnavailable('NO_SESSION');
 const result={usage,costUsd,receipt,turns,durationMs:Date.now()-started,model,toolCalls};
 if(failure)throw new ClaudeInvalidOutput(usage,receipt,failure);
 let value:T;try{value=request.parse(structured);}catch{throw new ClaudeInvalidOutput(usage,receipt,'schema');}
 return {value,...result};
};

/**
 * Emulates POST https://api.anthropic.com/v1/messages for the legacy raw-fetch callers
 * (semantic-provider, agent-provider, sms-triage): the request body is routed through the Agent SDK
 * and the response is shaped like a Messages API JSON (id/usage/stop_reason/content[text]).
 * Non-200 statuses map to the callers' existing error handling (429 → not accepted, 5xx → unknown).
 */
export function claudeMessagesTransport(runtime:ClaudeRuntimeConfig,runner:ClaudeRunner=runClaude):typeof fetch{
 const respond=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
 return (async(input:RequestInfo|URL,init?:RequestInit)=>{
  let body:any;try{body=JSON.parse(String(init?.body??'{}'));}catch{return respond(400,{error:'invalid body'});}
  const schema=body?.output_config?.format?.schema;const system=typeof body?.system==='string'?body.system:Array.isArray(body?.system)?body.system.map((b:any)=>b.text??'').join('\n'):'';
  const prompt=(body?.messages??[]).map((m:any)=>typeof m.content==='string'?m.content:(m.content??[]).map((c:any)=>c.text??'').join('\n')).join('\n\n');
  if(!schema||!prompt)return respond(400,{error:'schema and messages required'});
  try{
   const result=await runner({system,prompt,schema,parse:v=>v,model:body.model,maxTurns:3,signal:init?.signal??undefined},runtime);
   return respond(200,{id:result.receipt,type:'message',role:'assistant',model:result.model,stop_reason:'end_turn',usage:result.usage,content:[{type:'text',text:JSON.stringify(result.value)}],sigongnote:{cost_usd:result.costUsd,turns:result.turns,runtime:CLAUDE_RUNTIME}});
  }catch(error){
   if(error instanceof ClaudeInvalidOutput)return respond(200,{id:error.receipt,type:'message',role:'assistant',model:runtime.model,stop_reason:'end_turn',usage:error.usage,content:[{type:'text',text:'{"invalid":"'+error.reason+'"}'}]});
   if(error instanceof ClaudeUnavailable&&/budget|rate|429|quota/i.test(error.reason))return respond(429,{error:error.reason});
   return respond(503,{error:error instanceof Error?error.message.slice(0,120):'unknown'});
  }
 }) as typeof fetch;
}
/** Default transport for a ProductAiConfig: the Agent SDK for Claude configs, plain fetch otherwise. */
export function providerTransport(config:ProductAiConfig,env:NodeJS.ProcessEnv=process.env):typeof fetch{
 if(config.runtime!==CLAUDE_RUNTIME)return fetch;
 const runtime=claudeRuntimeConfig(env);if(!runtime)throw Error('CLAUDE_RUNTIME_REQUIRED');
 return claudeMessagesTransport({...runtime,model:config.model});
}
