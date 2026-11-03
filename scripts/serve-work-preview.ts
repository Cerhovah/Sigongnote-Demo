import {syntheticMessage} from './work-preview-message.js';
import {MESSAGE_MIME} from '../services/api/src/message-bundle.js';
import {runLongAudioOnce} from '../services/api/src/long-audio.js';
import {syntheticAudio,syntheticAudioProvider} from './work-preview-audio.js';
import {startOwnerMemory} from '../services/api/src/owner-memory.js';
import {startAgentWorker} from '../services/api/src/agent-runs.js';
import {startDocumentReadiness} from '../services/api/src/document-readiness.js';
import {runRenderOnce} from "../services/api/src/document-render-worker.js";
/** Synthetic-only integration lab. Never attach customer folders or real logins. */
import {addDocumentFixtures,addWorkDecisionFixtures,seedDocumentAgreement} from "./work-preview-documents.js";
import { readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync } from "node:fs";
import { resolve,join } from "node:path";
import { createHash,randomUUID,randomBytes,generateKeyPairSync } from "node:crypto";
import { networkInterfaces } from "node:os";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
import { WorkRequestSchema,workHttp } from "@sigongnote/contracts";
import { parseStrictLocalEnv } from "./local-env-values.mjs";
import { verifyLocalDevelopmentDb } from "./db-gate.mjs";
import { createApp } from "../services/api/src/app.js";
import { createTokenVerifier } from "../services/api/src/auth.js";
import { createStorageGateway,ORIGINAL_BUCKET } from "../services/api/src/storage.js";
import { LOCAL_CAPTURE_POLICY } from "../services/api/src/capture-scope.js";
import { runParseOnce } from "../services/api/src/parse-worker.js";

