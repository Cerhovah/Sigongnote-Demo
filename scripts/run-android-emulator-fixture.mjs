#!/usr/bin/env node
// Disposable hosted VM only. Real loopback Auth/Storage/API/Python workers; synthetic source data and no paid model.
// Like device-android.ps1, install isolated APKs and run each instrumentation class through adb.
import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const appId='com.sigongnote.app.devtest',runner=`${appId}.test/androidx.test.runner.AndroidJUnitRunner`;
const updateClass='com.sigongnote.app.UpdateContinuityDeviceTest';
const output='.work/device/android-emulator',receiptPath=`${output}/verification-scope.json`;
const privateRoot='.work/android-emulator-private',labRoot='.work/work-preview',pidPath=`${privateRoot}/child.json`;
const health='http://127.0.0.1:5190',apiPort=5191,storagePort=54321;
const defaults=['WorkScreenDeviceTest','WorkLedgerDeviceTest','PhotoCaptureDeviceTest','CaptureUploadDeviceTest','UpdateContinuityDeviceTest'].map(name=>`com.sigongnote.app.${name}`);
const runningGroups=new Set();

export function requireHostedEmulator(env=process.env,platform=process.platform){
 if(platform!=='linux'||env.GITHUB_ACTIONS!=='true'||env.RUNNER_ENVIRONMENT!=='github-hosted'||env.RUNNER_OS!=='Linux')throw new Error('DISPOSABLE_HOSTED_LINUX_REQUIRED');
}
export function fixtureEnvironment(input=process.env){
 const env={...input};
 for(const key of Object.keys(env))if(/^(?:ANTHROPIC_|OPENAI_|CLAUDE_|SEMANTIC_|CLOVA_|SHORT_STT_|LONG_STT_|SUPABASE_|E2E_|DATABASE_URL$|WORKER_DATABASE_URL$|MIGRATION_DATABASE_URL$|AI_)/.test(key))delete env[key];
 return {...env,SIGONGNOTE_E2E_DB:'0',SIGONGNOTE_WORK_PREVIEW_PORT:'5190',AI_PROVIDER:'fixture',AI_DAILY_BUDGET_KRW:'0',CLAUDE_AGENT_ENABLED:'false',SHORT_STT_ENABLED:'false',LONG_STT_ENABLED:'false'};
}
export function selectedClasses(raw){
 const classes=raw?.trim()?raw.split(',').map(value=>value.trim()):defaults;
 if(classes.length===0||classes.length>30||classes.some(value=>!/^com\.sigongnote\.app\.[A-Za-z][A-Za-z0-9]*DeviceTest(?:#[A-Za-z][A-Za-z0-9_]*)?$/.test(value)))throw new Error('INVALID_INSTRUMENTATION_CLASSES');
 if(classes.some(value=>value.startsWith(updateClass+'#')))throw new Error('UPDATE_REQUIRES_COMPLETE_TWO_PHASE_TEST');
 return [...new Set(classes)];
}
/** Android's shell can exit 0 for assertion failures or ignored tests. Require actual terminal test statuses. */
export function instrumentationResult(raw,exitCode){
 const diagnostics=[...new Set([...raw.matchAll(/SN_DIAG:(questions\.list|journal\.tasks|agenda\.read|materials\.detail|today):(READ_FAILED|ACCESS_DENIED|REVISION_ROUTE_MISMATCH|UNKNOWN_ALERT)(?![A-Za-z0-9_.-])/g)].map(match=>`${match[1]}:${match[2]}`))].map(value=>{const [route,code]=value.split(':');return {route,code};});
 const codes=[...raw.matchAll(/^INSTRUMENTATION_STATUS_CODE: (-?\d+)\r?$/gm)].map(match=>Number(match[1]));
 const passed=codes.filter(code=>code===0).length,failed=codes.filter(code=>code===-1||code===-2).length,skipped=codes.filter(code=>code===-3||code===-4).length;
 const declared=[...raw.matchAll(/^INSTRUMENTATION_STATUS: numtests=(\d+)\r?$/gm)].map(match=>Number(match[1]));
 const expected=declared.at(-1)??0,total=passed+failed+skipped;
 const complete=exitCode===0&&/^INSTRUMENTATION_CODE: -1\r?$/m.test(raw)&&/OK \(\d+ tests?\)/.test(raw)&&!/^INSTRUMENTATION_(?:FAILED|RESULT: shortMsg=)|FAILURES!!!/m.test(raw);
 // Diagnostics never copy assertion/source values, stack traces, sessions or URLs into the artifact.
 return {status:complete&&expected>0&&total===expected&&passed===expected&&failed===0&&skipped===0?'PASS':'FAIL',tests:total,expected,passed,failed,skipped,
  failure_lines:[...new Set([...raw.matchAll(/(?:WorkScreen|WorkLedger|PhotoCapture|CaptureUpload|UpdateContinuity)DeviceTest\.kt:(\d+)/g)].map(match=>Number(match[1])))],...(diagnostics.length?{diagnostics}:{})};
}
const plannedClasses=()=>selectedClasses(process.env.ANDROID_CLASSES).flatMap(name=>(name===updateClass?['seed','verify']:['single']).map(phase=>({class:name,phase,status:'NOT_RUN',reason:'NOT_EXECUTED',tests:0,expected:null,passed:0,failed:0,skipped:0})));
const initial=()=>({environment:'github_hosted_android_emulator_api34',data:'synthetic_internal_regression',actual_local_auth_storage_api_workers:'NOT_RUN',
 actual_model:'NOT_RUN',physical_device:'NOT_RUN',production_acceptance:'NOT_RUN',fixture:'NOT_RUN',suite:'NOT_RUN',cleanup:'NOT_RUN',classes:plannedClasses()});
const load=()=>existsSync(receiptPath)?JSON.parse(readFileSync(receiptPath,'utf8')):initial();
const save=receipt=>{mkdirSync(output,{recursive:true});writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n');};

async function capture(command,args,{env,timeout=60_000,input}={}){
 return await new Promise(resolveResult=>{
  const child=spawn(command,args,{env:env??fixtureEnvironment(),stdio:['pipe','pipe','pipe'],detached:true});
  if(child.pid)runningGroups.add(child.pid);
  let raw='',reason=null,finished=false;
  const kill=why=>{if(reason)return;reason=why;try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}};
  const timer=setTimeout(()=>kill('TIMEOUT'),timeout);
  const collect=chunk=>{raw+=chunk.toString();if(raw.length>8*1024*1024)kill('OUTPUT_LIMIT');};
  child.stdout.on('data',collect);child.stderr.on('data',collect);child.stdin.on('error',()=>{});child.stdin.end(input);
  const finish=code=>{if(finished)return;finished=true;clearTimeout(timer);runningGroups.delete(child.pid);resolveResult({code,raw,reason});};
  child.on('error',()=>{reason='SPAWN_FAILED';finish(null);});child.on('close',finish);
 });
}
function checked(result,reason){if(result.code!==0||result.reason)throw new Error(reason);return result.raw;}
async function adb(args,options){return capture('adb',args,options);}
async function singleEmulator(){
 const devices=checked(await adb(['devices']),'ADB_UNAVAILABLE').split(/\r?\n/).map(line=>/^(\S+)\s+device$/.exec(line)?.[1]).filter(Boolean);
 if(devices.length!==1||!/^emulator-\d+$/.test(devices[0]))throw new Error('ONE_EPHEMERAL_EMULATOR_REQUIRED');
}
async function wake(){
 for(const command of [['input','keyevent','KEYCODE_WAKEUP'],['wm','dismiss-keyguard'],['settings','put','system','screen_off_timeout','1800000'],['svc','power','stayon','true']])checked(await adb(['shell',...command]),'EMULATOR_WAKE_FAILED');
}
function apk(directory){const files=readdirSync(directory).filter(name=>name.endsWith('.apk'));if(files.length!==1)throw new Error('APK_OUTPUT_AMBIGUOUS');return `${directory}/${files[0]}`;}
async function build(version,includeTest){
 checked(await capture(resolve('apps/android/gradlew'),['-p','apps/android',':app:assembleStandardDebug',...(includeTest?[':app:assembleStandardDebugAndroidTest']:[]),'-PISOLATED_DEVICE_TEST=true',`-PAPP_VERSION_CODE=${version}`,'-PAPP_VERSION_NAME=0.1.0-ci','--no-daemon'],{timeout:9*60_000}),'GRADLE_BUILD_FAILED');
}
async function installTarget(){checked(await adb(['install','-r','-t',apk('apps/android/app/build/outputs/apk/standard/debug')],{timeout:120_000}),'TARGET_INSTALL_FAILED');}
async function instrument(name,phase){
 await wake();
 const result=await adb(['shell','am','instrument','-w','-r','-e','class',name,...(phase?['-e','phase',phase]:[]),runner],{timeout:8*60_000});
 return {class:name,phase:phase??'single',...instrumentationResult(result.raw,result.code),...(result.reason?{failure_code:result.reason}:{})};
}
async function startFixture(){
 mkdirSync(privateRoot,{recursive:true,mode:0o700});
 const child=spawn(process.execPath,['--import','tsx','scripts/serve-work-preview.ts','--android-ci'],{env:fixtureEnvironment(),stdio:['ignore','pipe','pipe'],detached:true});
 let bytes=0;const discard=chunk=>{bytes+=chunk.length;if(bytes>8*1024*1024)try{process.kill(-child.pid,'SIGKILL');}catch{}};
 child.stdout.on('data',discard);child.stderr.on('data',discard);child.on('error',()=>{});
 if(!child.pid)throw new Error('FIXTURE_SPAWN_FAILED');
 writeFileSync(pidPath,JSON.stringify({pid:child.pid}),{mode:0o600});
 const deadline=Date.now()+6*60_000;let added=false;
 while(Date.now()<deadline){
  if(child.exitCode!==null||child.signalCode)throw new Error('FIXTURE_EXITED');
  try{
   const response=await fetch(`${health}/health`,{signal:AbortSignal.timeout(3000)}),status=await response.json();
   if(status.service!=='sigongnote-work-preview'||status.data!=='synthetic-only'||status.lan!==false)throw new Error('FIXTURE_SCOPE_INVALID');
   if(!added){for(const kind of ['audio','message']){const add=await fetch(`${health}/fixture/${kind}`,{method:'POST',headers:{'x-sigongnote-fixture':'1'},signal:AbortSignal.timeout(5000)});if(!add.ok)throw new Error('FIXTURE_SEED_FAILED');}added=true;}
   if(status.ready&&status.workerStatus==='ready'&&added&&existsSync(`${labRoot}/device-session.json`))return;
  }catch(error){if(['FIXTURE_SCOPE_INVALID','FIXTURE_SEED_FAILED'].includes(error.message))throw error;}
  await delay(1000);
 }
 throw new Error('FIXTURE_PARSE_READINESS_TIMEOUT');
}
async function provisionSession(){
 const bytes=readFileSync(`${labRoot}/device-session.json`),session=JSON.parse(bytes);
 if(session.apiBaseUrl!==`http://127.0.0.1:${apiPort}/`||session.supabaseOrigin!==`http://127.0.0.1:${storagePort}`||session.storageOrigin!==session.supabaseOrigin||session.expiresAtEpochMs<Date.now()+20*60_000)throw new Error('FIXTURE_SESSION_SCOPE_INVALID');
 for(const port of [apiPort,storagePort])checked(await adb(['reverse',`tcp:${port}`,`tcp:${port}`]),'ADB_REVERSE_FAILED');
 // The session goes directly to private app storage over stdin; no shared /sdcard copy or token arguments.
 checked(await adb(['shell','run-as',appId,'sh','-c',"'mkdir -p files && cat > files/work-fixture-session.json && chmod 600 files/work-fixture-session.json'"],{input:bytes}),'PRIVATE_SESSION_PUSH_FAILED');
}
async function cleanup(){
 let okay=true;
 for(const pid of runningGroups)try{process.kill(-pid,'SIGKILL');}catch{}
 if(existsSync(pidPath))try{
  const {pid}=JSON.parse(readFileSync(pidPath,'utf8'));
  if(!Number.isSafeInteger(pid)||pid<=1)throw new Error('INVALID_CHILD_PID');
  if(existsSync(`/proc/${pid}/cmdline`)){
   const command=readFileSync(`/proc/${pid}/cmdline`,'utf8');if(!command.includes('scripts/serve-work-preview.ts')||!command.includes('--android-ci'))throw new Error('CHILD_IDENTITY_CHANGED');
   try{process.kill(-pid,'SIGTERM');}catch{}
   for(let attempt=0;attempt<20&&existsSync(`/proc/${pid}`);attempt++)await delay(100);
   // The process group includes Python descendants; terminate any still running after graceful shutdown.
   try{process.kill(-pid,'SIGKILL');}catch{}
  }
 }catch{okay=false;}
 for(const port of [apiPort,storagePort])await adb(['reverse','--remove',`tcp:${port}`],{timeout:5000});
 await adb(['shell','run-as',appId,'rm','-f','files/work-fixture-session.json'],{timeout:5000});
 // Fixed, CI-owned paths only; never follow a caller-supplied cleanup directory.
 for(const path of [privateRoot,labRoot])rmSync(resolve(path),{recursive:true,force:true});
 rmSync(resolve('services/api/.env'),{force:true});
 return okay;
}
export async function main(command=process.argv[2]){
 requireHostedEmulator();
 if(!['--initialize','--run','--cleanup'].includes(command))throw new Error('INVALID_COMMAND');
 if(command==='--initialize'){save(initial());return;}
 if(command==='--cleanup'){const receipt=load();receipt.cleanup=await cleanup()?'PASS':'FAIL';save(receipt);if(receipt.cleanup!=='PASS')process.exitCode=1;return;}
 const receipt=load();let stage='FIXTURE_START';
 const record=result=>{const index=receipt.classes.findIndex(item=>item.class===result.class&&item.phase===result.phase);if(index<0)throw new Error('UNPLANNED_INSTRUMENTATION_RESULT');receipt.classes[index]=result;save(receipt);};
 let cleanupTask;const cleanOnce=()=>cleanupTask??=cleanup();
 // Cancellation still reaches the final cleanup; do not leave the detached fixture or a session behind.
 const interrupted=()=>{receipt.suite='FAIL';receipt.failure_stage=stage;receipt.failure_code='INTERRUPTED_OR_TIME_LIMIT';save(receipt);void cleanOnce().then(okay=>{receipt.cleanup=okay?'PASS':'FAIL';save(receipt);process.exit(1);});};
 process.once('SIGINT',interrupted);process.once('SIGTERM',interrupted);
 const suiteTimer=setTimeout(interrupted,30*60_000);
 try{
  const classes=selectedClasses(process.env.ANDROID_CLASSES);receipt.classes=plannedClasses();
  if(!existsSync('services/api/.env')||JSON.parse(readFileSync('.work/e2e/supabase-integration.json','utf8')).prepare!=='PASS')throw new Error('LOCAL_SUPABASE_NOT_PREPARED');
  receipt.fixture='RUNNING';save(receipt);await startFixture();receipt.fixture='PASS';receipt.actual_local_auth_storage_api_workers='PASS';save(receipt);
  stage='EMULATOR';await singleEmulator();await wake();
  stage='BASE_BUILD';await build(10000,true);stage='BASE_INSTALL';await installTarget();checked(await adb(['install','-r','-t',apk('apps/android/app/build/outputs/apk/androidTest/standard/debug')],{timeout:120_000}),'TEST_INSTALL_FAILED');
  stage='SESSION';await provisionSession();receipt.suite='RUNNING';save(receipt);
  for(const name of classes.filter(value=>value!==updateClass)){
   stage='INSTRUMENTATION';const result=await instrument(name);record(result);
   console.log(`${result.status}: ${name} (${result.passed}/${result.expected} passed, ${result.failed} failed, ${result.skipped} skipped)`);
  }
  if(classes.includes(updateClass)){
   stage='UPDATE_SEED';const seed=await instrument(updateClass,'seed');record(seed);
   if(seed.status==='PASS'){
    stage='UPDATE_BUILD';await build(10001,false);stage='UPDATE_INSTALL';await installTarget();
    stage='UPDATE_VERIFY';record(await instrument(updateClass,'verify'));
   }else receipt.classes.find(item=>item.class===updateClass&&item.phase==='verify').reason='SEED_FAILED';
  }
  receipt.suite=receipt.classes.length>0&&receipt.classes.every(item=>item.status==='PASS')?'PASS':'FAIL';
  if(receipt.suite!=='PASS')process.exitCode=1;
 }catch(error){
  receipt.suite='FAIL';if(receipt.fixture==='RUNNING')receipt.fixture='FAIL';receipt.failure_stage=stage;
  receipt.failure_code=/^[A-Z][A-Z0-9_]*$/.test(error.message)?error.message:'HOSTED_FIXTURE_FAILED';process.exitCode=1;
  console.error(`FAIL: ${stage} (${receipt.failure_code}); private child diagnostics were discarded`);
 }finally{
  process.removeListener('SIGINT',interrupted);process.removeListener('SIGTERM',interrupted);
  clearTimeout(suiteTimer);receipt.cleanup=await cleanOnce()?'PASS':'FAIL';if(receipt.cleanup!=='PASS')process.exitCode=1;save(receipt);
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void main().catch(error=>{console.error(/^[A-Z][A-Z0-9_]*$/.test(error.message)?error.message:'HOSTED_FIXTURE_FAILED');process.exitCode=1;});
