import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cloudChildEnvironment} from '../scripts/cloud-child-env.mjs';
test('cloud children receive only their runtime keys and never the other DB/session credentials',()=>{
  const source={PATH:'runtime',DATABASE_URL:'api-db-fixture',WORKER_DATABASE_URL:'worker-db-fixture',CLOUD_WEB_SESSION_SECRET:'fixture-session',SUPABASE_SECRET_KEY:'fixture-storage',CLOVA_SPEECH_KEY:'fixture-speech',UNRELATED_SECRET:'must-not-propagate',DATABASE_SSL_CA_PEM:'fixture-ca',DATABASE_CA_FILE:'/tmp/ca',CLOUD_WORKER_ENABLED:'true'};
  const api=cloudChildEnvironment('API',source),worker=cloudChildEnvironment('Worker',source);
  assert.equal(api.DATABASE_URL,source.DATABASE_URL);assert.equal(api.CLOUD_WEB_SESSION_SECRET,source.CLOUD_WEB_SESSION_SECRET);
  assert.equal(api.WORKER_DATABASE_URL,undefined);assert.equal(api.CLOVA_SPEECH_KEY,undefined);
  assert.equal(worker.WORKER_DATABASE_URL,source.WORKER_DATABASE_URL);assert.equal(worker.DATABASE_CA_FILE,source.DATABASE_CA_FILE);
  assert.equal(worker.DATABASE_URL,undefined);assert.equal(worker.CLOUD_WEB_SESSION_SECRET,undefined);assert.equal(worker.DATABASE_SSL_CA_PEM,undefined);
  for(const child of [api,worker]){assert.equal(child.SUPABASE_SECRET_KEY,source.SUPABASE_SECRET_KEY);assert.equal(child.UNRELATED_SECRET,undefined);}
  assert.throws(()=>cloudChildEnvironment('unknown',source));
});
test('N30 semantic/audio/fax settings reach their owning child without crossing provider or DB secrets',()=>{
 const source={SEMANTIC_ENABLED:'false',SEMANTIC_API_KEY:'synthetic',SEMANTIC_PRICE_JSON:'synthetic',SHORT_STT_PRICE_JSON:'synthetic-short',LONG_STT_ENABLED:'true',LONG_STT_PROVIDER:'openai',LONG_STT_MODEL:'whisper-1',LONG_STT_API_KEY:'synthetic-long',LONG_STT_PRICE_JSON:'synthetic-long-price',FAX_ENABLED:'false',POPBILL_SECRET_KEY:'synthetic-fax',WORKER_PDF_BATCH_PAGES:'5'};
 const api=cloudChildEnvironment('API',source),worker=cloudChildEnvironment('Worker',source);
 assert.equal(api.SEMANTIC_ENABLED,'false');assert.equal(worker.SEMANTIC_PRICE_JSON,'synthetic');assert.equal(api.SHORT_STT_PRICE_JSON,'synthetic-short');assert.equal(api.LONG_STT_API_KEY,undefined);assert.equal(api.LONG_STT_CONFIGURED,'true');assert.equal(worker.LONG_STT_API_KEY,'synthetic-long');assert.equal(worker.LONG_STT_PRICE_JSON,'synthetic-long-price');assert.equal(api.POPBILL_SECRET_KEY,'synthetic-fax');assert.equal(worker.POPBILL_SECRET_KEY,undefined);assert.equal(worker.WORKER_PDF_BATCH_PAGES,'5');
});
test('API and Worker preserve explicit Claude or fixture selection despite retained legacy semantic credentials',()=>{
 const source={AI_PROVIDER:'claude',ANTHROPIC_API_KEY:'synthetic-anthropic-key'.repeat(2),CLAUDE_AGENT_ENABLED:'true',SEMANTIC_ENABLED:'true',SEMANTIC_PROVIDER:'openai',SEMANTIC_API_KEY:'synthetic-legacy-key'.repeat(2),SEMANTIC_MODEL:'legacy-model',SEMANTIC_PRICE_JSON:JSON.stringify({version:'fixture',provider:'openai',model:'legacy-model',input_krw_per_million:1,output_krw_per_million:1,valid_until:'2099-01-01T00:00:00Z',conversion_note:'synthetic test'})};
 const configUrl=new URL('../services/api/src/product-ai-config.ts',import.meta.url).href;
 const script=`import {productAiConfig,agentConfiguration} from ${JSON.stringify(configUrl)};const source=JSON.parse(process.argv[1]);const config=productAiConfig(source);process.stdout.write(JSON.stringify({mode:agentConfiguration(source).mode,provider:config?.provider??null,runtime:config?.runtime??null}));`;
 for(const provider of ['claude','fixture'])for(const role of ['API','Worker']){
  const child=cloudChildEnvironment(role,{...source,AI_PROVIDER:provider});assert.equal(child.AI_PROVIDER,provider,`${role} must receive the operating provider switch`);assert.equal(child.SEMANTIC_API_KEY,source.SEMANTIC_API_KEY,'preserve the retained key');
  const configured=JSON.parse(execFileSync(process.execPath,['--import','tsx','--input-type=module','--eval',script,JSON.stringify(child)],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:10000}));
  assert.deepEqual(configured,provider==='claude'?{mode:'model',provider:'anthropic',runtime:'claude-agent-sdk'}:{mode:'local',provider:null,runtime:null},`${role} must honor ${provider} through the actual runtime configuration`);
 }
 assert.equal(cloudChildEnvironment('Worker',{}).AI_PROVIDER,undefined,'an unset selection stays unset for legacy compatibility');
});
