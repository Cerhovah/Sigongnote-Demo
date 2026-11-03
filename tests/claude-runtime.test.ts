import assert from 'node:assert/strict';
import {test} from 'node:test';
import {z} from 'zod';
import {CLAUDE_RUNTIME,ClaudeInvalidOutput,ClaudeUnavailable,claudeMessagesTransport,claudePrice,claudeProductAiConfig,claudeRuntimeConfig,type ClaudeRunner} from '../services/api/src/claude-runtime.js';
import {agentConfiguration,productAiConfig} from '../services/api/src/product-ai-config.js';
import {callSemantic} from '../services/api/src/semantic-provider.js';
import {callSmsTriage} from '../services/api/src/sms-triage.js';
import {agentModelRequest,callAgentModel} from '../services/api/src/agent-provider.js';
import {AgentPlanSchema} from '../services/api/src/agent-tools.js';
import {ContextResultSchema} from '../services/api/src/context-restore.js';
import {buildReadiness} from '../services/api/src/readiness.js';
import {withClaudePlanner} from '../services/api/src/claude-wiring.js';
import {normalizeToolArgs} from '../services/api/src/claude-planner.js';

const key='sk-ant-'+'x'.repeat(40);
const base:NodeJS.ProcessEnv={ANTHROPIC_API_KEY:key};
const runtime=(env:NodeJS.ProcessEnv=base)=>{const r=claudeRuntimeConfig(env);assert.ok(r);return r;};

test('Claude runtime is the product default: credential → sonnet 5 config with a conservative KRW price; explicit switches and overrides are honored',()=>{
 const r=runtime();assert.equal(r.model,'claude-sonnet-5');assert.equal(r.credential,'api_key');assert.equal(r.price.provider,'anthropic');assert.ok(r.price.input_krw_per_million>=3000&&r.price.output_krw_per_million>=15000);
 assert.equal(claudeRuntimeConfig({}),undefined);
 assert.equal(claudeRuntimeConfig({...base,CLAUDE_AGENT_ENABLED:'false'}),undefined);
 assert.equal(claudeRuntimeConfig({...base,AI_PROVIDER:'fixture'}),undefined,'fixture mode keeps every model path off');
 assert.equal(agentConfiguration({...base,AI_PROVIDER:'fixture'}).mode,'local');
 assert.equal(runtime({...base,CLAUDE_AGENT_MODEL:'claude-haiku-5-5'}).model,'claude-haiku-5-5');
 assert.equal(runtime({ANTHROPIC_BASE_URL:'https://proxy.invalid'}).credential,'sdk_session');
 assert.throws(()=>claudeRuntimeConfig({...base,CLAUDE_AGENT_MODEL:'bad model'}),/PRODUCT_AI_MODEL_INVALID/);
 assert.throws(()=>claudeRuntimeConfig({...base,CLAUDE_AGENT_MAX_USD:'99'}),/PRODUCT_AI_BUDGET_INVALID/);
 const custom=JSON.stringify({...claudePrice('claude-sonnet-5'),input_krw_per_million:5,output_krw_per_million:7,version:'custom-1'});
 assert.equal(runtime({...base,CLAUDE_AGENT_PRICE_JSON:custom}).price.input_krw_per_million,5);
 assert.throws(()=>claudeRuntimeConfig({...base,CLAUDE_AGENT_PRICE_JSON:custom.replace('claude-sonnet-5','other-model')}),/PRODUCT_AI_PRICE_INVALID/);
 // The shared product-AI config adapter flags the runtime so transports and planners route through the SDK.
 const config=claudeProductAiConfig(r,base);assert.equal(config.provider,'anthropic');assert.equal(config.runtime,CLAUDE_RUNTIME);assert.equal(config.key,key);
 assert.equal(productAiConfig(base)?.runtime,CLAUDE_RUNTIME);
 assert.equal(productAiConfig({...base,SEMANTIC_ENABLED:'false'}),undefined);
 assert.equal(productAiConfig({...base,SEMANTIC_ENABLED:'false',CLAUDE_AGENT_ENABLED:'true'})?.runtime,CLAUDE_RUNTIME);
 assert.equal(agentConfiguration(base).mode,'model');assert.equal(agentConfiguration({}).mode,'local');assert.equal(agentConfiguration({...base,CLAUDE_AGENT_MODEL:'bad model'}).mode,'blocked');
 // Explicit legacy SEMANTIC_* keeps priority over the Claude default.
 const legacy={SEMANTIC_PROVIDER:'openai',SEMANTIC_API_KEY:'k'.repeat(24),SEMANTIC_MODEL:'gpt-x',SEMANTIC_PRICE_JSON:JSON.stringify({version:'v',provider:'openai',model:'gpt-x',input_krw_per_million:1,output_krw_per_million:1,valid_until:'2099-01-01T00:00:00Z',conversion_note:'t'})};
 assert.equal(productAiConfig({...base,...legacy})?.provider,'openai');
 const readiness=buildReadiness([],base);const planner=readiness.capabilities.find(c=>c.id==='agent_planner');assert.equal(planner?.state,'ready');assert.match(planner?.reason??'',/Claude/);
 assert.equal(readiness.capabilities.find(c=>c.id==='semantic')?.state,'unverified');
});

