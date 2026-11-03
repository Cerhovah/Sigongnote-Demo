import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import postgres from 'postgres';
import {contextReadingPrediction,evaluateContextReading,makeContextReadingCandidate,type ContextLearningCase,type ContextReadingShadow} from '../packages/domain/src/context-learning.js';
import {captureContextCorrection,observeContextReading,readContextReadingHints} from '../services/api/src/context-learning.js';
import {createApp} from '../services/api/src/app.js';
import {parseStrictLocalEnv} from '../scripts/local-env-values.mjs';
import {verifyLocalDevelopmentDb} from '../scripts/db-gate.mjs';
import {deleteFixtureTenants} from './fixture-cleanup.js';

const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
const sample=(id:string,family:string):ContextLearningCase=>({id,family,sourceVersion:`1:${digest(family)}:1`,correctedAt:'2026-10-21T03:00:00.000Z',adoptedAt:'2026-10-21T04:00:00.000Z',state:'adopted',targetProject:'site-a',previousProject:'site-b',eligible:true});
test('context reading needs owner-adopted site corrections and never trains on repeated versions of the same source',()=>{
 const c=sample('train','local:one');assert.throws(()=>makeContextReadingCandidate([{...c,state:'unreviewed'}],'2026-10-21T05:00:00.000Z'));
 assert.throws(()=>makeContextReadingCandidate([c,{...c,id:'second',sourceVersion:'2:hash:1'}],'2026-10-21T05:00:00.000Z'));
 assert.equal(makeContextReadingCandidate([c],'2026-10-21T05:00:00.000Z').rule,'recent-project-consensus-v1');
});
test('context shadow reads abstain on conflicting, unknown or future evidence',()=>{
 const input={family:'local:new',sourceVersion:`1:${digest('new')}:1`,receivedAt:'2026-10-21T05:00:00.000Z'},row={kind:'local',id:'earlier',version:`1:${digest('earlier')}:1`,projectId:'site-a',receivedAt:'2026-10-21T04:00:00.000Z'};
 assert.equal(contextReadingPrediction(input,[row]),'site-a');assert.equal(contextReadingPrediction(input,[row,{...row,id:'other',projectId:'site-b'}]),null);
 assert.equal(contextReadingPrediction(input,[{...row,projectId:null}]),null);assert.equal(contextReadingPrediction(input,[{...row,receivedAt:'2026-10-21T06:00:00.000Z'}]),null);
 assert.equal(contextReadingPrediction(input,[{...row,version:input.sourceVersion}]),null,'copied input bytes are not independent earlier evidence');
});
test('promotion requires later independent shadows, zero leakage and zero wrong or abstained answers',()=>{
 const candidate=makeContextReadingCandidate([sample('train','local:train')],'2026-10-21T05:00:00.000Z');
 const cases=[1,2,3].map(n=>({...sample('test'+n,'local:test'+n),correctedAt:'2026-10-21T08:00:00.000Z',adoptedAt:'2026-10-21T09:00:00.000Z'}));
 const shadows:ContextReadingShadow[]=cases.map(c=>({family:c.family,sourceVersion:c.sourceVersion,receivedAt:'2026-10-21T06:00:00.000Z',observedAt:'2026-10-21T07:00:00.000Z',projectId:'site-a'}));
 assert.equal(evaluateContextReading(candidate,cases,shadows).canPromote,true);
 assert.equal(evaluateContextReading(candidate,cases,[{...shadows[0]!,projectId:'wrong'},...shadows.slice(1)]).canPromote,false);
 assert.equal(evaluateContextReading(candidate,cases,[{...shadows[0]!,projectId:null},...shadows.slice(1)]).canPromote,false);
 assert.equal(evaluateContextReading(candidate,cases,shadows.map(s=>({...s,observedAt:'2026-10-21T10:00:00.000Z'}))).independent,0);
 const trainVersion=sample('train','local:train').sourceVersion;
 const leakage=evaluateContextReading(candidate,[...cases,{...cases[0]!,id:'train',family:'local:train',sourceVersion:trainVersion}],[...shadows,{...shadows[0]!,family:'local:train',sourceVersion:trainVersion}]);assert.equal(leakage.leakage,1);assert.equal(leakage.canPromote,false);
});
test('copied local IDs, identical bytes across native/local sources and new revisions of one document never cross learning splits',()=>{
 const training=sample('train','document:one'),candidate=makeContextReadingCandidate([training],'2026-10-21T05:00:00.000Z');
 const later=(id:string,family:string,version:string)=>({...sample(id,family),sourceVersion:version,correctedAt:'2026-10-21T08:00:00.000Z',adoptedAt:'2026-10-21T09:00:00.000Z'});
 const copied=later('copy','local:copied',training.sourceVersion),revised=later('revision-two','document:one',`2:${digest('new content')}:1`);
 for(const c of [copied,revised]){
  const shadow={family:c.family,sourceVersion:c.sourceVersion,receivedAt:'2026-10-21T06:00:00.000Z',observedAt:'2026-10-21T07:00:00.000Z',projectId:'site-a'};
  const report=evaluateContextReading(candidate,[c],[shadow]);assert.equal(report.leakage,1);assert.equal(report.independent,0);assert.equal(report.canPromote,false);
 }
 assert.throws(()=>makeContextReadingCandidate([training,{...training,id:'copied-local',family:'local:copy'}],'2026-10-21T05:00:00.000Z'));
 const independent=later('heldout','local:other',`1:${digest('heldout')}:1`),duplicate={...independent,id:'duplicate',family:'local:duplicate'};
 const shadows=[independent,duplicate].map(c=>({family:c.family,sourceVersion:c.sourceVersion,receivedAt:'2026-10-21T06:00:00.000Z',observedAt:'2026-10-21T07:00:00.000Z',projectId:'site-a'}));
 assert.equal(evaluateContextReading(candidate,[independent,duplicate],shadows).independent,1,'copied held-outs count once');
});

