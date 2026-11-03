import {openAiLongStt} from './long-stt-openai.js';
import {runPhotoSheetOnce} from './photo-sheet-worker.js';
import {runBusinessEventsOnce} from './business-events.js';
import {runLongAudioOnce,clovaProvider} from './long-audio.js';
import {loadProductLocalEnvironment,productAiConfig} from './product-ai-config.js';
import {runSemanticOnce} from './semantic-worker.js';
import {runRenderOnce} from "./document-render-worker.js";
import { readFileSync } from "node:fs";
import {startWorkerHeartbeat} from './worker-health.js';
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
import { CapturePolicySchema } from "@sigongnote/contracts";
import { assertWorkerRole, runParseOnce, workerOwner } from "./parse-worker.js";
import { ORIGINAL_BUCKET } from "./storage.js";
import {configuredPdfBatchPages} from './pdf-continuation.js';

// Private environment only. Run from repository root. Local config is explicit,
// never silently fall back from an operational worker to development credentials.
async function main(){
 const local=process.argv.includes("--local");
 if(local){const {verifyLocalDevelopmentDb}=await import("../../../scripts/db-gate.mjs");
  if((await verifyLocalDevelopmentDb()).status!=="READY")throw new Error("LOCAL_DB_REQUIRED");
  const {parseStrictLocalEnv}=await import("../../../scripts/local-env-values.mjs");
  const env=parseStrictLocalEnv(readFileSync("services/api/.env","utf8"));
  for(const key of ["WORKER_DATABASE_URL","SUPABASE_URL","SUPABASE_SECRET_KEY"])if(env[key])process.env[key]=env[key];
 }
 const required=(key:string)=>{const value=process.env[key];if(!value)throw new Error("WORKER_CONFIG_REQUIRED");return value;};
 if(local){const productEnv={...process.env,APP_ENV:'development'};loadProductLocalEnvironment(productEnv);Object.assign(process.env,productEnv);}
 const pdfBatchPages=configuredPdfBatchPages(process.env.WORKER_PDF_BATCH_PAGES);
 const policy=local&&!process.env.CAPTURE_POLICY_JSON?(await import("./capture-scope.js")).LOCAL_CAPTURE_POLICY:CapturePolicySchema.parse(JSON.parse(required("CAPTURE_POLICY_JSON")));
 const url=required("SUPABASE_URL");const u=new URL(url);
 if(!local&&u.protocol!=="https:")throw new Error("HTTPS_REQUIRED");
 const db=postgres(required("WORKER_DATABASE_URL"),{max:3,prepare:false,connect_timeout:5,onnotice:()=>{},
  ...(local?{}:{ssl:{rejectUnauthorized:true,ca:readFileSync(required("DATABASE_CA_FILE"),"utf8")}})});
 const storage=createClient(url,required("SUPABASE_SECRET_KEY"),{auth:{persistSession:false,autoRefreshToken:false}}).storage.from(ORIGINAL_BUCKET);
 let stopping=false;for(const signal of ["SIGINT","SIGTERM"] as const)process.once(signal,()=>{stopping=true;});
 const heartbeat=startWorkerHeartbeat(process.env.WORKER_HEARTBEAT_FILE);
 try{
  await assertWorkerRole(db);
  const [schema]=await db`select count(*)::int missing from unnest(array['app.claim_parse_job(text,integer,text)','app.claim_render_job(text,uuid)',
   'app.pdf_parse_progress(uuid,uuid,uuid,jsonb)','app.begin_pdf_evidence_batch(uuid,uuid,uuid,integer,jsonb,jsonb)','app.checkpoint_pdf_parse(uuid,uuid,uuid,integer,jsonb,jsonb)',
   'app.claim_photo_sheet(text,uuid)','app.claim_business_outbox(uuid)']) as required(signature)
    where to_regprocedure(signature) is null or not has_function_privilege(current_user,to_regprocedure(signature),'EXECUTE')`;
  if(schema?.missing!==0)throw new Error('WORKER_SCHEMA_NOT_READY');
  let semantic:ReturnType<typeof productAiConfig>;try{semantic=productAiConfig();}catch{semantic=undefined;}
  const options={db,policy,semantic,pdfBatchPages,audioProvider:process.env.LONG_STT_PROVIDER==='openai'?openAiLongStt(process.env):(!process.env.LONG_STT_PROVIDER||process.env.LONG_STT_PROVIDER==='clova')?clovaProvider(process.env):undefined,audioTenantSeconds:Number(process.env.LONG_STT_TENANT_SECONDS??0),audioGlobalSeconds:Number(process.env.LONG_STT_GLOBAL_SECONDS??0),owner:workerOwner(),python:process.env.DOCUMENT_PYTHON??resolve("services/document-worker/.venv",process.platform==="win32"?"Scripts/python.exe":"bin/python"),
   pythonRoot:resolve("services/document-worker"),download:async(input:import("./parse-worker.js").ParseInput,signal:AbortSignal)=>{
    const {data,error}=await storage.createSignedUrl(input.storage_key,60);if(error||!data)throw new Error("STORAGE_WAIT");
    const response=await fetch(new URL(data.signedUrl,url),{signal,redirect:"error"});
    if(!response.ok||!response.body)throw new Error("STORAGE_WAIT");
    const chunks:Uint8Array[]=[];let size=0;
    for await(const chunk of response.body){size+=chunk.length;if(size>Number(input.byte_length)||size>209715200){await response.body.cancel().catch(()=>{});throw new Error("SOURCE_HASH_MISMATCH");}chunks.push(chunk);}
    return Buffer.concat(chunks);
   }};
  console.log("Parse worker ready");
  heartbeat.setState('ready');
  const tasks:Array<()=>Promise<unknown>>=[()=>runPhotoSheetOnce(options),()=>runParseOnce(options),()=>runLongAudioOnce(options),()=>runSemanticOnce(options),()=>runBusinessEventsOnce(options),()=>runRenderOnce({...options,timeoutMs:45000,...(process.env.SIGONGNOTE_PDF_FONT_PATH?{fontPath:process.env.SIGONGNOTE_PDF_FONT_PATH}:{})})];
  const taskNames=['photo','parse','audio','semantic','business','render'];for(const name of taskNames)heartbeat.setTaskState(name,'ready');
  const run=async(task:()=>Promise<unknown>)=>{const name=taskNames[tasks.indexOf(task)]!;try{heartbeat.setTaskState(name,'working');const result=await task();heartbeat.setTaskState(name,result==='retry'?'retry_wait':'ready');if(result!=='stored'&&result!=='continued')await delay(result==='idle'?1500:5000);}catch{heartbeat.setTaskState(name,'dependency_wait');if(process.argv.includes('--once'))throw new Error('WORKER_RETRY');await delay(5000);}};
  if(process.env.WORKER_SERIAL==='true'){
    do{for(const task of tasks){if(stopping)break;await run(task);}}while(!stopping&&!process.argv.includes('--once'));
  }else{
    await Promise.all(tasks.map(async task=>{do{await run(task);}while(!stopping&&!process.argv.includes('--once'));}));
  }

 }finally{heartbeat.stop();await db.end({timeout:5});}
}
void main().catch(()=>{console.error("Parse worker stopped: check private configuration and local diagnostics");process.exitCode=1;});