test('explicit Claude selection overrides retained legacy provider variables and uses its own model, key and price',()=>{
 const legacy={SEMANTIC_PROVIDER:'openai',SEMANTIC_API_KEY:'synthetic-legacy-key'.repeat(2),SEMANTIC_MODEL:'legacy-model',SEMANTIC_PRICE_JSON:'retained legacy price must not be read'};
 const env={...base,...legacy,AI_PROVIDER:'claude',SEMANTIC_ENABLED:'true',CLAUDE_AGENT_ENABLED:'true'};
 const selected=productAiConfig(env);assert.ok(selected);assert.equal(selected.provider,'anthropic');assert.equal(selected.runtime,CLAUDE_RUNTIME);assert.equal(selected.key,key);assert.equal(selected.model,'claude-sonnet-5');assert.equal(selected.price.model,selected.model);assert.equal(selected.price.provider,'anthropic');
 const planner=agentConfiguration(env);assert.equal(planner.mode,'model');assert.equal(planner.config?.runtime,CLAUDE_RUNTIME);assert.equal(planner.config?.model,'claude-sonnet-5');
 assert.equal(productAiConfig({...env,CLAUDE_AGENT_MODEL:'claude-haiku-5-5'})?.model,'claude-haiku-5-5','only the Claude model override controls an explicit Claude runtime');
 assert.equal(buildReadiness([],env).capabilities.find(c=>c.id==='semantic')?.state,'unverified','legacy price setup cannot block the selected Claude connection');
});

test('explicit Claude without its required operating key is blocked and never falls back to a complete legacy provider',()=>{
 const legacy={SEMANTIC_PROVIDER:'openai',SEMANTIC_API_KEY:'synthetic-legacy-key'.repeat(2),SEMANTIC_MODEL:'legacy-model',SEMANTIC_PRICE_JSON:JSON.stringify({version:'legacy',provider:'openai',model:'legacy-model',input_krw_per_million:1,output_krw_per_million:1,valid_until:'2099-01-01T00:00:00Z',conversion_note:'synthetic fixture'})};
 for(const extra of [{},{CLAUDE_AGENT_ENABLED:'true'},{ANTHROPIC_BASE_URL:'https://synthetic-session.invalid',CLAUDE_AGENT_ENABLED:'true'}]){
  const env={...legacy,...extra,AI_PROVIDER:'claude'};assert.throws(()=>productAiConfig(env),/PRODUCT_AI_KEY_MISSING/);assert.deepEqual(agentConfiguration(env),{mode:'blocked',configurationBlocked:true});
 }
 for(const invalid of ['short','synthetic key contains spaces']){
  const env={...legacy,AI_PROVIDER:'claude',ANTHROPIC_API_KEY:invalid};assert.throws(()=>productAiConfig(env),/PRODUCT_AI_KEY_INVALID/);assert.equal(agentConfiguration(env).mode,'blocked');
 }
 assert.equal(buildReadiness([],{...legacy,AI_PROVIDER:'claude'}).capabilities.find(c=>c.id==='agent_planner')?.state,'needs_setup');
});

