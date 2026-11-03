import {deleteFixtureTenants} from './fixture-cleanup.js';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {parserEnvironment} from '../services/api/src/parse-worker.js';
import {randomUUID,createHash,generateKeyPairSync} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import postgres from 'postgres';
import {createClient} from '@supabase/supabase-js';
import {createApp} from '../services/api/src/app.js';
import {LOCAL_CAPTURE_POLICY} from '../services/api/src/capture-scope.js';
import {createStorageGateway,ORIGINAL_BUCKET} from '../services/api/src/storage.js';
import {prepareAudio,runLongAudioOnce,audioOutput,clovaProvider,AudioNotAccepted,type AudioProvider} from '../services/api/src/long-audio.js';
import {syntheticAudio,syntheticAudioProvider} from '../scripts/work-preview-audio.js';
import {parseStrictLocalEnv} from '../scripts/local-env-values.mjs';
import {verifyLocalDevelopmentDb} from '../scripts/db-gate.mjs';
const python={python:resolve('services/document-worker/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),pythonRoot:resolve('services/document-worker')};
test('D11 actual decoder preserves original/hash and bounded timed output',async()=>{
 const prepared=await prepareAudio(syntheticAudio(),python,AbortSignal.timeout(15000));try{assert.equal(prepared.state.durationMs,3000);assert.equal(prepared.state.chunks.length,1);assert.equal(prepared.state.codec,'pcm_s16le');assert.deepEqual(await prepared.read(0),new Uint8Array(syntheticAudio()));}finally{await prepared.dispose();}
 const invalid=await prepareAudio(Buffer.from('not audio'),python,AbortSignal.timeout(15000));try{assert.equal(invalid.state.phase,'held');}finally{await invalid.dispose();}
 assert.equal(clovaProvider({}),undefined);
 assert.equal(clovaProvider({LONG_STT_ENABLED:'true',LONG_STT_OBS_CONFIGURED:'true',CLOVA_SPEECH_KEY:'synthetic',CLOVA_SPEECH_INVOKE_URL:'https://example.invalid/external/v1/test'}),undefined);
 const result=audioOutput({phase:'complete',chunks:[{index:1,startMs:600000,endMs:601000,sha256:'a'.repeat(64),bytes:2,status:'completed',segments:[{start:0,end:1000,text:'숫자 미확인'}]}]});assert.equal(result.spans[0]?.locator,'audio:600000-601000:0');assert.ok(result.issues.includes('stt_unconfirmed'));
});
test('D11 Storage → real decode → durable receipt restart → search/original/correction, ambiguity and tenant/consent fences',async()=>{
 assert.equal((await verifyLocalDevelopmentDb()).status,'READY');const env=parseStrictLocalEnv(readFileSync('services/api/.env','utf8'));
 const admin=postgres(env.MIGRATION_DATABASE_URL!,{max:1,onnotice:()=>{}}),db=postgres(env.DATABASE_URL!,{max:3}),worker=postgres(env.WORKER_DATABASE_URL!,{max:3});
 const storage=createClient(env.SUPABASE_URL!,env.SUPABASE_SECRET_KEY!,{auth:{persistSession:false,autoRefreshToken:false}}).storage.from(ORIGINAL_BUCKET);
 const tenant=randomUUID(),user=randomUUID(),session=randomUUID(),objects:string[]=[];
 const app=createApp({db,capturePolicy:LOCAL_CAPTURE_POLICY,verifyToken:async()=>({userId:user,sessionId:session}),storage:createStorageGateway(env.SUPABASE_URL!,env.SUPABASE_SECRET_KEY!)});
 const headers={authorization:'Bearer fixture','x-tenant-id':tenant};const call=(url:string,payload?:object)=>app.inject({method:payload?'POST':'GET',url,headers:{...headers,'idempotency-key':randomUUID()},...(payload?{payload}:{})});
 try{
  await admin`insert into auth.users(id) values(${user}::uuid)`;await admin`insert into auth.sessions(id,user_id) values(${session}::uuid,${user}::uuid)`;await admin`insert into app.tenants(id,display_name) values(${tenant}::uuid,'D11 synthetic')`;await admin`insert into app.memberships(tenant_id,user_id,role) values(${tenant}::uuid,${user}::uuid,'owner')`;
  const jwk=generateKeyPairSync('ec',{namedCurve:'P-256'}).publicKey.export({format:'jwk'});
  const device=await call('/v1/devices',{platform:'windows',app_version:'D11-test',public_key_jwk:{kty:'EC',crv:'P-256',x:jwk.x,y:jwk.y}});assert.equal(device.statusCode,201,device.body);
  const source=await call('/v1/capture-sources',{device_id:device.json().id,kind:'call_recording',scope_fingerprint:'a'.repeat(64),consent_version:2,local_selection_consent:true,server_upload_consent:true,external_ai_consent:false,scope:{capture_method:'filesystem',history_mode:'all',history_since:null,scope_mode:'work_dedicated',rule_version:1,processing_policy_id:LOCAL_CAPTURE_POLICY.id,fingerprint_algorithm:'hmac-sha256-device-v1'}});assert.equal(source.statusCode,201,source.body);
  const ingest=async(variant=0,provided?:Buffer,mime="audio/wav")=>{const bytes=provided??syntheticAudio();if(variant)bytes.writeInt16LE(variant,44);const hash=createHash('sha256').update(bytes).digest('hex');const r=await call('/v1/ingestions',{client_capture_id:randomUUID(),sha256:hash,byte_length:bytes.length,declared_mime:mime,source_id:source.json().id,source_generation:1});assert.equal(r.statusCode,201,r.body);const key=`${tenant}/${r.json().ingestion_id}`;objects.push(key);assert.ifError((await storage.uploadToSignedUrl(key,new URL(r.json().upload_url).searchParams.get('token')!,bytes,{contentType:mime})).error);const done=await call(`/v1/ingestions/${r.json().ingestion_id}/complete`,{sha256:hash,byte_length:bytes.length});assert.equal(done.statusCode,200,done.body);return done.json();};
  const first=await ingest();const options={...python,db:worker,policy:LOCAL_CAPTURE_POLICY,tenantScope:tenant,download:async(input:{storage_key:string})=>{const r=await storage.download(input.storage_key);assert.ifError(r.error);return new Uint8Array(await r.data!.arrayBuffer());}};
  assert.equal(await runLongAudioOnce(options),'waiting');
  assert.equal((await call(`/v1/work/materials/${first.revision_id}`)).json().audio.reason,'audio_provider_required');
  const due=()=>admin`update app.jobs set available_at=now() where tenant_id=${tenant}::uuid and state='retry_wait'`;
  const finish=async(config:Parameters<typeof runLongAudioOnce>[0])=>{for(let i=0;i<12;i++){await due();const result=await runLongAudioOnce(config);if(result!=='waiting')return result;}throw new Error('Audio did not finish');};
  let uploads=0,polls=0;const provider:AudioProvider={name:'synthetic',submit:async(b,s)=>{uploads++;return syntheticAudioProvider.submit(b,s);},poll:async(r,s)=>{polls++;return polls===1?{status:'waiting'}:syntheticAudioProvider.poll(r,s);}};
  await due();assert.equal(await runLongAudioOnce({...options,audioProvider:provider}),'waiting');assert.equal(uploads,1);
  // New worker invocation has no transient files/provider state. Receipt must be reused.
  await due();assert.equal(await runLongAudioOnce({...options,audioProvider:provider}),'waiting');assert.equal(uploads,1);
  await due();assert.equal(await runLongAudioOnce({...options,audioProvider:provider}),'stored');assert.equal(uploads,1);
  const detail=await call(`/v1/work/materials/${first.revision_id}`);assert.equal(detail.statusCode,200,detail.body);assert.equal(detail.json().audio.phase,'complete');assert.equal(detail.json().audio.completed,1);assert.equal(detail.json().result.output.spans[1].locator,'audio:1000-2000:1');assert.ok(!JSON.stringify(detail.json()).includes('synthetic-tone-v1'));
  assert.equal((await call('/v1/work/materials?q=석고보드')).json().materials.length,1);assert.equal((await call(`/v1/work/materials/${first.revision_id}/original`)).statusCode,200);
  const correction={revision_id:first.revision_id,client_command_id:randomUUID(),locator:'audio:2000-3000:2',text:'석고보드 도착은 내일 확인',expected_id:null};assert.equal((await call('/v1/work/audio/corrections',correction)).statusCode,200);assert.equal((await call('/v1/work/audio/corrections',correction)).statusCode,200);assert.equal((await call('/v1/work/audio/corrections',{...correction,client_command_id:randomUUID(),text:'경쟁 수정'})).statusCode,409);
  const corrected=(await call(`/v1/work/materials/${first.revision_id}`)).json();assert.equal(corrected.corrections[0].text,correction.text);assert.equal((await call('/v1/work/materials?q=도착')).json().materials.length,1);assert.equal(corrected.result.output.spans[2].text,correction.text);
  assert.equal((await admin`select output from app.parse_results where tenant_id=${tenant}::uuid and revision_id=${first.revision_id}::uuid and processor_version='long-audio-v2'`)[0]?.output.spans[2].text,detail.json().result.output.spans[2].text);
  assert.equal((await db`select * from app.audio_corrections`).length,0);await assert.rejects(worker`select * from app.audio_work`,/permission denied/);await assert.rejects(db`select * from app.audio_reservations`,/permission denied/);
  const reused=await ingest();assert.equal(await runLongAudioOnce({...options,audioProvider:provider}),'stored');assert.equal(uploads,1,'same audio hash reuses immutable transcript');assert.equal((await call(`/v1/work/materials/${reused.revision_id}`)).json().audio.phase,'complete');
  const second=await ingest(1);let ambiguousCalls=0;assert.equal(await finish({...options,audioProvider:{...syntheticAudioProvider,async submit(){ambiguousCalls++;throw new Error('lost response');}}}),'stored');assert.equal(ambiguousCalls,1);assert.equal((await call(`/v1/work/materials/${second.revision_id}`)).json().audio.reason,'audio_submission_unknown');assert.equal(await runLongAudioOnce({...options,audioProvider:syntheticAudioProvider}),'idle');
  const partialCopy=await ingest(1);assert.equal(await finish({...options,audioProvider:syntheticAudioProvider}),'stored');assert.equal((await call(`/v1/work/materials/${partialCopy.revision_id}`)).json().audio.phase,'partial');
  const paid=await ingest(2);let paidCalls=0;
  const paidPolicy={...LOCAL_CAPTURE_POLICY,external_processing:true,provider:'clova_speech'};
  await admin`update app.capture_sources set processing_policy=${admin.json(paidPolicy)},external_ai_consent=true where tenant_id=${tenant}::uuid`;
  const paidProvider:AudioProvider={...syntheticAudioProvider,name:'clova',billing:{version:'synthetic-price-v1',model:'clova-speech',krw_per_minute:30,valid_until:'2099-01-01T00:00:00Z'},async submit(){paidCalls++;return 'synthetic-tone-v1';}};
  assert.equal(await runLongAudioOnce({...options,download:async()=>{throw new Error('Zero budget must not download');},policy:paidPolicy,audioProvider:paidProvider,audioTenantSeconds:0,audioGlobalSeconds:0}),'waiting');await due();
  assert.equal(await runLongAudioOnce({...options,policy:paidPolicy,audioProvider:paidProvider,audioTenantSeconds:2,audioGlobalSeconds:10}),'waiting');assert.equal(paidCalls,0,'budget blocks before upload');
  await due();assert.equal(await finish({...options,policy:paidPolicy,audioProvider:paidProvider,audioTenantSeconds:3,audioGlobalSeconds:100}),'stored');assert.equal(paidCalls,1);
  assert.equal((await admin`select count(*)::int n from app.audio_reservations where tenant_id=${tenant}::uuid and job_id=${paid.job_id}::uuid`)[0]?.n,1);
  await admin`update app.capture_sources set processing_policy=${admin.json(LOCAL_CAPTURE_POLICY)},external_ai_consent=false where tenant_id=${tenant}::uuid`;
  const retry=await ingest(3);await admin`update app.capture_sources set processing_policy=${admin.json(paidPolicy)},external_ai_consent=true where tenant_id=${tenant}::uuid`;
  let rejections=0;const rejecting:AudioProvider={...paidProvider,async submit(){if(++rejections===1)throw new AudioNotAccepted();return 'synthetic-tone-v1';}};
  assert.equal(await finish({...options,policy:paidPolicy,audioProvider:rejecting,audioTenantSeconds:30,audioGlobalSeconds:100}),'stored');assert.equal(rejections,2);
  assert.equal((await admin`select count(*)::int n from app.audio_reservations where tenant_id=${tenant}::uuid and job_id=${retry.job_id}::uuid`)[0]?.n,1,'known rejection reuses own reservation');
  await admin`update app.capture_sources set processing_policy=${admin.json(LOCAL_CAPTURE_POLICY)},external_ai_consent=false where tenant_id=${tenant}::uuid`;
  const timed=await ingest(7),openPolicy={...LOCAL_CAPTURE_POLICY,external_processing:true,provider:'openai'};let timedCalls=0;
  await admin`update app.capture_sources set processing_policy=${admin.json(openPolicy)},external_ai_consent=true where tenant_id=${tenant}::uuid`;
  const timedProvider:AudioProvider={name:'openai',billing:{version:'synthetic-price',model:'whisper-1',krw_per_minute:30,valid_until:'2099-01-01T00:00:00Z'},async submit(){timedCalls++;return {receipt:'timed-accepted',segments:[{start:0,end:30000,text:'인수 여부 미확인'},{start:3000,end:30000,text:'패딩 뒤 환각'}]};},async poll(){throw Error('sync result must be durable');}};
  assert.equal(await finish({...options,policy:openPolicy,audioProvider:timedProvider,audioTenantSeconds:60,audioGlobalSeconds:100}),'stored');assert.equal(timedCalls,1);
  const [usage]=await admin`select state,actual_krw,config from app.product_ai_usage where tenant_id=${tenant}::uuid and revision_id=${timed.revision_id}::uuid and channel='long_stt'`;assert.equal(usage!.state,'settled');assert.equal(usage!.config.model,'whisper-1');assert.ok(Number(usage!.actual_krw)>0);
  const timedPage=(await call(`/v1/evidence/${timed.revision_id}/chunks`)).json();assert.equal(timedPage.chunks.length,1);assert.equal(timedPage.chunks[0].locator,'audio:0-3000:0');
  await admin`update app.capture_sources set processing_policy=${admin.json(LOCAL_CAPTURE_POLICY)},external_ai_consent=false where tenant_id=${tenant}::uuid`;
  const invalidTimed=await ingest(10);await admin`update app.capture_sources set processing_policy=${admin.json(openPolicy)},external_ai_consent=true where tenant_id=${tenant}::uuid`;
  let invalidCalls=0;assert.equal(await finish({...options,policy:openPolicy,audioTenantSeconds:60,audioGlobalSeconds:100,audioProvider:{...timedProvider,async submit(){invalidCalls++;return {receipt:'invalid-time',segments:[{start:1000,end:500,text:'시간 역전'}]};}}}),'stored');assert.equal(invalidCalls,1);
  assert.equal((await call(`/v1/work/materials/${invalidTimed.revision_id}`)).json().audio.reason,'audio_result_invalid');
  const [invalidUsage]=await admin`select state,actual_krw from app.product_ai_usage where tenant_id=${tenant}::uuid and revision_id=${invalidTimed.revision_id}::uuid and channel='long_stt'`;assert.equal(invalidUsage!.state,'settled');assert.ok(Number(invalidUsage!.actual_krw)>0);
  await admin`update app.capture_sources set processing_policy=${admin.json(LOCAL_CAPTURE_POLICY)},external_ai_consent=false where tenant_id=${tenant}::uuid`;
  const old=await ingest(8);await admin`update app.jobs set processor_version='long-audio-v1',state='succeeded' where tenant_id=${tenant}::uuid and id=${old.job_id}::uuid`;
  await admin`insert into app.audio_work(tenant_id,job_id,revision_id,state) select a.tenant_id,${old.job_id}::uuid,${old.revision_id}::uuid,jsonb_set(a.state,'{sourceHash}',to_jsonb(j.input_hash)) from app.audio_work a join app.jobs j on j.tenant_id=a.tenant_id and j.id=${old.job_id}::uuid where a.tenant_id=${tenant}::uuid and a.job_id=${first.job_id}::uuid`;
  await admin`insert into app.audio_corrections(tenant_id,revision_id,command_id,locator,text,actor_id) values(${tenant}::uuid,${old.revision_id}::uuid,${randomUUID()}::uuid,'audio:2000-3000:2','기존 교정 보존',${user}::uuid)`;
  await admin`insert into app.jobs(tenant_id,job_type,evidence_revision_id,processor_version,input_hash) select tenant_id,job_type,evidence_revision_id,'long-audio-v2',input_hash from app.jobs where tenant_id=${tenant}::uuid and id=${old.job_id}::uuid`;
  assert.equal(await runLongAudioOnce({...options,download:async()=>{throw Error('stored backfill must not download');}}),'stored');
  const oldPage=await call(`/v1/evidence/${old.revision_id}/chunks`);assert.equal(oldPage.json().chunks[2].text,'기존 교정 보존');assert.equal(oldPage.json().chunks[2].position.original_text,detail.json().result.output.spans[2].text);
  const changedProvider=await ingest(9);await admin`insert into app.audio_work(tenant_id,job_id,revision_id,state) values(${tenant}::uuid,${changedProvider.job_id}::uuid,${changedProvider.revision_id}::uuid,'{"phase":"waiting","chunks":[],"backfillOnly":true}')`;
  await admin`update app.capture_sources set processing_policy=${admin.json(openPolicy)},external_ai_consent=true where tenant_id=${tenant}::uuid`;
  assert.equal(await runLongAudioOnce({...options,policy:openPolicy,audioProvider:timedProvider,audioTenantSeconds:60,audioGlobalSeconds:100,download:async()=>{throw Error('backfill must never decode with a changed provider');}}),'held');assert.equal(timedCalls,1);
  await admin`update app.capture_sources set processing_policy=${admin.json(LOCAL_CAPTURE_POLICY)},external_ai_consent=false where tenant_id=${tenant}::uuid`;
  const truncated=await ingest(4);assert.equal(await finish({...options,audioProvider:{name:'synthetic',async submit(){return {receipt:'many',segments:Array.from({length:1001},(_,i)=>({start:i,end:i+1,text:'인식 후보 '+i}))};},async poll(){throw Error('Synchronous result must not be polled');}}}),'stored');const longDetail=(await call(`/v1/work/materials/${truncated.revision_id}`)).json();assert.equal(longDetail.audio.truncated,true);assert.equal(longDetail.audio.phase,'complete');assert.equal(longDetail.result.output.spans.length,1000);
  let cursor:string|null=null;const all:{ordinal:number;text:string;locator:string}[]=[];let firstCursor:string|null=null;
  do{const page=await call(`/v1/evidence/${truncated.revision_id}/chunks${cursor?'?cursor='+cursor:''}`);assert.equal(page.statusCode,200,page.body);assert.equal(page.json().indexed_chunks,1001);all.push(...page.json().chunks);cursor=page.json().next_cursor;firstCursor??=cursor;}while(cursor);
  assert.equal(all.length,1001);assert.equal(all.at(-1)?.text,'인식 후보 1000');assert.equal(new Set(all.map(c=>c.ordinal)).size,1001);
  assert.equal((await call('/v1/work/materials?q=후보 1000')).json().materials.length,1);
  const tailCorrection={revision_id:truncated.revision_id,client_command_id:randomUUID(),locator:all.at(-1)!.locator,text:'맨 뒤에서 교정한 인수 수량',expected_id:null};
  const tailSaved=await call('/v1/work/audio/corrections',tailCorrection);assert.equal(tailSaved.statusCode,200,tailSaved.body);
  assert.equal((await call(`/v1/evidence/${truncated.revision_id}/chunks?cursor=${firstCursor}`)).statusCode,409);
  assert.equal((await call('/v1/work/materials?q=맨 뒤에서')).json().materials.length,1);
  const longBytes=Buffer.alloc(44+32000*1201);syntheticAudio().copy(longBytes,0,0,44);longBytes.writeUInt32LE(longBytes.length-8,4);longBytes.writeUInt32LE(longBytes.length-44,40);
  const longJob=await ingest(0,longBytes);let slowSubmits=0;
  const slow:AudioProvider={name:'synthetic',async submit(){slowSubmits++;await new Promise(r=>setTimeout(r,700));return 'slow-'+slowSubmits;},async poll(){return {status:'completed',segments:[{start:0,end:500,text:'긴 녹음 모의 구간'}]};}};
  for(let i=0;i<5;i++){await due();const before=slowSubmits;const r=await runLongAudioOnce({...options,audioProvider:slow,timeoutMs:4000});assert.ok(slowSubmits-before<=1,'one new upload per lease');if(r==='stored')break;assert.equal(r,'waiting');}
  assert.equal(slowSubmits,3);const longProgress=(await call(`/v1/work/materials/${longJob.revision_id}`)).json().audio;assert.equal(longProgress.phase,'complete');assert.equal(longProgress.completed,3);
  const pendingPaid=await ingest(6);await admin`update app.capture_sources set processing_policy=${admin.json(paidPolicy)},external_ai_consent=true where tenant_id=${tenant}::uuid`;
  assert.equal(await runLongAudioOnce({...options,policy:paidPolicy,audioProvider:paidProvider,audioTenantSeconds:100,audioGlobalSeconds:100}),'waiting');
  await admin`update app.jobs set available_at='2099-01-01' where tenant_id=${tenant}::uuid and id=${pendingPaid.job_id}::uuid`;
  await admin`update app.capture_sources set processing_policy=${admin.json(LOCAL_CAPTURE_POLICY)},external_ai_consent=false where tenant_id=${tenant}::uuid`;const duplicate=await ingest(6);
  await admin`update app.capture_sources set processing_policy=${admin.json(paidPolicy)},external_ai_consent=true where tenant_id=${tenant}::uuid`;
  const noDecode={...options,policy:paidPolicy,audioProvider:paidProvider,audioTenantSeconds:100,audioGlobalSeconds:100,download:async()=>{throw new Error('Duplicate must not decode');}};
  assert.equal(await runLongAudioOnce(noDecode),'waiting');assert.equal((await call(`/v1/work/materials/${duplicate.revision_id}`)).json().audio.reason,'audio_existing_wait');
  await admin`update app.jobs set state='cancelled',lease_expires_at=null where tenant_id=${tenant}::uuid and id=${pendingPaid.job_id}::uuid`;await due();
  assert.equal(await runLongAudioOnce(noDecode),'held');assert.equal((await call(`/v1/work/materials/${duplicate.revision_id}`)).json().audio.reason,'audio_duplicate_held');assert.equal(await runLongAudioOnce(noDecode),'idle');
  await admin`update app.capture_sources set processing_policy=${admin.json(LOCAL_CAPTURE_POLICY)},external_ai_consent=false where tenant_id=${tenant}::uuid`;
  const m4a=execFileSync(python.python,['-c',`import av,io,sys
src=av.open(io.BytesIO(sys.stdin.buffer.read())); target=io.BytesIO()
out=av.open(target,'w',format='mp4'); stream=out.add_stream('aac',rate=16000);stream.layout='mono'
for frame in src.decode(audio=0):
 for packet in stream.encode(frame):out.mux(packet)
for packet in stream.encode(None):out.mux(packet)
out.close();sys.stdout.buffer.write(target.getvalue())
`],{input:syntheticAudio(),env:parserEnvironment(python.pythonRoot)});
  assert.equal(m4a.subarray(8,12).toString(),'isom');const compressed=await ingest(0,m4a,'audio/mp4');
  assert.equal(await finish({...options,audioProvider:{...syntheticAudioProvider,async submit(){return 'synthetic-tone-v1';}}}),'stored');
  assert.equal((await call(`/v1/work/materials/${compressed.revision_id}`)).json().audio.phase,'complete');
  const third=await ingest(5);let revokedSubmits=0;const revoke=()=>app.inject({method:'POST',url:`/v1/capture-sources/${source.json().id}/revoke`,headers:{...headers,'idempotency-key':randomUUID(),'if-match':'"1"'},payload:{}});
  assert.equal(await runLongAudioOnce({...options,audioProvider:{...syntheticAudioProvider,async submit(){revokedSubmits++;assert.equal((await revoke()).statusCode,200);return 'receipt-after-revoke';}}}),'retry');
  assert.equal((await admin`select state#>>'{chunks,0,receipt}' receipt from app.audio_work where tenant_id=${tenant}::uuid and job_id=${third.job_id}::uuid`)[0]?.receipt,'receipt-after-revoke');
  await due();assert.equal(await runLongAudioOnce({...options,audioProvider:provider}),'idle');assert.equal(revokedSubmits,1);assert.equal((await call(`/v1/work/materials/${third.revision_id}`)).statusCode,404);

 }finally{await app.close();if(objects.length)await storage.remove(objects);await admin.begin(async tx=>{await deleteFixtureTenants(tx,[tenant]);await tx`delete from auth.sessions where id=${session}::uuid`;await tx`delete from auth.users where id=${user}::uuid`;});await Promise.all([admin.end(),db.end(),worker.end()]);}
});

test('D11 CLOVA wire contract rejects known nonacceptance, ignores empty segments and never follows redirects',async()=>{
 const original=globalThis.fetch;const provider=clovaProvider({LONG_STT_ENABLED:'true',LONG_STT_OBS_CONFIGURED:'true',CLOVA_SPEECH_KEY:'fixture-key',CLOVA_SPEECH_INVOKE_URL:'https://clovaspeech-gw.ncloud.com/external/v1/123/fixture'});assert.ok(provider);
 try{globalThis.fetch=async(_url,options)=>{assert.equal(options?.redirect,'error');return new Response('{}',{status:429});};await assert.rejects(provider.submit(syntheticAudio(),AbortSignal.timeout(1000)),AudioNotAccepted);
 globalThis.fetch=async()=>new Response(JSON.stringify({result:'COMPLETED',segments:[{start:0,end:1,text:''},{start:1,end:2,text:'확인 전'}]}));assert.deepEqual((await provider.poll('fixture-token',AbortSignal.timeout(1000))).segments,[{start:1,end:2,text:'확인 전'}]);
 }finally{globalThis.fetch=original;}
});
