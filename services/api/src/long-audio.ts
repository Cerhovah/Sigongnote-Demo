import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {z} from 'zod';
import {capturePolicyProcessor} from '@sigongnote/contracts';
import {parserEnvironment,type WorkerOptions,type ParseInput} from './parse-worker.js';
import {organizeNext} from './organize-worker.js';
import {audioPrice,audioCostKrw,type AudioPrice} from './product-ai-config.js';
import {reserveProductAi,submitProductAi,finishProductAi,stableRunId,type ProductReservation} from './product-ai.js';
export const AUDIO_PROCESSOR='long-audio-v2';
export const processorForMime=(mime:string)=>mime.startsWith('audio/')?AUDIO_PROCESSOR:'document-python-v1';
const segmentSchema=z.object({start:z.number().int().nonnegative(),end:z.number().int().positive(),text:z.string().trim().min(1).max(1000),speaker:z.object({label:z.string().max(30)}).optional()});
export type AudioSegment=z.infer<typeof segmentSchema>;
export class AudioNotAccepted extends Error {constructor(){super('AUDIO_NOT_ACCEPTED');}}
export class AudioResultInvalid extends Error {constructor(readonly receipt:string){super('AUDIO_RESULT_INVALID');}}
export type AudioProvider={name:'clova'|'openai'|'synthetic';billing?:AudioPrice|undefined;submit:(bytes:Uint8Array,signal:AbortSignal)=>Promise<string|{receipt:string;segments:AudioSegment[]}>;poll:(receipt:string,signal:AbortSignal)=>Promise<{status:'waiting'|'completed'|'failed';segments?:AudioSegment[]}>};
type Chunk={index:number;startMs:number;endMs:number;sha256:string;bytes:number;status?:'submitting'|'provider_wait'|'completed'|'ambiguous'|'failed';receipt?:string;submittedAt?:number;attemptToken?:string;rejections?:number;segments?:AudioSegment[]};
type State={phase:string;excerptTruncated?:boolean;reason?:string|undefined;fixture?:boolean;chunks:Chunk[];sourceHash?:string;decoderVersion?:string;durationMs?:number;codec?:string;channels?:number;provider?:string};
export type AudioOptions=WorkerOptions&{audioProvider?:AudioProvider|undefined;audioTenantSeconds?:number;audioGlobalSeconds?:number};

/** No arbitrary URL or webhook. Async OBS storage must be covered by the registered policy. */
export function clovaProvider(env:NodeJS.ProcessEnv):AudioProvider|undefined{
 if(env.LONG_STT_ENABLED!=='true'||env.LONG_STT_OBS_CONFIGURED!=='true'||!env.CLOVA_SPEECH_KEY||!env.CLOVA_SPEECH_INVOKE_URL)return;
 let url:URL;try{url=new URL(env.CLOVA_SPEECH_INVOKE_URL);}catch{return;}
 if(url.protocol!=='https:'||url.hostname!=='clovaspeech-gw.ncloud.com'||url.port||url.username||url.password||url.search||url.hash||!/^\/external\/v1\/[a-zA-Z0-9/_-]+$/.test(url.pathname))return;
 const base=url.href.replace(/\/$/,'');
 const request=async(path:string,init:RequestInit,signal:AbortSignal)=>{
  let response:Response;
  try{response=await fetch(base+path,{...init,headers:{'X-CLOVASPEECH-API-KEY':env.CLOVA_SPEECH_KEY!},signal:AbortSignal.any([signal,AbortSignal.timeout(120000)]),redirect:'error'});}
  catch(error){if(['ENOTFOUND','ECONNREFUSED','EAI_AGAIN'].includes(String((error as {cause?:{code?:string}}).cause?.code)))throw new AudioNotAccepted();throw error;}
  if([400,401,403,404,413,415,422,429].includes(response.status))throw new AudioNotAccepted();
  if(!response.ok||!response.body)throw new Error('AUDIO_PROVIDER_WAIT');
  let count=0;const parts:Uint8Array[]=[];for await(const part of response.body){count+=part.length;if(count>2097152)throw new Error('AUDIO_RESPONSE_LIMIT');parts.push(part);}
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
 };
 return {name:'clova',billing:audioPrice(env.LONG_STT_PRICE_JSON,'clova-speech'),async submit(bytes,signal){const form=new FormData();form.set('media',new Blob([new Uint8Array(bytes)],{type:'audio/wav'}),'audio.wav');form.set('params',JSON.stringify({language:'ko-KR',completion:'async',resultToObs:true,wordAlignment:true,fullText:false,diarization:{enable:true}}));
  const value=await request('/recognizer/upload',{method:'POST',body:form},signal);return z.string().min(1).max(300).regex(/^[\w-]+$/).parse(value.token);},
 async poll(receipt,signal){const value=await request('/recognizer/'+encodeURIComponent(receipt),{method:'GET'},signal);
  if(['WAITING','PROCESSING'].includes(value.result))return {status:'waiting'};
  if(value.result!=='COMPLETED')return {status:'failed'};
  return {status:'completed',segments:z.array(segmentSchema).max(3000).parse(Array.isArray(value.segments)?value.segments.filter((s:{text?:unknown})=>typeof s?.text==='string'&&s.text.trim()):value.segments)};
 }};
}