test('N11 actual correction capture, consent, source versions, later shadow evaluation, owner promotion and immediate withdrawal',{skip:process.env.SIGONGNOTE_E2E_DB!=='1'},async()=>{
 assert.equal((await verifyLocalDevelopmentDb()).status,'READY');
 const env=parseStrictLocalEnv(readFileSync('services/api/.env','utf8')),url=new URL(String(env.MIGRATION_DATABASE_URL));
 assert(['127.0.0.1','localhost'].includes(url.hostname)&&/^\/sigongnote_e2e_[a-f0-9]+$/.test(url.pathname),'isolated fixture database required');
 const admin=postgres(String(env.MIGRATION_DATABASE_URL),{max:1,onnotice:()=>{}}),api=postgres(String(env.DATABASE_URL),{max:3,onnotice:()=>{}}),worker=postgres(String(env.WORKER_DATABASE_URL),{max:1,onnotice:()=>{}});
 const tenant=randomUUID(),otherTenant=randomUUID(),user=randomUUID(),operator=randomUUID(),foreign=randomUUID(),session=randomUUID(),operatorSession=randomUUID(),foreignSession=randomUUID(),device=randomUUID(),operatorDevice=randomUUID(),site=randomUUID(),wrongSite=randomUUID();
 const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
 const policy={id:'synthetic-context-learning-v1',purpose:'work_records' as const,provider:'anthropic',processing_location:'provider_cloud',storage_location:'development_computer',retention:'until_user_deletes' as const,external_processing:true};
 let app:ReturnType<typeof createApp>|undefined;
 const actorTx=<T>(fn:(tx:postgres.TransactionSql)=>Promise<T>,actor=user)=>api.begin(async tx=>{await tx`select set_config('request.jwt.claim.sub',${actor},true)`;return fn(tx);});
 const source=async(text:string,project:string|null=null,actor=user,sourceDevice=device)=>{
  const [row]=await admin`insert into app.local_journal_entries(tenant_id,device_id,local_id,actor_id,file_name,sha256,mime,received_at,project_id,categories,excerpt) values(${tenant}::uuid,${sourceDevice}::uuid,${randomUUID()}::uuid,${actor}::uuid,'합성 연락.txt',${hash(text)},'text/plain',clock_timestamp(),${project}::uuid,'{}',${text}) returning id,received_at`;
  const [version]=await actorTx(tx=>tx`select app.context_learning_source_version(${tenant}::uuid,'local',${row!.id}::uuid) value`,actor);
  return {tenant,actor,source_kind:'local' as const,source_ref:String(row!.id),source_version:String(version!.value),received_at:new Date(row!.received_at).toISOString()};
 };
 const event=async(input:Omit<Awaited<ReturnType<typeof source>>,'source_kind'>&{source_kind:'local'|'revision'},evidence:string[]=[])=>{const [e]=await admin`insert into app.work_events(tenant_id,kind,summary,project_id,source_kind,source_ref,source_version,confidence,actor_id,evidence_refs) values(${tenant}::uuid,'request','합성 업무 현장을 다시 확인',${wrongSite}::uuid,${input.source_kind},${input.source_ref}::uuid,${input.source_version},'high',${input.actor}::uuid,${evidence}::uuid[]) returning id`;return String(e!.id);};
 const headers=(actor=user,scope=tenant)=>({authorization:actor===operator?'Bearer operator':actor===foreign?'Bearer foreign':'Bearer owner','x-tenant-id':scope});
 const command=(payload:object,actor=user)=>app!.inject({method:'POST',url:'/v1/context-learning/commands',headers:headers(actor),payload:{command_id:randomUUID(),...payload}});
 const correct=(id:string,actor=user)=>app!.inject({method:'POST',url:'/v1/work/journal/commands',headers:headers(actor),payload:{action:'event',id,expected_version:1,client_command_id:randomUUID(),project_id:site,summary:'이 연락은 확인한 합성 현장 요청',reason:'실제 연락 근거로 현장 교정'}});
 const list=()=>app!.inject({url:'/v1/context-learning',headers:headers()});
 try{
  for(const actor of [user,operator,foreign])await admin`insert into auth.users(id) values(${actor}::uuid)`;
  for(const [id,actor] of [[session,user],[operatorSession,operator],[foreignSession,foreign]])await admin`insert into auth.sessions(id,user_id) values(${id!}::uuid,${actor!}::uuid)`;
  for(const id of [tenant,otherTenant])await admin`insert into app.tenants(id,display_name) values(${id}::uuid,'N11 합성 검증 회사')`;
  await admin`insert into app.memberships(tenant_id,user_id,role) values(${tenant}::uuid,${user}::uuid,'owner'),(${tenant}::uuid,${operator}::uuid,'operator'),(${otherTenant}::uuid,${foreign}::uuid,'owner')`;
  for(const [id,actor] of [[device,user],[operatorDevice,operator]])await admin`insert into app.devices(tenant_id,id,user_id,platform,public_key_jwk,public_key_sha256,app_version,registration_key,registration_hash) values(${tenant}::uuid,${id!}::uuid,${actor!}::uuid,'windows','{}',${hash(id!)},'synthetic',${randomUUID()}::uuid,${hash('registration')})`;
  for(const actor of [user,operator])await admin`insert into app.local_context_consents(tenant_id,user_id,allowed,processing_policy) values(${tenant}::uuid,${actor}::uuid,true,${admin.json(policy)})`;
  await admin`insert into app.projects(tenant_id,id,display_name) values(${tenant}::uuid,${site}::uuid,'확인한 합성 현장'),(${tenant}::uuid,${wrongSite}::uuid,'교정 전 합성 현장')`;
  app=createApp({db:api,agentRuntime:false,capturePolicy:policy,verifyToken:async token=>token==='operator'?{userId:operator,sessionId:operatorSession}:token==='foreign'?{userId:foreign,sessionId:foreignSession}:{userId:user,sessionId:session},storage:{async sign(){return 'https://storage.invalid/synthetic?token=synthetic-opaque-upload-signature-for-fixture';},async verify(){return {matches:true,sniffedMime:'text/plain'};},async remove(){}}});
  const first=await source('동의 전 합성 연락'),firstEvent=await event(first);assert.equal((await correct(firstEvent)).statusCode,200);assert.equal((await admin`select id from app.context_learning_cases where tenant_id=${tenant}::uuid`).length,0);
  const learnedConsent=await app.inject({method:'POST',url:'/v1/learning/commands',headers:headers(),payload:{action:'consent',command_id:randomUUID(),purpose:'company-improvement-v1',allowed:true}});assert.equal(learnedConsent.statusCode,200,learnedConsent.body);
  const prior=await source('어제 실제로 읽을 수 있는 합성 현장 연락',site),train=await source('현장을 생략한 합성 연락'),trainEvent=await event(train,[prior.source_ref]);assert.equal((await correct(trainEvent)).statusCode,200);
  let report=(await list()).json();assert.equal(report.cases.length,1);const training=report.cases[0];assert.equal(training.state,'unreviewed');assert(!JSON.stringify(training.snapshot).includes('어제 실제로'),'source prose is not copied into training data');assert(training.snapshot.evidence.some((e:any)=>e.id===prior.source_ref&&e.version));
  const correction=(await admin`select id from app.work_event_corrections where tenant_id=${tenant}::uuid and event_id=${trainEvent}::uuid`)[0]!;
  assert.equal(await actorTx(tx=>captureContextCorrection(tx,tenant,user,String(correction.id))),null,'capture hook replay is idempotent');
  assert.equal((await command({action:'procedure.create',case_ids:[training.id]})).statusCode,422,'unreviewed correction is not a training label');
  assert.equal((await command({action:'case.review',id:training.id,version:1,state:'adopted',reason:'실제 원문과 현장을 확인함'})).statusCode,200);
  const created=await command({action:'procedure.create',case_ids:[training.id]});assert.equal(created.statusCode,200,created.body);const procedure=created.json().id;
  const [trainingFollowup]=await admin`insert into app.work_followups(tenant_id,event_id,title,project_id) values(${tenant}::uuid,${trainEvent}::uuid,'확인한 현장 연락 처리',${site}::uuid) returning id`;
  let followupVersion=1;
  const toggleTrainingFollowup=async(done:boolean)=>{
   const marked=await app!.inject({method:'POST',url:'/v1/work/journal/commands',headers:headers(),payload:{action:'task',id:String(trainingFollowup!.id),client_command_id:randomUUID(),expected_version:followupVersion,done}});assert.equal(marked.statusCode,200,marked.body);followupVersion=marked.json().version;
   const [changed]=await admin`select status,project_id,summary from app.work_events where tenant_id=${tenant}::uuid and id=${trainEvent}::uuid`;
   assert.equal(changed!.status,done?'resolved':'open');assert.equal(changed!.project_id,site);assert.equal(changed!.summary,'이 연락은 확인한 합성 현장 요청');
   report=(await list()).json();const preserved=report.cases.find((c:any)=>c.id===training.id);
   assert.ok(preserved,'completing/reopening a follow-up must preserve the adopted correction case');assert.equal(preserved.state,'adopted');assert.equal(preserved.review_reason,'실제 원문과 현장을 확인함');assert.equal(report.procedures.find((p:any)=>p.id===procedure)?.usable,true,'follow-up status does not invalidate a reading procedure');
  };
  await toggleTrainingFollowup(true);await toggleTrainingFollowup(false);
  assert.deepEqual(await actorTx(tx=>readContextReadingHints(tx,tenant)),[],'shadow candidates never change model hints');
  assert.equal((await command({action:'procedure.promote',id:procedure,version:1})).statusCode,422);
  await actorTx(tx=>observeContextReading(tx,train));assert.equal((await admin`select id from app.context_reading_shadows where tenant_id=${tenant}::uuid`).length,0,'training source cannot become its own test case');
  const copiedTraining=await source('현장을 생략한 합성 연락');assert.notEqual(copiedTraining.source_ref,train.source_ref);
  await actorTx(tx=>observeContextReading(tx,copiedTraining));assert.equal((await admin`select id from app.context_reading_shadows where tenant_id=${tenant}::uuid`).length,0,'same bytes under another local ID are excluded before shadow collection');
  const heldouts:Awaited<ReturnType<typeof source>>[]=[];
  for(let n=0;n<3;n++){
   const input=await source('후속 독립 합성 연락 '+n);heldouts.push(input);await actorTx(tx=>observeContextReading(tx,input));await actorTx(tx=>observeContextReading(tx,input));
   const eid=await event(input,[prior.source_ref]);assert.equal((await correct(eid)).statusCode,200);
   report=(await list()).json();const c=report.cases.find((c:any)=>c.source_ref===input.source_ref);assert(c);assert.equal((await command({action:'case.review',id:c.id,version:1,state:'adopted',reason:'후속 실제 원문 정답 확인'})).statusCode,200);
  }
  assert.equal((await admin`select id from app.context_reading_shadows where tenant_id=${tenant}::uuid and procedure_id=${procedure}::uuid`).length,3);
  const evaluation=await command({action:'procedure.evaluate',id:procedure,version:1});assert.equal(evaluation.statusCode,200,evaluation.body);assert.deepEqual([evaluation.json().report.independent,evaluation.json().report.matched,evaluation.json().report.leakage,evaluation.json().report.canPromote],[3,3,0,true]);
  const before=await admin`select id,project_id,version,status from app.work_events where tenant_id=${tenant}::uuid order by id`;
  assert.equal((await command({action:'procedure.promote',id:procedure,version:1})).statusCode,200);const hints=await actorTx(tx=>readContextReadingHints(tx,tenant));assert.equal(hints.length,1);assert.equal(hints[0]!.scope,'read_evidence_only');assert(!JSON.stringify(hints).includes(site),'promoted read procedures never memorize a site answer');
  assert.deepEqual(await admin`select id,project_id,version,status from app.work_events where tenant_id=${tenant}::uuid order by id`,before,'promotion changes no existing event or business effect');
  for(const done of [true,false]){await toggleTrainingFollowup(done);assert.equal((await actorTx(tx=>readContextReadingHints(tx,tenant))).length,1,'promoted hints survive follow-up completion and reopening');}
  assert.equal((await app.inject({url:'/v1/context-learning',headers:headers(foreign,tenant)})).statusCode,404);
  await assert.rejects(worker`select id from app.context_learning_cases`,/permission denied/);
  await admin`insert into app.activity_consents(tenant_id,user_id,allowed,learning_allowed) values(${tenant}::uuid,${operator}::uuid,false,true)`;
  const operatorSource=await source('담당자 실제 교정 합성 연락',null,operator,operatorDevice),operatorEvent=await event(operatorSource);const corrected=await correct(operatorEvent,operator);assert.equal(corrected.statusCode,200,corrected.body);
  assert.equal((await command({action:'procedure.create',case_ids:[training.id]},operator)).statusCode,404);
  // Exercise the real upload revisions, not just a caller-supplied canonical family.
  const captureSource=randomUUID(),scope={capture_method:'filesystem',history_mode:'all',history_since:null,scope_mode:'work_dedicated',rule_version:1,fingerprint_algorithm:'hmac-sha256-device-v1',processing_policy_id:policy.id};
  await admin`insert into app.capture_sources(tenant_id,id,user_id,device_id,kind,capability,scope_fingerprint,local_selection_consent,server_upload_consent,external_ai_consent,consent_version,scope,processing_policy) values(${tenant}::uuid,${captureSource}::uuid,${user}::uuid,${device}::uuid,'folder','passive',${hash(captureSource)},true,true,true,2,${admin.json(scope)},${admin.json(policy)})`;
  const uploadRevision=async(text:string,previous?:{id:string;document:string})=>{
   const bytes=Buffer.from(text),prepared=await app!.inject({method:'POST',url:'/v1/ingestions',headers:{...headers(),'idempotency-key':randomUUID()},payload:{client_capture_id:randomUUID(),source_id:captureSource,source_generation:1,sha256:hash(text),byte_length:bytes.length,declared_mime:'text/plain',...(previous?{document_id:previous.document,predecessor_revision_id:previous.id,expected_version:1}:{})}});assert.equal(prepared.statusCode,201,prepared.body);
   const completed=await app!.inject({method:'POST',url:`/v1/ingestions/${prepared.json().ingestion_id}/complete`,headers:{...headers(),'idempotency-key':randomUUID()},payload:{sha256:hash(text),byte_length:bytes.length}});assert.equal(completed.statusCode,200,completed.body);const id=String(completed.json().revision_id);
   const [row]=await admin`select document_id,created_at from app.document_revisions where tenant_id=${tenant}::uuid and id=${id}::uuid`,[identity]=await actorTx(tx=>tx`select app.context_learning_source_version(${tenant}::uuid,'revision',${id}::uuid) version,app.context_learning_source_family(${tenant}::uuid,'revision',${id}::uuid) family`);
   return {id,document:String(row!.document_id),family:String(identity!.family),tenant,actor:user,source_kind:'revision' as const,source_ref:id,source_version:String(identity!.version),received_at:new Date(row!.created_at).toISOString()};
  };
  const nativeTrain=await uploadRevision('합성 문서 첫 판');assert.equal(nativeTrain.family,`document:${nativeTrain.document}`);
  const nativeTrainEvent=await event(nativeTrain);assert.equal((await correct(nativeTrainEvent)).statusCode,200);report=(await list()).json();const nativeCase=report.cases.find((c:any)=>c.source_ref===nativeTrain.id);assert(nativeCase);assert.equal((await command({action:'case.review',id:nativeCase.id,version:1,state:'adopted',reason:'문서 첫 판 근거 확인'})).statusCode,200);
  const nativeCreated=await command({action:'procedure.create',case_ids:[nativeCase.id]});assert.equal(nativeCreated.statusCode,200,nativeCreated.body);const nativeProcedure=nativeCreated.json().id;
  const nativeNext=await uploadRevision('내용이 달라진 합성 문서 두 번째 판',{id:nativeTrain.id,document:nativeTrain.document});assert.equal(nativeNext.family,nativeTrain.family);assert.notEqual(nativeNext.source_version,nativeTrain.source_version);
  await actorTx(tx=>observeContextReading(tx,nativeNext));assert.equal((await admin`select id from app.context_reading_shadows where tenant_id=${tenant}::uuid and procedure_id=${nativeProcedure}::uuid`).length,0,'new revision of the training document is not held out');
  const nativeReCorrection=await app.inject({method:'POST',url:'/v1/work/journal/commands',headers:headers(),payload:{action:'event',id:nativeTrainEvent,expected_version:2,client_command_id:randomUUID(),project_id:site,summary:'이 연락은 확인한 합성 현장 요청',reason:'같은 문구라도 새로 확인한 실제 정정'}});assert.equal(nativeReCorrection.statusCode,200,nativeReCorrection.body);
  report=(await list()).json();assert.equal(report.cases.some((c:any)=>c.id===nativeCase.id),false,'a later real correction invalidates the previous case even if site and summary match');assert.equal(report.procedures.find((p:any)=>p.id===nativeProcedure)?.usable,false,'new correction identity invalidates the old procedure');
  await admin`update app.local_journal_entries set local_revision=local_revision+1,sha256=${hash('새 판')},excerpt='교체된 판' where tenant_id=${tenant}::uuid and id=${heldouts[0]!.source_ref}::uuid`;
  assert.deepEqual(await actorTx(tx=>readContextReadingHints(tx,tenant)),[],'held-out source version withdrawal disables the promoted hint immediately');
  const revoke=await app.inject({method:'POST',url:'/v1/learning/commands',headers:headers(),payload:{action:'consent',command_id:randomUUID(),purpose:'company-improvement-v1',allowed:false}});assert.equal(revoke.statusCode,200,revoke.body);
  assert.equal((await admin`select id from app.context_reading_procedures where tenant_id=${tenant}::uuid`).length,0);assert.equal((await admin`select id from app.context_learning_cases where tenant_id=${tenant}::uuid and actor_id=${user}::uuid`).length,0);
 }finally{
  await app?.close();try{await admin.begin(async tx=>{await deleteFixtureTenants(tx,[tenant,otherTenant]);for(const actor of [user,operator,foreign]){await tx`delete from auth.sessions where user_id=${actor}::uuid`;await tx`delete from auth.users where id=${actor}::uuid`;}});}finally{await Promise.all([admin.end(),api.end(),worker.end()]);}
 }
});