test('unset AI provider retains legacy precedence and SDK session defaults; explicit fixture or disabled Claude cannot revive legacy calls',()=>{
 const legacy={SEMANTIC_PROVIDER:'openai',SEMANTIC_API_KEY:'synthetic-legacy-key'.repeat(2),SEMANTIC_MODEL:'legacy-model',SEMANTIC_PRICE_JSON:JSON.stringify({version:'legacy',provider:'openai',model:'legacy-model',input_krw_per_million:1,output_krw_per_million:1,valid_until:'2099-01-01T00:00:00Z',conversion_note:'synthetic fixture'})};
 assert.equal(productAiConfig({...base,...legacy})?.provider,'openai');assert.equal(agentConfiguration(legacy).config?.provider,'openai');
 assert.equal(productAiConfig(base)?.model,'claude-sonnet-5');assert.equal(productAiConfig({ANTHROPIC_BASE_URL:'https://synthetic-session.invalid'})?.runtime,CLAUDE_RUNTIME);assert.equal(productAiConfig({}),undefined);assert.equal(agentConfiguration({}).mode,'local');
 for(const extra of [{AI_PROVIDER:'fixture',SEMANTIC_ENABLED:'true'}, {AI_PROVIDER:'claude',CLAUDE_AGENT_ENABLED:'false'}, {AI_PROVIDER:'claude',SEMANTIC_ENABLED:'false'}]){
  const env={...base,...legacy,...extra};assert.equal(productAiConfig(env),undefined);assert.equal(agentConfiguration(env).mode,'local');
 }
});

test('Messages-API transport emulation routes semantic, SMS triage and planner calls through the SDK runner and keeps ledger-compatible usage',async()=>{
 const seen:{system:string;prompt:string;schema:Record<string,unknown>}[]=[];
 const runner:ClaudeRunner=async(request)=>{seen.push({system:request.system,prompt:request.prompt,schema:request.schema});
  const value=request.schema.properties&&'decision' in (request.schema.properties as object)?{decision:'work'}:request.schema.properties&&'calls' in (request.schema.properties as object)?{calls:[{tool:'search_evidence',input:JSON.stringify({query:'문틀'})}],done:true,missing:'none',answer:'문틀 관련 자료 2건을 찾았어요.'}:{modelRunId:'00000000-0000-4000-8000-00000000abcd',claims:[{predicate:'requested_quantity',value:{kind:'quantity',value:'100',unitCode:'ea',semantic:'ordered'},speechKind:'request',quote:'문틀 100개',evidenceLocator:'section:0',confidence:0.9}],candidateLinks:[],uncertainties:[{code:'receipt_unknown',evidenceLocator:null}],evidenceLocators:['section:0']};
  return {value:request.parse(value),usage:{input_tokens:10,output_tokens:5,cache_creation_input_tokens:100,cache_read_input_tokens:1000},costUsd:0.01,receipt:'sess_abc',turns:1,durationMs:5,model:'claude-sonnet-5',toolCalls:[]};};
 const rt=runtime();const transport=claudeMessagesTransport(rt,runner);const config=claudeProductAiConfig(rt,base);
 const triage=await callSmsTriage({generation:1,payload_sha256:'a'.repeat(64),message_key:'b'.repeat(64),kind:'sms',direction:'received',occurred_at:'2026-10-10T00:00:00Z',body:'망원동 문틀 100개 내일 오전에 보내요',has_parts:false,missing_parts:0},config,transport);
 assert.equal(triage.value.decision,'work');assert.equal(triage.inputTokens,1110);assert.equal(triage.outputTokens,5);assert.equal(triage.receipt,'sess_abc');
 assert.match(seen[0]?.system??'',/Classify a Korean/);assert.match(seen[0]?.prompt??'',/망원동/);
 const plan=await callAgentModel({instruction:'문틀 자료 찾아줘',project_id:null,feedback:[],remaining_tools:8,remaining_rounds:4},config,AbortSignal.timeout(5000),transport);
 assert.equal(plan.value.calls[0]?.tool,'search_evidence');assert.equal(plan.value.answer,'문틀 관련 자료 2건을 찾았어요.');
 assert.equal(AgentPlanSchema.safeParse({calls:[],done:true,missing:'none'}).success,true,'answer stays optional for existing callers');
 assert.doesNotMatch(agentModelRequest({instruction:'x',project_id:null,feedback:[],remaining_tools:8,remaining_rounds:4,scope:{tenant:'tenant-secret-id',user:'user-secret-id',project:null,run:'run-secret-id',instruction:'x',session:'session-secret-id'}},config).serialized,/secret-id/,'scope IDs never enter the prompt');
 const id='00000000-0000-4000-8000-000000000001';
 const semantic=await callSemantic({tenantId:id,revisionId:id,sourceHash:'0'.repeat(64),parserVersion:'p',promptVersion:'v',schemaVersion:'model-claims-v1',tradePackVersion:'construction-v1',scopeFingerprint:'0'.repeat(64),sourceGeneration:1,externalAiConsent:true,spans:[{revisionId:id,locator:'section:0',kind:'text',text:'문틀 100개'}]},config,AbortSignal.timeout(5000),transport);
 assert.equal(semantic.inputTokens,1110);assert.equal(semantic.receipt,'sess_abc');
 // Invalid structured output is billable but rejected; an unavailable runtime maps to the existing error paths.
 const invalid:ClaudeRunner=async()=>{throw new ClaudeInvalidOutput({input_tokens:3,output_tokens:4,cache_creation_input_tokens:0,cache_read_input_tokens:0},'sess_bad','error_max_structured_output_retries');};
 await assert.rejects(callSmsTriage({generation:1,payload_sha256:'a'.repeat(64),message_key:'b'.repeat(64),kind:'sms',direction:'received',occurred_at:'2026-10-10T00:00:00Z',body:'x',has_parts:false,missing_parts:0},config,claudeMessagesTransport(rt,invalid)),(e:any)=>e.message==='MODEL_RESPONSE_INVALID'&&e.inputTokens===3&&e.receipt==='sess_bad');
 const down:ClaudeRunner=async()=>{throw new ClaudeUnavailable('rate limit 429');};
 await assert.rejects(callSmsTriage({generation:1,payload_sha256:'a'.repeat(64),message_key:'b'.repeat(64),kind:'sms',direction:'received',occurred_at:'2026-10-10T00:00:00Z',body:'x',has_parts:false,missing_parts:0},config,claudeMessagesTransport(rt,down)),/SEMANTIC_NOT_ACCEPTED/);
 const gone:ClaudeRunner=async()=>{throw new ClaudeUnavailable('subprocess exited');};
 await assert.rejects(callSmsTriage({generation:1,payload_sha256:'a'.repeat(64),message_key:'b'.repeat(64),kind:'sms',direction:'received',occurred_at:'2026-10-10T00:00:00Z',body:'x',has_parts:false,missing_parts:0},config,claudeMessagesTransport(rt,gone)),/SMS_TRIAGE_UNAVAILABLE/);
});