export async function prepareAudio(bytes:Uint8Array,options:Pick<WorkerOptions,'python'|'pythonRoot'>,signal:AbortSignal,legacy=false){
 const directory=await mkdtemp(join(tmpdir(),'sigongnote-audio-'));
 try{
  const path=join(directory,'original');await writeFile(path,bytes,{mode:0o600});
  const raw=await new Promise<string>((done,reject)=>{const child=spawn(options.python,['-m','sigongnote_worker'],{cwd:resolve(options.pythonRoot),windowsHide:true,env:parserEnvironment(options.pythonRoot),stdio:['pipe','pipe','pipe'],signal});let output='';let length=0;
   child.stdout.setEncoding('utf8');child.stdout.on('data',(s:string)=>{length+=Buffer.byteLength(s);if(length>65536)child.kill();else output+=s;});child.stderr.resume();child.on('error',()=>reject(new Error('AUDIO_DECODER_UNAVAILABLE')));child.on('close',code=>code===0&&length<=65536?done(output):reject(new Error('AUDIO_DECODER_FAILED')));child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({action:'audio_prepare',path,directory,overlap_ms:legacy?0:1000})+'\n');});
  const parsed=JSON.parse(raw) as State&{status:string};
  if(parsed.status!=='ready')return {state:{phase:'held',reason:parsed.reason??'audio_decode_failed',chunks:[]} as State,read:async()=>new Uint8Array(),dispose:()=>rm(directory,{recursive:true,force:true})};
  if(parsed.sourceHash!==createHash('sha256').update(bytes).digest('hex')||!Array.isArray(parsed.chunks)||parsed.chunks.length>12||!parsed.chunks.length)throw new Error('AUDIO_HASH_MISMATCH');
  return {state:{...parsed,phase:'processing'} as State,read:async(index:number)=>new Uint8Array(await readFile(join(directory,`chunk-${index}.wav`))),dispose:()=>rm(directory,{recursive:true,force:true})};
 }catch(error){await rm(directory,{recursive:true,force:true});throw error;}
}

export function audioEvidence(state:State){
 const all=state.chunks.flatMap(c=>(c.segments??[]).map((s,index)=>({text:s.text,locator:`audio:${c.startMs+s.start}-${c.startMs+s.end}:${state.decoderVersion?.endsWith('overlap-v2')?c.index*3000+index:index}`,position:{audio_start_ms:c.startMs+s.start,audio_end_ms:c.startMs+s.end,speaker:s.speaker?`${c.index+1}구간 ${s.speaker.label}`:null,chunk_index:c.index}}))).sort((a,b)=>a.position.audio_start_ms-b.position.audio_start_ms||a.locator.localeCompare(b.locator));
 // Overlap only deduplicates the same words at the same time, never repeated later speech.
 const seen=new Map<string,typeof all>();
 const unique=all.filter(s=>{const key=s.text.replace(/\s+/g,' ').trim(),prior=seen.get(key)??[];const duplicate=prior.some(p=>p.position.chunk_index!==s.position.chunk_index&&p.position.audio_start_ms<s.position.audio_end_ms&&s.position.audio_start_ms<p.position.audio_end_ms);prior.push(s);seen.set(key,prior);return !duplicate;});
 return unique.map((s,ordinal)=>({...s,ordinal,contentHash:createHash('sha256').update(s.text).digest('hex')}));
}
export function audioOutput(state:State){
 const all=audioEvidence(state).map(s=>({text:s.text,locator:s.locator,speaker:s.position.speaker}));
 const spans:typeof all=[];let bytes=0;
 for(const item of all){bytes+=Buffer.byteLength(JSON.stringify(item));if(spans.length>=1000||bytes>2097152)break;spans.push(item);}
 const incomplete=state.chunks.some(c=>c.status!=='completed'),truncated=spans.length!==all.length;
 return {sourceHash:state.sourceHash,processorVersion:AUDIO_PROCESSOR,schemaVersion:'parse-output-v1',parserVersion:'timed-stt-v2',decoderVersion:state.decoderVersion,modelVersion:state.provider,promptVersion:null,
  status:incomplete?'partial':'complete',spans,excerptTruncated:truncated,evidence:{schemaVersion:'evidence-chunks-v1',chunkCount:all.length,parserVersion:'timed-stt-v2',sourceStatus:incomplete?'partial':'complete',completeExtractedText:true,coverage:{audio_segments:all.length,audio_duration_ms:state.durationMs??0}},issues:['stt_unconfirmed',...(state.fixture?['synthetic_transcript']:[]),...(incomplete?['audio_chunks_incomplete']:[])]};
}