/** A second checkout can run beside the usual 5190 lab: SIGONGNOTE_WORK_PREVIEW_PORT=5290 uses 5290 and API 5291. */
const port=Number(process.env.SIGONGNOTE_WORK_PREVIEW_PORT??5190),apiPort=port+1;
if(!Number.isInteger(port)||port<1024||port>65000)throw new Error("Invalid preview port");
const androidCi=process.argv.includes('--android-ci');
if(androidCi&&(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted'||process.env.RUNNER_OS!=='Linux'||process.argv.includes('--lan')||process.env.AI_PROVIDER!=='fixture'||process.env.AI_DAILY_BUDGET_KRW!=='0'))throw new Error('Disposable offline Android fixture required');
const windowsFixture=process.argv.includes('--windows-fixture'),connectedFixture=androidCi||windowsFixture;
if(windowsFixture&&(process.platform!=='win32'||androidCi||port!==5290||process.argv.includes('--lan')||process.env.AI_PROVIDER!=='fixture'||process.env.AI_DAILY_BUDGET_KRW!=='0'))throw new Error('Loopback offline Windows fixture required');
async function main(){
 if((await verifyLocalDevelopmentDb()).status!=="READY")throw new Error("Local DB required");
 const root=resolve(windowsFixture?'.work/windows-work-preview':port===5190?".work/work-preview":`.work/work-preview-${port}`),folder=join(root,"synthetic-folder");mkdirSync(folder,{recursive:true});
 const env=parseStrictLocalEnv(readFileSync("services/api/.env","utf8"));
 const admin=postgres(env.MIGRATION_DATABASE_URL!,{max:1,onnotice:()=>{}}),db=postgres(env.DATABASE_URL!,{max:4}),worker=postgres(env.WORKER_DATABASE_URL!,{max:3});
 const authOptions={auth:{persistSession:false,autoRefreshToken:false}};
 const auth=createClient(env.SUPABASE_URL!,env.SUPABASE_SECRET_KEY!,authOptions);
 const statePath=join(root,"private.json");
 type State={user:string;tenant:string;device:string;password:string;email:string;captures:Record<string,string>;source?:string;audioSource?:string;messageSource?:string;androidDevice?:string;androidSource?:string;project?:string;documentFixtureVersion?:number;workDecisionFixtureVersion?:number};
 let state:State;
 if(existsSync(statePath))state=JSON.parse(readFileSync(statePath,"utf8"));
 else{
  const email=`work-preview-${randomUUID()}@example.invalid`,password=randomBytes(32).toString("hex");
  const {data,error}=await auth.auth.admin.createUser({email,password,email_confirm:true});if(error||!data.user)throw new Error("Fixture auth unavailable");
  state={user:data.user.id,tenant:randomUUID(),device:randomUUID(),password,email,captures:{}};
  await admin`insert into app.tenants(id,display_name) values(${state.tenant}::uuid,'합성 햇살현장 회사')`;
  await admin`insert into app.memberships(tenant_id,user_id,role) values(${state.tenant}::uuid,${state.user}::uuid,'owner')`;
  writeFileSync(statePath,JSON.stringify(state),{mode:0o600});
 }
 const client=createClient(env.SUPABASE_URL!,env.SUPABASE_PUBLISHABLE_KEY!,authOptions);
 const login=await client.auth.signInWithPassword({email:state.email,password:state.password});if(login.error||!login.data.session)throw new Error("Fixture auth unavailable");
 let session=login.data.session;
 const verify=createTokenVerifier(env.SUPABASE_URL!,env.SUPABASE_PUBLISHABLE_KEY!);
 const services={db,capturePolicy:LOCAL_CAPTURE_POLICY,storage:createStorageGateway(env.SUPABASE_URL!,env.SUPABASE_SECRET_KEY!),verifyToken:async(token:string)=>{const principal=await verify(token);return principal?.userId===state.user?principal:null;},...(connectedFixture?{agentRuntime:true}:{})};
 const api=createApp(services);
 startOwnerMemory(api,db);
 // Connected fixtures exercise the same durable tools and document workers, with no model configuration.
 if(connectedFixture){startAgentWorker(api,services);startDocumentReadiness(api,services);}
 await api.listen({host:"127.0.0.1",port:apiPort});
 const headers=()=>({authorization:`Bearer ${session.access_token}`,"x-tenant-id":state.tenant,"idempotency-key":randomUUID()});
 const setup=async(url:string,payload:object)=>{const reply=await api.inject({method:"POST",url,headers:headers(),payload});if(![200,201].includes(reply.statusCode))throw new Error("Fixture setup unavailable");return reply.json();};
 if(!state.source){
  const publicKey=generateKeyPairSync("ec",{namedCurve:"P-256"}).publicKey.export({format:"jwk"});
  state.device=(await setup("/v1/devices",{platform:"windows",app_version:"work-preview",public_key_jwk:{kty:"EC",crv:"P-256",x:publicKey.x,y:publicKey.y}})).id;
  state.project=(await setup("/v1/projects",{display_name:"합성 햇살현장"})).id;
  state.source=(await setup("/v1/capture-sources",{device_id:state.device,kind:"folder",scope_fingerprint:"d".repeat(64),consent_version:2,local_selection_consent:true,server_upload_consent:true,external_ai_consent:false,
   scope:{capture_method:"filesystem",history_mode:"all",history_since:null,scope_mode:"work_dedicated",rule_version:1,processing_policy_id:LOCAL_CAPTURE_POLICY.id,fingerprint_algorithm:"hmac-sha256-device-v1"}})).id;
  await setup("/v1/site-folder-bindings",{source_id:state.source,source_generation:1,scope_fingerprint:"d".repeat(64),scope_mode:"project",project_id:state.project});
  writeFileSync(statePath,JSON.stringify(state),{mode:0o600});
 }
 if(!state.audioSource){state.audioSource=(await setup("/v1/capture-sources",{device_id:state.device,kind:"call_recording",scope_fingerprint:"a".repeat(64),consent_version:2,local_selection_consent:true,server_upload_consent:true,external_ai_consent:false,scope:{capture_method:"filesystem",history_mode:"all",history_since:null,scope_mode:"work_dedicated",rule_version:1,processing_policy_id:LOCAL_CAPTURE_POLICY.id,fingerprint_algorithm:"hmac-sha256-device-v1"}})).id;
 await setup("/v1/site-folder-bindings",{source_id:state.audioSource,source_generation:1,scope_fingerprint:"a".repeat(64),scope_mode:"project",project_id:state.project});writeFileSync(statePath,JSON.stringify(state),{mode:0o600});}
 if(!state.messageSource){state.messageSource=(await setup("/v1/capture-sources",{device_id:state.device,kind:"manual_share",scope_fingerprint:"e".repeat(64),consent_version:2,local_selection_consent:true,server_upload_consent:true,external_ai_consent:false,scope:{capture_method:"manual_share",history_mode:"selected",history_since:null,scope_mode:"selected_items",rule_version:1,processing_policy_id:LOCAL_CAPTURE_POLICY.id,fingerprint_algorithm:"hmac-sha256-device-v1"}})).id;writeFileSync(statePath,JSON.stringify(state),{mode:0o600});}
 if(androidCi&&!state.androidSource){
  const publicKey=generateKeyPairSync('ec',{namedCurve:'P-256'}).publicKey.export({format:'jwk'});
  state.androidDevice=(await setup('/v1/devices',{platform:'android',app_version:'hosted-synthetic-fixture',public_key_jwk:{kty:'EC',crv:'P-256',x:publicKey.x,y:publicKey.y}})).id;
  state.androidSource=(await setup('/v1/capture-sources',{device_id:state.androidDevice,kind:'manual_share',scope_fingerprint:'f'.repeat(64),consent_version:2,local_selection_consent:true,server_upload_consent:true,external_ai_consent:false,scope:{capture_method:'manual_share',history_mode:'selected',history_since:null,scope_mode:'selected_items',rule_version:1,processing_policy_id:LOCAL_CAPTURE_POLICY.id,fingerprint_algorithm:'hmac-sha256-device-v1'}})).id;
  await setup('/v1/site-folder-bindings',{source_id:state.androidSource,source_generation:1,scope_fingerprint:'f'.repeat(64),scope_mode:'project',project_id:state.project});
  writeFileSync(statePath,JSON.stringify(state),{mode:0o600});
 }
 const addMessage=()=>writeFileSync(join(folder,`sample-${Date.now()}-${randomUUID().slice(0,6)}.message`),syntheticMessage());
 const addAudio=()=>writeFileSync(join(folder,`sample-${Date.now()}-${randomUUID().slice(0,6)}.wav`),syntheticAudio());
 // Fixture session is private local test input, never served by either HTTP listener.
 const deviceClient=createClient(env.SUPABASE_URL!,env.SUPABASE_PUBLISHABLE_KEY!,authOptions);
 const deviceLogin=await deviceClient.auth.signInWithPassword({email:state.email,password:state.password});
 if(deviceLogin.error||!deviceLogin.data.session)throw new Error("Fixture device auth unavailable");
 const deviceAuth=deviceLogin.data.session;
 const deviceSession={apiBaseUrl:`http://127.0.0.1:${apiPort}/`,supabaseOrigin:env.SUPABASE_URL,storageOrigin:env.SUPABASE_URL,publishableKey:env.SUPABASE_PUBLISHABLE_KEY,
  accessToken:deviceAuth.access_token,refreshToken:deviceAuth.refresh_token,expiresAtEpochMs:deviceAuth.expires_at!*1000,tenantId:state.tenant,userId:state.user,deviceId:androidCi?state.androidDevice:state.device,manualSourceId:androidCi?state.androidSource:state.messageSource,manualGeneration:1,connectedAtEpochMs:Date.now()};
 writeFileSync(join(root,"device-session.json"),JSON.stringify(deviceSession),{mode:0o600});
 let deliveryEvidence:{revisionId:string;title:string}|undefined;
 const bucket=auth.storage.from(ORIGINAL_BUCKET);
 const add=()=>{const name=`sample-${Date.now()}-${randomUUID().slice(0,6)}.txt`;writeFileSync(join(folder,name),`합성 햇살현장 납품 ${new Date().toLocaleTimeString("ko-KR")}\n작업: 주방 보수\n석고보드 12개\n발주수량: 10 개\n인수수량: 8 개\n금액·지급 여부는 아직 확인하지 않았습니다.\n이 자료는 개발 확인용 합성자료입니다.`,"utf8");};
 if(!readdirSync(folder).length)add();
 if(state.documentFixtureVersion!==1){addDocumentFixtures(folder);state.documentFixtureVersion=1;writeFileSync(statePath,JSON.stringify(state),{mode:0o600});}
 if(state.workDecisionFixtureVersion!==1){addWorkDecisionFixtures(folder);state.workDecisionFixtureVersion=1;writeFileSync(statePath,JSON.stringify(state),{mode:0o600});}
 let stopping=false,workerStatus="starting",lastHealthyAt=0,lastProbeAt=0,dependenciesReady=false,fixtureReady=!connectedFixture;
 const run=async()=>{while(!stopping){
  if(Date.now()-lastProbeAt>15000){lastProbeAt=Date.now();try{
   const statuses=await Promise.all([fetch(`${env.SUPABASE_URL}/auth/v1/health`,{signal:AbortSignal.timeout(5000)}),fetch(`${env.SUPABASE_URL}/storage/v1/status`,{signal:AbortSignal.timeout(5000)})]);
   if(statuses.some(r=>!r.ok))throw new Error("Fixture dependencies unavailable");
   await db`select 1`;lastHealthyAt=Date.now();dependenciesReady=true;
  }catch{dependenciesReady=false;}}
  try{
  if((session.expires_at??0)*1000-Date.now()<300000){const refreshed=await client.auth.refreshSession(session);if(refreshed.error||!refreshed.data.session)throw new Error("Fixture session expired");session=refreshed.data.session;}
  for(const name of readdirSync(folder).filter(n=>/^sample-[0-9]+-[a-f0-9]{6}\.(txt|wav|message)$/.test(n)).slice(0,100)){
   if(state.captures[name])continue;const bytes=readFileSync(join(folder,name));if(bytes.length>100000)continue;const mime=name.endsWith(".message")?MESSAGE_MIME:name.endsWith(".wav")?"audio/wav":"text/plain";
   const hash=createHash("sha256").update(bytes).digest("hex");const key=hash.slice(0,8)+"-"+hash.slice(8,12)+"-4"+hash.slice(13,16)+"-a"+hash.slice(17,20)+"-"+hash.slice(20,32);
   const prepared=await api.inject({method:"POST",url:"/v1/ingestions",headers:{...headers(),"idempotency-key":key},payload:{client_capture_id:key,sha256:hash,byte_length:bytes.length,declared_mime:mime,source_id:mime===MESSAGE_MIME?state.messageSource:mime==="audio/wav"?state.audioSource:state.source,source_generation:1}});
   if(prepared.statusCode!==201)throw new Error("Prepare failed");const receipt=prepared.json();
   const upload=await bucket.uploadToSignedUrl(`${state.tenant}/${receipt.ingestion_id}`,new URL(receipt.upload_url).searchParams.get("token")!,bytes,{contentType:mime});
   // A prior successful upload can be completed again without overwriting it.
   if(upload.error&&upload.error.message!=="The resource already exists")throw new Error("Upload failed");
   const completed=await api.inject({method:"POST",url:`/v1/ingestions/${receipt.ingestion_id}/complete`,headers:headers(),payload:{sha256:hash,byte_length:bytes.length}});
   if(completed.statusCode!==200)throw new Error("Complete failed");state.captures[name]=completed.json().revision_id;writeFileSync(statePath,JSON.stringify(state),{mode:0o600});
  }
  // Private connected-device test metadata comes from the uploaded TXT and its real completion receipt.
  // Audio shares the delivery title prefix, so a prefix alone cannot identify this original.
  if(connectedFixture&&!deliveryEvidence){for(const [name,revisionId] of Object.entries(state.captures)){
   if(!name.endsWith('.txt'))continue;const text=readFileSync(join(folder,name),'utf8'),title=text.split(/\r?\n/,1)[0]!;
   if(title.startsWith('합성 햇살현장 납품 ')&&text.split(/\r?\n/).includes('석고보드 12개')){
    deliveryEvidence={revisionId,title};writeFileSync(join(root,'device-session.json'),JSON.stringify({...deviceSession,fixtureEvidence:{delivery:deliveryEvidence}}),{mode:0o600});break;
   }
  }}
  const audioOptions={db:worker,policy:LOCAL_CAPTURE_POLICY,tenantScope:state.tenant,owner:"audio-preview",python:resolve("services/document-worker/.venv",process.platform==="win32"?"Scripts/python.exe":"bin/python"),pythonRoot:resolve("services/document-worker"),audioProvider:syntheticAudioProvider,download:async(input:import("../services/api/src/parse-worker.js").ParseInput,signal:AbortSignal)=>{const {data}=await bucket.download(input.storage_key);if(!data||signal.aborted)throw new Error("Storage wait");return new Uint8Array(await data.arrayBuffer());}};
  await runLongAudioOnce(audioOptions);
  await runParseOnce({db:worker,policy:LOCAL_CAPTURE_POLICY,tenantScope:state.tenant,owner:"work-preview",python:resolve("services/document-worker/.venv",process.platform==="win32"?"Scripts/python.exe":"bin/python"),pythonRoot:resolve("services/document-worker"),download:async(input,signal)=>{
   const signed=await bucket.createSignedUrl(input.storage_key,60);if(signed.error||!signed.data)throw new Error("Storage wait");
   const response=await fetch(new URL(signed.data.signedUrl,env.SUPABASE_URL),{signal,redirect:"error"});if(!response.ok)throw new Error("Storage wait");return new Uint8Array(await response.arrayBuffer());
  }});
 await seedDocumentAgreement(admin,state);
 await runRenderOnce({db:worker,tenantScope:state.tenant,owner:"preview-render",python:resolve("services/document-worker/.venv",process.platform==="win32"?"Scripts/python.exe":"bin/python"),pythonRoot:resolve("services/document-worker")});
 if(connectedFixture){const [ready]=await admin`select
  count(distinct r.id) filter(where r.declared_mime='text/plain')>=9 text_ready,
  count(distinct r.id) filter(where r.declared_mime='audio/wav')>=1 audio_ready,
  count(distinct r.id) filter(where r.declared_mime=${MESSAGE_MIME})>=1 message_ready,
  exists(select 1 from app.billing_agreements where tenant_id=${state.tenant}::uuid) agreement_ready
  from app.document_revisions r join app.parse_results p on p.tenant_id=r.tenant_id and p.revision_id=r.id
  join app.evidence_index e on e.tenant_id=r.tenant_id and e.revision_id=r.id
  where r.tenant_id=${state.tenant}::uuid and p.output->>'status' in ('complete','partial')`;
   fixtureReady=!!ready?.text_ready&&!!ready.audio_ready&&!!ready.message_ready&&!!ready.agreement_ready&&!!deliveryEvidence;
 }
 workerStatus="ready";
 }catch{workerStatus="retry_wait";/* Never expose source or credentials in health. */}await delay(1500);}};
 const lan=process.argv.includes("--lan"),hosts=new Set([`127.0.0.1:${port}`,`localhost:${port}`]);
 if(lan)for(const addresses of Object.values(networkInterfaces()))for(const address of addresses??[])if(address.family==="IPv4"&&!address.internal)hosts.add(`${address.address}:${port}`);
 let added=0;const web=join(root,"web");
 const server=createServer(async(req,res)=>{try{
  res.setHeader("Cache-Control","no-store");res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("Content-Security-Policy","default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'none'; object-src 'none'");
  const host=req.headers.host??"";if(!hosts.has(host)){res.writeHead(403).end();return;}
  const url=new URL(req.url??"/",`http://${host}`);
  if(url.pathname==="/favicon.ico"){res.writeHead(204).end();return;}
  if(url.pathname==="/health"){res.setHeader("Content-Type","application/json");res.end(JSON.stringify({service:"sigongnote-work-preview",data:"synthetic-only",ready:dependenciesReady&&fixtureReady&&Date.now()-lastHealthyAt<30000,workerStatus,lastHealthyAt: lastHealthyAt?new Date(lastHealthyAt).toISOString():null,lan,urls:[...hosts].filter(h=>!h.startsWith("localhost")).map(h=>`http://${h}/?work=fixture`)}));return;}
  if(req.method==="POST"&&["/fixture/work","/fixture/create","/fixture/audio","/fixture/message"].includes(url.pathname)){
   if(req.headers["x-sigongnote-fixture"]!=="1"||(req.headers.origin&&req.headers.origin!==`http://${host}`)){res.writeHead(403).end();return;}
   let raw="";for await(const chunk of req){raw+=chunk;if(raw.length>1100000){res.writeHead(413).end();return;}}
   if(url.pathname==="/fixture/message"){if(++added>30){res.writeHead(429).end();return;}addMessage();res.setHeader("Content-Type","application/json");res.end("{}");return;}
   if(url.pathname==="/fixture/audio"){if(++added>30){res.writeHead(429).end();return;}addAudio();res.setHeader("Content-Type","application/json");res.end("{}");return;}
   if(url.pathname==="/fixture/create"){if(++added>30){res.writeHead(429).end();return;}add();res.setHeader("Content-Type","application/json");res.end("{}");return;}
   const input=WorkRequestSchema.parse(JSON.parse(raw));const call=workHttp(input);const result=await api.inject({method:call.method,url:call.path,headers:{...headers(),...(call.key?{"idempotency-key":call.key}:{})},...(call.body?{payload:call.body}:{})});
   if(input.route==="materials.original"&&result.statusCode===200){res.setHeader("Content-Type","application/json");res.end(JSON.stringify({...result.json(),url:`http://${host}/fixture-original/${input.id}`}));return;}
   res.writeHead(result.statusCode,{"Content-Type":"application/json"}).end(result.body);return;
  }
  if(req.method==="GET"&&/^\/fixture-original\/[a-f0-9-]{36}$/.test(url.pathname)){
   const id=url.pathname.split("/").pop();const signed=await api.inject({url:`/v1/work/materials/${id}/original`,headers:headers()});if(signed.statusCode!==200){res.writeHead(404).end();return;}
   const file=await fetch(signed.json().url,{signal:AbortSignal.timeout(30000),redirect:"error"});if(!file.ok){res.writeHead(503).end();return;}
   res.setHeader("Content-Type",signed.json().mime==="text/plain"?"text/plain; charset=utf-8":signed.json().mime);res.setHeader("Content-Disposition","inline");res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("Content-Security-Policy","sandbox");res.end(Buffer.from(await file.arrayBuffer()));return;
  }
  if(req.method!=="GET"&&req.method!=="HEAD"){res.writeHead(405).end();return;}
  if(url.pathname==="/"){res.writeHead(302,{Location:"/index.html?work=fixture"}).end();return;}
  const path=url.pathname==="/index.html"?"index.html":/^\/assets\/[a-zA-Z0-9_-]+\.(js|css)$/.test(url.pathname)?url.pathname.slice(1):null;
  if(!path){res.writeHead(404).end();return;}const stored=readFileSync(join(web,path));const content=path==="index.html"?stored.toString("utf8").replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/,""):stored;res.setHeader("Content-Type",path.endsWith(".js")?"text/javascript":path.endsWith(".css")?"text/css":"text/html; charset=utf-8");res.end(req.method==="HEAD"?undefined:content);
 }catch{res.writeHead(503).end("Fixture unavailable");}});
 server.listen(port,lan?"0.0.0.0":"127.0.0.1");void run();
 for(const signal of ["SIGINT","SIGTERM"] as const)process.once(signal,()=>{stopping=true;server.close();void api.close();void Promise.all([admin.end(),db.end(),worker.end()]);});
 console.log(`READY http://127.0.0.1:${port}/?work=fixture`);
}
void main().catch(()=>{console.error(`Work preview unavailable; check local DB and ports ${port}/${apiPort}`);process.exitCode=1;});
