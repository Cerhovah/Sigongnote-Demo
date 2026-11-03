#!/usr/bin/env node
// GitHub-hosted, disposable-VM integration lane. Never connects to a linked/remote Supabase project.
// Only this aggregate receipt is publishable: child output (CLI keys, SQL, source text) stays in memory and is discarded.
import {spawn} from 'node:child_process';
import {appendFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {databaseTestCatalog} from './e2e-test-catalog.mjs';
import {supabaseFixtureEnvironment} from './supabase-fixture-scope.mjs';
import {collectRecoveryDiagnostics,readCurrentRecoveryToolDiagnostic} from './recovery-diagnostics.mjs';

const receiptPath='.work/e2e/supabase-integration.json';
const cli='node_modules/supabase/dist/supabase.js';
const excluded=['realtime','imgproxy','mailpit','postgres-meta','studio','edge-runtime','logflare','vector','supavisor'];
const fileTimeoutMs=150_000,testTimeoutMs=120_000,suiteTimeoutMs=24*60_000;
const selected=databaseTestCatalog().supabase;
const initial=()=>({database:'disposable_local_supabase',cli_version:'2.118.0',started_at:new Date().toISOString(),
 services:['postgres','gotrue','storage-api','kong','postgrest'],excluded_services:excluded,
 actual_model:'NOT_RUN',physical_device:'NOT_RUN',prepare:'NOT_RUN',suite:'NOT_RUN',cleanup:'NOT_RUN',
 limits:{file_timeout_ms:fileTimeoutMs,test_timeout_ms:testTimeoutMs,suite_timeout_ms:suiteTimeoutMs},
 files:selected.map(item=>({...item,status:'NOT_RUN',reason_not_run:'ENVIRONMENT_NOT_READY'}))});
const load=()=>existsSync(receiptPath)?JSON.parse(readFileSync(receiptPath,'utf8')):initial();
const save=receipt=>{mkdirSync('.work/e2e',{recursive:true});writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n');};
const command=process.argv[2];
if(command==='--list'){
 console.log(JSON.stringify({count:selected.length,files:selected},null,2));
 process.exit(0);
}
if(!['--initialize','--prepare','--run','--stop','--finalize'].includes(command)){
 console.error('Usage: node scripts/run-supabase-e2e.mjs --list|--initialize|--prepare|--run|--stop|--finalize');
 process.exit(2);
}
// Prevent copying over a developer environment, starting/stopping their containers, or operating a self-hosted runner.
if(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted'||process.env.RUNNER_OS!=='Linux'){
 console.error('NOT_RUN: this integration runner requires a disposable GitHub-hosted Linux VM');
 process.exit(2);
}
const env={...process.env,SIGONGNOTE_E2E_DB:'0',AI_PROVIDER:'fixture',AI_DAILY_BUDGET_KRW:'0',
 CLAUDE_AGENT_ENABLED:'false',SHORT_STT_ENABLED:'false',LONG_STT_ENABLED:'false'};
for(const key of ['ANTHROPIC_API_KEY','OPENAI_API_KEY','AI_API_KEY','SEMANTIC_API_KEY','SHORT_STT_API_KEY',
 'CLOVA_SPEECH_KEY','CLOVA_SPEECH_INVOKE_URL','SUPABASE_ACCESS_TOKEN','CLAUDE_CODE_OAUTH_TOKEN',
 'CLAUDE_E2E_LIVE','CLAUDE_E2E_RECORD','E2E_API_DATABASE_URL','E2E_WORKER_DATABASE_URL','E2E_MIGRATION_DATABASE_URL',
 'SIGONGNOTE_RECOVERY_TEST','SIGONGNOTE_RECOVERY_DISPOSABLE_VM','SIGONGNOTE_RECOVERY_DIAGNOSTICS'])delete env[key];

async function capture(args,timeoutMs,file){
 return await new Promise(resolve=>{
  const childEnv=supabaseFixtureEnvironment(env,file);
  if(file==='tests/recovery.test.ts')childEnv.SIGONGNOTE_RECOVERY_DIAGNOSTICS='1';
  const child=spawn(process.execPath,args,{env:childEnv,stdio:['ignore','pipe','pipe'],detached:true});
  let stdout='',stderr='',reason=null,finished=false;
  const kill=why=>{if(reason)return;reason=why;try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}};
  const timer=setTimeout(()=>kill('TIMEOUT'),timeoutMs);
  const collect=(channel,chunk)=>{
   if(channel==='stdout')stdout+=chunk.toString();else stderr+=chunk.toString();
   if(stdout.length+stderr.length>8*1024*1024)kill('OUTPUT_LIMIT');
  };
  child.stdout.on('data',chunk=>collect('stdout',chunk));child.stderr.on('data',chunk=>collect('stderr',chunk));
  const finish=(code,signal)=>{if(finished)return;finished=true;clearTimeout(timer);resolve({code,signal,reason,stdout,stderr});};
  child.on('error',()=>{reason='SPAWN_FAILED';finish(null,null);});child.on('close',finish);
 });
}
const resultReason=result=>result.reason??(result.signal?'PROCESS_SIGNAL':`EXIT_${result.code??'UNKNOWN'}`);
let receipt=load();
if(command==='--initialize'){save(initial());console.log(`Supabase integration: ${selected.length} files NOT_RUN until local services are ready`);}
if(command==='--prepare'){
 let stage='START';receipt.prepare='RUNNING';save(receipt);
 try{
  if(existsSync('services/api/.env'))throw new Error('ENV_ALREADY_EXISTS');
  // No linked, remote, or externally configured Docker target is accepted in this disposable lane.
  if(env.DOCKER_HOST&&!['unix:///var/run/docker.sock','unix:///run/docker.sock'].includes(env.DOCKER_HOST))throw new Error('DOCKER_TARGET_NOT_LOCAL');
  const manifest=JSON.parse(readFileSync('package.json','utf8'));
  if(manifest.devDependencies?.supabase!==receipt.cli_version)throw new Error('CLI_PIN_CHANGED');
  stage='CLI_VERSION';let result=await capture([cli,'--version'],30_000);
  if(result.code!==0||result.stdout.trim()!==receipt.cli_version)throw new Error('CLI_VERSION_MISMATCH');
  stage='SUPABASE_START';result=await capture([cli,'start','--exclude',excluded.join(','),'--yes'],8*60_000);
  if(result.code!==0)throw new Error(resultReason(result));
  stage='LOCAL_ENDPOINTS';result=await capture([cli,'status','-o','json'],30_000);
  if(result.code!==0)throw new Error('LOCAL_STATUS_UNAVAILABLE');
  const status=JSON.parse(result.stdout),api=new URL(status.API_URL),database=new URL(status.DB_URL);
  if(api.protocol!=='http:'||api.hostname!=='127.0.0.1'||database.protocol!=='postgresql:'||database.hostname!=='127.0.0.1')throw new Error('ENDPOINT_NOT_LOOPBACK');
  writeFileSync('services/api/.env',readFileSync('.env.example'),{mode:0o600});
  stage='CONFIGURE_LOCAL_ENV';result=await capture(['scripts/configure-local-env.mjs'],60_000);
  if(result.code!==0)throw new Error(resultReason(result));
  let config=readFileSync('services/api/.env','utf8');
  for(const [key,value] of Object.entries({AI_PROVIDER:'fixture',AI_DAILY_BUDGET_KRW:'0',CLAUDE_AGENT_ENABLED:'false',
   ANTHROPIC_API_KEY:'',AI_API_KEY:'',SEMANTIC_API_KEY:'',SHORT_STT_API_KEY:'',CLOVA_SPEECH_KEY:'',SHORT_STT_ENABLED:'false',LONG_STT_ENABLED:'false'})){
   const pattern=new RegExp(`^${key}=[^\\r\\n]*`,'m');if(!pattern.test(config))throw new Error('ENV_TEMPLATE_INCOMPLETE');
   config=config.replace(pattern,`${key}=${value}`);
  }
  writeFileSync('services/api/.env',config,{mode:0o600});
  stage='CONFIGURE_RUNTIME_ROLES';result=await capture(['scripts/configure-local-db-role.mjs'],60_000);
  if(result.code!==0)throw new Error(resultReason(result));
  stage='AUTH_STORAGE_DB_GATE';result=await capture(['scripts/db-gate.mjs'],60_000);
  if(result.code!==0)throw new Error(resultReason(result));
  receipt.prepare='PASS';receipt.prepare_stage='AUTH_STORAGE_DB_GATE';save(receipt);
  console.log('PASS: loopback Supabase Auth, Storage and restricted runtime roles are ready; actual model NOT_RUN');
 }catch(error){
  receipt.prepare='FAIL';receipt.prepare_stage=stage;
  // Only our finite stage/reason codes are publishable; never include subprocess diagnostics or thrown connection values.
  receipt.prepare_reason=/^[A-Z][A-Z0-9_]*$/.test(error.message)?error.message:'PREPARE_FAILED';save(receipt);
  console.error(`FAIL: ${stage} (${receipt.prepare_reason}); child output was not published`);process.exitCode=1;
 }
}
if(command==='--run'){
 if(receipt.prepare!=='PASS'){console.error('NOT_RUN: local Supabase preparation did not pass');process.exitCode=1;}
 else{
  receipt.suite='RUNNING';save(receipt);const deadline=Date.now()+suiteTimeoutMs;
  for(const item of receipt.files){
   const remaining=deadline-Date.now();
   if(remaining<1000){item.status='NOT_RUN';item.reason_not_run='SUITE_TIME_LIMIT';save(receipt);continue;}
   item.status='RUNNING';delete item.reason_not_run;save(receipt);
   const started=Date.now();
   const result=await capture(['--import','tsx','--test','--test-concurrency=1',`--test-timeout=${testTimeoutMs}`,'--test-reporter=tap',item.file],Math.min(fileTimeoutMs,remaining),item.file);
   const counts={};for(const name of ['tests','suites','pass','fail','cancelled','skipped','todo']){
    const value=[...result.stdout.matchAll(new RegExp(`^# ${name} (\\d+)\\r?$`,'gm'))].at(-1)?.[1];if(value!==undefined)counts[name]=Number(value);
   }
   item.counts=counts;item.duration_ms=Date.now()-started;
   // Successful exit without any tests, or with skipped/cancelled tests, cannot close this integration gap.
   item.status=result.code===0&&counts.tests>0&&counts.pass>0&&counts.fail===0&&counts.cancelled===0&&counts.skipped===0&&counts.todo===0?'PASS':'FAIL';
   if(item.status==='FAIL'){
    item.failure_code=result.code===0?'TESTS_NOT_FULLY_EXECUTED':resultReason(result);
    item.error_codes=[...new Set([...result.stdout.matchAll(/^\s+code: ['"]([A-Z0-9_]{1,40})['"]\r?$/gm)].map(match=>match[1]))];
    // Numeric source anchors help reproduce a failure without publishing an assertion, SQL, URL, key or captured original.
    const escaped=item.file.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    item.failure_lines=[...new Set([...result.stdout.matchAll(new RegExp(`${escaped}:(\\d+):\\d+`,'g'))].map(match=>Number(match[1])))];
    if(item.file==='tests/recovery.test.ts'){
     const diagnostics=collectRecoveryDiagnostics(result.stdout,result.stderr);
     if(diagnostics.length)item.recovery_diagnostics={scope:'observed_errors_including_expected_rejections',items:diagnostics};
     if(diagnostics.some(d=>d.code==='RECOVERY_TOOL_FAILED'&&['SCHEMA_DUMP','RESTORE_SCHEMA','RECOVERY_DRILL'].includes(d.stage))){
      item.recovery_tool_diagnostic={scope:'current_child_only',...readCurrentRecoveryToolDiagnostic('.work/recovery-tool-error.log',started,started+item.duration_ms)};
     }
    }
   }
   save(receipt);console.log(`${item.status}: ${item.file} (tests ${counts.tests??0}, passed ${counts.pass??0}, failed ${counts.fail??0}, skipped ${counts.skipped??0}${item.failure_code?`, ${item.failure_code}`:''})`);
  }
  receipt.suite=receipt.files.every(item=>item.status==='PASS')?'PASS':'FAIL';save(receipt);
  if(receipt.suite!=='PASS')process.exitCode=1;
 }
}
if(command==='--stop'){
 const project=/^project_id\s*=\s*"([a-z0-9-]+)"/m.exec(readFileSync('supabase/config.toml','utf8'))?.[1];
 if(project!=='sigongnote-dev'){receipt.cleanup='FAIL';receipt.cleanup_reason='UNEXPECTED_PROJECT';process.exitCode=1;}
 else{
  // Scoped to this freshly created hosted VM project; never --all, never a linked/remote stop.
  const result=await capture([cli,'stop','--project-id',project,'--no-backup','--yes'],2*60_000);
  receipt.cleanup=result.code===0?'PASS':'FAIL';if(result.code!==0){receipt.cleanup_reason=resultReason(result);process.exitCode=1;}
 }
 save(receipt);console.log(`${receipt.cleanup}: disposable local Supabase cleanup`);
}
if(command==='--finalize'){
 receipt.job_result=['success','failure','cancelled'].includes(process.env.SUPABASE_JOB_RESULT)?process.env.SUPABASE_JOB_RESULT:'unknown';
 if(receipt.suite==='RUNNING')receipt.suite='FAIL';
 for(const item of receipt.files)if(item.status==='RUNNING'){item.status='FAIL';item.failure_code='JOB_INTERRUPTED';}
 receipt.file_counts=Object.fromEntries(['PASS','FAIL','NOT_RUN'].map(state=>[state,receipt.files.filter(item=>item.status===state).length]));
 save(receipt);
 if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,
  `\n### Local Supabase Auth / Storage / recovery integration\n\nPreparation: **${receipt.prepare}**; suite: **${receipt.suite}**; cleanup: **${receipt.cleanup}**. Actual paid model: **NOT_RUN**.\n\n`+
  `Files: ${receipt.file_counts.PASS} PASS, ${receipt.file_counts.FAIL} FAIL, ${receipt.file_counts.NOT_RUN} NOT_RUN. Child logs, environment files, local keys and originals are not uploaded.\n\n`+
  receipt.files.map(item=>`- ${item.status}: \`${item.file}\`${item.failure_code?` (${item.failure_code})`:item.reason_not_run?` (${item.reason_not_run})`:''}.`).join('\n')+'\n');
 console.log(`Supabase integration: ${receipt.file_counts.PASS} PASS, ${receipt.file_counts.FAIL} FAIL, ${receipt.file_counts.NOT_RUN} NOT_RUN`);
}