/** Durable receipts survive process restarts. A lost submission response is never submitted twice. */
export async function runLongAudioOnce(options:AudioOptions):Promise<string>{
 const {db}=options;
 const claim=async(processor:string)=>options.tenantScope?await db`select * from app.claim_parse_job_for_tenant(${options.owner??'audio'},60,${processor},${options.tenantScope}::uuid)`:await db`select * from app.claim_parse_job(${options.owner??'audio'},60,${processor})`;
 const lease=(await claim(AUDIO_PROCESSOR))[0]??(await claim('long-audio-v1'))[0];
 if(!lease)return 'idle';const t=String(lease.tenant_id),j=String(lease.job_id),token=String(lease.lease_token);
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),options.timeoutMs??480000),signal=controller.signal;let prepared:Awaited<ReturnType<typeof prepareAudio>>|undefined;
 let heartBusy=false;
 const heart=setInterval(()=>{if(heartBusy)return;heartBusy=true;void db`select app.extend_parse_job_lease(${t}::uuid,${j}::uuid,${token}::uuid,60) ok`.then(r=>{if(!r[0]?.ok)controller.abort();},()=>controller.abort()).finally(()=>{heartBusy=false;});},15000);
 const save=async(state:State,wait:number|null=null)=>{const [r]=await db`select app.audio_save(${t}::uuid,${j}::uuid,${token}::uuid,${db.json(options.policy)},${db.json(state)},${wait}::int) ok`;if(!r?.ok)throw new Error('AUDIO_STALE');};
 const finish=async(state:State):Promise<string>=>{
   const output=audioOutput(state);output.processorVersion=String(lease.processor_version);state.excerptTruncated=output.excerptTruncated;
   await save(state);
   const [begun]=await db`select app.begin_evidence_index(${t}::uuid,${j}::uuid,${token}::uuid,${db.json(output.evidence)},${db.json(options.policy)}) ok`;
   if(!begun?.ok)throw Error('AUDIO_STALE');
   const evidence=audioEvidence(state);
   for(let offset=0;offset<evidence.length;offset+=100){const [saved]=await db`select app.stage_evidence_chunks(${t}::uuid,${j}::uuid,${token}::uuid,${db.json(evidence.slice(offset,offset+100))},${db.json(options.policy)}) ok`;if(!saved?.ok)throw Error('AUDIO_STALE');}
   const [corrected]=await db`select app.stage_audio_corrections(${t}::uuid,${j}::uuid,${token}::uuid,${db.json(options.policy)}) ok`;if(!corrected?.ok)throw Error('AUDIO_STALE');
   const [done]=await db`select app.complete_parse_output(${t}::uuid,${j}::uuid,${token}::uuid,${db.json(output)},${db.json(options.policy)}) ok`;
   if(done?.ok){try{await organizeNext(options);}catch{/* durable output is retried by the organization queue */}return 'stored';}return 'stale';
 };
 try{
  const [loaded]=await db`select app.audio_load(${t}::uuid,${j}::uuid,${token}::uuid,${db.json(options.policy)}) state`;
  let state=loaded?.state as State|undefined;
  if(!state){await db`select app.fail_parse_job(${t}::uuid,${j}::uuid,${token}::uuid,'AUDIO_SCOPE_REQUIRED',false)`;return 'held';}
  if(['complete','partial'].includes(state.phase)&&state.chunks.length&&state.chunks.every(c=>['completed','failed','ambiguous'].includes(c.status??'')))return await finish(state);
  const provider=options.audioProvider;
  const paidProvider=provider&&provider.name!=='synthetic',policyProvider=provider?.name==='openai'?'openai':'clova_speech';
  if(!provider||(paidProvider&&capturePolicyProcessor(options.policy,'long_stt')?.provider!==policyProvider)||(provider.name==='synthetic'&&(options.policy.external_processing||options.policy.provider!=='local_fixture'))){state.phase='waiting';state.reason='audio_provider_required';await save(state,300);return 'waiting';}
  if(state.provider&&state.provider!==provider.name){state.phase='held';state.reason='audio_provider_changed';await save(state,-1);return 'held';}
  if(state.phase==='waiting'&&state.reason==='audio_existing_wait'){await save(state,30);return 'waiting';}
  if(state.phase==='held'){await save(state,-1);return 'held';}
  const pending=state.chunks.find(c=>!c.status);
  if(paidProvider&&((options.audioTenantSeconds??0)<=0||(options.audioGlobalSeconds??0)<=0||((!state.chunks.length||pending)&&!pending?.rejections))){
   const [budget]=await db`select app.audio_budget(${t}::uuid,${j}::uuid,${token}::uuid,${db.json(options.policy)},${options.audioTenantSeconds??0},${options.audioGlobalSeconds??0}) seconds`;
   if(Number(budget?.seconds??0)<(pending?Math.ceil((pending.endMs-pending.startMs)/1000):1)){state.phase='waiting';state.reason='audio_budget_wait';await save(state,3600);return 'waiting';}
  }
  if(!state.chunks.length||state.chunks.some(c=>!c.status)){
   const [input]=await db`select * from app.parse_job_input(${t}::uuid,${j}::uuid,${token}::uuid,${db.json(options.policy)})`;
   if(!input)throw new Error('AUDIO_STALE');const bytes=await options.download(input as ParseInput,AbortSignal.any([signal,AbortSignal.timeout(120000)]));
   if(bytes.length!==Number(input.byte_length)||createHash('sha256').update(bytes).digest('hex')!==input.sha256)throw new Error('AUDIO_HASH_MISMATCH');
   prepared=await prepareAudio(bytes,options,AbortSignal.any([signal,AbortSignal.timeout(180000)]),state.chunks.length>0&&!state.decoderVersion?.endsWith("overlap-v2"));
   if(prepared.state.phase==='held'){await save(prepared.state,-1);return 'held';}
   if(!state.chunks.length)state={...prepared.state,provider:provider.name,fixture:provider.name==='synthetic'};
   else if(state.chunks.some((c,i)=>c.sha256!==prepared!.state.chunks[i]?.sha256))throw new Error('AUDIO_HASH_MISMATCH');
   await save(state);
  }
  state.phase='processing';delete state.reason;
  for(const chunk of state.chunks){
   signal.throwIfAborted();
   if(chunk.status==='submitting'){chunk.status=chunk.segments?'completed':chunk.receipt&&provider.name!=='openai'?'provider_wait':'ambiguous';if(chunk.status==='ambiguous')continue;}
   if(!chunk.status){
    let paid:ProductReservation|undefined;
    const chunkBytes=await prepared!.read(chunk.index);if(createHash('sha256').update(chunkBytes).digest('hex')!==chunk.sha256)throw new Error('AUDIO_HASH_MISMATCH');
    if(paidProvider){
     if(!provider.billing||Date.parse(provider.billing.valid_until)<=Date.now()){state.reason='audio_price_required';await save(state,300);return 'waiting';}
     const [reserved]=await db`select app.audio_reserve(${t}::uuid,${j}::uuid,${token}::uuid,${db.json(options.policy)},${chunk.index},${Math.ceil((chunk.endMs-chunk.startMs)/1000)},${options.audioTenantSeconds??0},${options.audioGlobalSeconds??0}) ok`;
     if(reserved?.ok==='stale')throw new Error('AUDIO_STALE');
     if(reserved?.ok==='duplicate_wait'){state.phase='waiting';state.reason='audio_existing_wait';await save(state,30);return 'waiting';}
     if(reserved?.ok==='duplicate'){state.phase='held';state.reason='audio_duplicate_held';await save(state,-1);return 'held';}
     if(reserved?.ok!=='ok'){state.reason='audio_budget_wait';break;}
     const [scopeRow]=await db`select app.audio_product_scope(${t}::uuid,${j}::uuid,${token}::uuid,${db.json(options.policy)}) value`;
     const scope=scopeRow?.value;if(!scope)throw new Error('AUDIO_SCOPE_REQUIRED');
     const seconds=Math.ceil((chunk.endMs-chunk.startMs)/1000);
     paid={...scope,id:stableRunId(`${t}:${j}:${chunk.index}:${chunk.rejections??0}`),channel:'long_stt',hash:chunk.sha256,krw:audioCostKrw(provider.billing,seconds),config:{policy:options.policy,policy_provider:policyProvider,provider:provider.name,model:provider.billing.model,price:provider.billing,job_id:j,chunk:chunk.index,attempt:chunk.rejections??0,seconds}};
     const funds=await reserveProductAi(db,paid!);
     if(funds.state!=='reserved'){state.reason=funds.state==='budget_paused'?'audio_budget_wait':'audio_submission_unknown';await save(state,funds.state==='budget_paused'?3600:-1);return 'waiting';}
    }
    chunk.status='submitting';chunk.submittedAt=Date.now();chunk.attemptToken=token;await save(state);
    let received=false;
    try{if(paid&&!await submitProductAi(db,paid))throw new Error('AUDIO_SUBMISSION_FENCED');
     const submitted=await provider.submit(chunkBytes,signal);chunk.receipt=typeof submitted==='string'?submitted:submitted.receipt;
     received=typeof submitted!=='string';
     if(typeof submitted!=='string'){chunk.segments=validatedSegments(submitted.segments,chunk);chunk.status='completed';}
     await db`select app.audio_record_receipt(${t}::uuid,${j}::uuid,${token}::uuid,${chunk.index},${chunk.receipt})`;
     if(paid)await finishProductAi(db,paid,paid.krw,null,chunk.receipt,{pricing:'duration_estimate',accepted:true});
     if(typeof submitted==='string')chunk.status='provider_wait';
    }catch(error){
     if(error instanceof AudioResultInvalid){received=true;chunk.receipt=error.receipt;await db`select app.audio_record_receipt(${t}::uuid,${j}::uuid,${token}::uuid,${chunk.index},${chunk.receipt})`;}
     if(paid)await finishProductAi(db,paid,error instanceof AudioNotAccepted?0:received?paid.krw:null,null,chunk.receipt??null,{error_code:error instanceof AudioNotAccepted?'NOT_ACCEPTED':received?'AUDIO_RESULT_INVALID':'AUDIO_OUTCOME_UNKNOWN'});
     if(received&&!chunk.segments){chunk.status='failed';state.reason='audio_result_invalid';}
     else if(chunk.receipt)chunk.status=chunk.segments?'completed':provider.name==='openai'?'ambiguous':'provider_wait';
     else if(error instanceof AudioNotAccepted){chunk.rejections=(chunk.rejections??0)+1;delete chunk.status;delete chunk.receipt;if(chunk.rejections>=3)chunk.status='failed';state.reason='audio_provider_rejected';}
     else chunk.status='ambiguous';
    }
    // At most one new upload per lease. Polling/next uploads get their own time allowance.
    await save(state,state.reason==='audio_provider_rejected'?60:1);return 'waiting';
   }
   if(chunk.status==='provider_wait'){
    // Re-check current permission immediately before every provider interaction.
    await save(state);
    try{const result=await provider.poll(chunk.receipt!,signal);
     if(result.status==='completed'){
      chunk.segments=validatedSegments(result.segments,chunk);chunk.status='completed';
     }else if(result.status==='failed')chunk.status='failed';
     else if(Date.now()-(chunk.submittedAt??0)>86400000)chunk.status='failed';
    }catch{/* A known receipt is polled again; never upload it again. */}
    if(chunk.status==='provider_wait'&&Date.now()-(chunk.submittedAt??0)>86400000)chunk.status='failed';
    await save(state);
   }
  }
  if(state.chunks.every(c=>c.status==='completed'||c.status==='failed'||c.status==='ambiguous')){
   state.phase=state.chunks.every(c=>c.status==='completed')?'complete':'partial';state.reason=state.chunks.some(c=>c.status==='ambiguous')?'audio_submission_unknown':state.chunks.some(c=>c.status==='failed'&&c.receipt&&provider.name==='openai')?'audio_result_invalid':state.phase==='partial'?'audio_chunks_incomplete':undefined;
   return await finish(state);
  }
  await save(state,state.reason==='audio_budget_wait'?3600:15);return 'waiting';
 }catch{
  await db`select app.fail_parse_job(${t}::uuid,${j}::uuid,${token}::uuid,'AUDIO_RETRY',true)`;return 'retry';
 }finally{clearInterval(heart);clearTimeout(timer);controller.abort();await prepared?.dispose();}
}

function validatedSegments(value:unknown,chunk:Chunk){const segments=z.array(segmentSchema).max(3000).parse(value),duration=chunk.endMs-chunk.startMs;
 if(segments.some(s=>s.end<=s.start))throw new Error('AUDIO_TIME_INVALID');
 const seen=new Set<string>();return segments.filter(s=>s.start<duration).map(s=>({...s,end:Math.min(s.end,duration)})).filter(s=>{const key=JSON.stringify([s.start,s.end,s.text]);if(seen.has(key))return false;seen.add(key);return true;});}