test('planner wiring swaps in the SDK planner only for Claude configs and never when a model is injected; context result schema is strict',()=>{
 const services={db:{} as never,verifyToken:async()=>null};
 const rt=runtime();const config=claudeProductAiConfig(rt,base);
 assert.equal(typeof withClaudePlanner(services,{config},base).model,'function');
 assert.equal(withClaudePlanner(services,{config:{...config,runtime:'messages'}},base).model,undefined);
 const injected=async()=>{throw Error('never');};assert.equal(withClaudePlanner(services,{config,model:injected},base).model,injected);
 const schema=z.toJSONSchema(ContextResultSchema) as unknown as {properties:{events:{items:{required:string[]}}}};
 assert.ok(schema.properties.events.items.required.includes('missing')&&schema.properties.events.items.required.includes('evidence_refs'));
 assert.equal(ContextResultSchema.safeParse({events:[{kind:'problem',summary:'물량 미도착',detail:'',project_id:null,project_name:null,context_id:null,party:null,occurred_at:null,quantities:[],evidence_refs:[],missing:['site'],confidence:'low',reasoning:'근거 없음',followups:[{title:'발신자에게 현장 확인',due_on:null}],supersedes_event_id:null}],unresolved:true}).success,true);
 assert.equal(ContextResultSchema.safeParse({events:[{kind:'payment_done',summary:'입금 완료'}],unresolved:false}).success,false,'no invented kinds or confirmations');
 // A model that stuffs the whole argument object into `query` as JSON text still reads the real query; plain text is untouched.
 assert.deepEqual(normalizeToolArgs({query:'{"query":"망원동","kind":"project"}'}),{query:'망원동',kind:'project'});
 assert.deepEqual(normalizeToolArgs({query:'{"query":"문틀","project_id":"p1","limit":15}',limit:10}),{limit:15,query:'문틀',project_id:'p1'});
 assert.deepEqual(normalizeToolArgs({query:'망원동 문틀'}),{query:'망원동 문틀'});
 assert.deepEqual(normalizeToolArgs({query:'{not json'}),{query:'{not json'});
 assert.deepEqual(normalizeToolArgs({id:'{"id":"ctx-1"}'}),{id:'ctx-1'});
});
