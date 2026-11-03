import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {LocalAgent,sha256,inside} from '../services/local-agent/src/agent.js';
import {CopyProtection} from '../services/local-agent/src/protection.js';
import {LocalCloudSync,type CloudSession,windowsNativeCaptureId} from '../services/local-agent/src/cloud-sync.js';
import {LocalAi} from '../services/local-agent/src/ai.js';
import {createLocalServer} from '../services/local-agent/src/server.js';

async function connectedFixture(){
 const temp=await mkdtemp(path.join(os.tmpdir(),'sigongnote-connected-work-'));
 const root=path.join(temp,'Documents'),data=path.join(temp,'private');await mkdir(root);await mkdir(data);
 const agent=new LocalAgent(data,async file=>({status:'complete',sourceHash:sha256(await readFile(file)),spans:[{locator:'text',text:await readFile(file,'utf8')}],issues:[]}),new CopyProtection(Buffer.alloc(32,8)));
 await agent.grant(root,'automatic_discovery');await agent.start();
 const clean=async()=>{await agent.stop();await agent.cloud?.stop();agent.close();assert(inside(os.tmpdir(),temp)&&path.basename(temp).startsWith('sigongnote-connected-work-'));await rm(temp,{recursive:true,force:true});};
 return {temp,root,agent,clean};
}

test('native capture identity matches the Windows source, relative path and hash contract',()=>{
 assert.equal(windowsNativeCaptureId('11111111-1111-4111-8111-111111111111','현장A/업무 녹음.wav','a'.repeat(64)),'a17966f0-f35f-5bb3-836e-b5c1b0ad1ea5');
 assert.notEqual(windowsNativeCaptureId('11111111-1111-4111-8111-111111111111','다른현장/업무 녹음.wav','a'.repeat(64)),'a17966f0-f35f-5bb3-836e-b5c1b0ad1ea5');
});

test('cloud journal sync retries once, joins phone entries, survives restart and isolates changed account',async()=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),'sigongnote-cloud-sync-'));const data=path.join(temp,'data');const root=path.join(temp,'Documents');await mkdir(data);await mkdir(root);
 const parse=async(file:string)=>({status:'complete' as const,sourceHash:sha256(await readFile(file)),spans:[{locator:'text',text:await readFile(file,'utf8')}],issues:[]});
 let agent=new LocalAgent(data,parse,new CopyProtection(Buffer.alloc(32,7)));
 let session:CloudSession|null={apiUrl:'https://cloud.example',accessToken:'test',tenantId:randomUUID(),userId:randomUUID(),deviceId:randomUUID()};const first=session;const project={id:randomUUID(),display_name:'테스트현장'};const phone={id:randomUUID(),received_at:new Date().toISOString(),project_id:project.id,project_name:project.display_name,categories:['delivery_work'],excerpt:'휴대폰 사진',source_kind:'photos'};
 let fail=true;let pushes=0;const received=new Map<string,{local_id:string;revision_id:string}>();
 const request=(async(url:string|URL|Request,options?:RequestInit)=>{const route=String(url);if(route.endsWith('/context'))return Response.json({company:'테스트회사',projects:[project]});if(route.endsWith('/push')){pushes++;if(fail)return Response.json({}, {status:503});const body=JSON.parse(String(options?.body)) as {items:{id:string}[]};for(const item of body.items)received.set(item.id,{local_id:item.id,revision_id:item.id});return Response.json({items:[...received.values()]});}if(route.includes('/original'))return Response.json({url:'https://cloud.example/signed-original'});if(route.includes('/journal'))return Response.json({items:[phone],next_cursor:null});throw new Error('UNEXPECTED_ROUTE');}) as typeof fetch;
 try{
  await agent.grant(root,'automatic_discovery');await agent.start();await writeFile(path.join(root,'테스트현장 청구.txt'),'테스트현장 청구');await agent.start();
  let sync=new LocalCloudSync(agent,async()=>session,request);await sync.sync();assert.equal(sync.info().pending,1);fail=false;await sync.sync();assert.equal(sync.info().pending,0);assert.equal(pushes,2);
  const journal=await sync.work({route:'journal.list'},'http://127.0.0.1:5174') as {items:{id:string}[]};assert.equal(journal.items.length,2);assert(journal.items.some(e=>e.id===phone.id));
  assert.deepEqual(await sync.work({route:'materials.original',id:phone.id},'http://127.0.0.1:5174'),{url:'https://cloud.example/signed-original'});
  await agent.stop();agent.close();agent=new LocalAgent(data,parse,new CopyProtection(Buffer.alloc(32,7)));sync=new LocalCloudSync(agent,async()=>session,request);await sync.sync();assert.equal(pushes,2);
  session={...first,tenantId:randomUUID(),userId:randomUUID()};await sync.sync();assert.equal(pushes,2,'old account material must not be sent to switched account');
  session=null;await sync.sync();assert.equal(sync.info().connected,false);assert.equal(await sync.work({route:'journal.list'},'http://127.0.0.1:5174'),undefined);
 }finally{await agent.stop();agent.close();assert(inside(os.tmpdir(),temp)&&path.basename(temp).startsWith('sigongnote-cloud-sync-'));await rm(temp,{recursive:true,force:true});}
});

test('connected PC relays work routes, preserves command identity and resolves canonical evidence to its local original',async()=>{
 const f=await connectedFixture();
 const project={id:randomUUID(),display_name:'연결현장'},remoteId=randomUUID(),task=randomUUID();
 const session:CloudSession={apiUrl:'https://cloud.example',accessToken:'test',tenantId:randomUUID(),userId:randomUUID(),deviceId:randomUUID()};
 const requests:{path:string;method:string;body:any;headers:Headers}[]=[];
 let localId='';
 const request=(async(url:string|URL|Request,options?:RequestInit)=>{
  const pathname=new URL(String(url)).pathname,body=options?.body?JSON.parse(String(options.body)):undefined;
  requests.push({path:pathname,method:options?.method??'GET',body,headers:new Headers(options?.headers)});
  if(pathname==='/v1/work/context')return Response.json({company:'연결회사',projects:[project],ai_consent:{allowed:false,version:1,policy_current:true}});
  if(pathname==='/v1/local-journal/push'){localId=body.items[0].id;return Response.json({items:[{local_id:localId,revision_id:remoteId}]});}
  if(pathname==='/v1/work/journal')return Response.json({items:[{id:remoteId,local_id:localId,file_name:'연결현장.txt',received_at:new Date().toISOString(),project_id:project.id,project_name:project.display_name,categories:['agreement'],excerpt:'자재 10개 요청',organization_version:2}],next_cursor:null});
  if(pathname==='/v1/work/journal/tasks')return Response.json({items:[{id:task,revision_id:remoteId}],events:[],partial:false});
  return Response.json({path:pathname,body:body??null});
 }) as typeof fetch;
 try{
  const sync=new LocalCloudSync(f.agent,async()=>session,request);
  await writeFile(path.join(f.root,'연결현장.txt'),'현장: 연결현장\n자재 10개 요청');await f.agent.start();await sync.sync();
  const context=await sync.work({route:'context'},'http://127.0.0.1:5174') as {local:boolean;cloud_connected:boolean;projects:{id:string}[];ai_consent:{allowed:boolean}};
  assert.equal(context.local,true);assert.equal(context.cloud_connected,true);assert.deepEqual(context.projects.map(p=>p.id),[project.id]);assert.equal(context.ai_consent.allowed,false);
  const tasks=await sync.work({route:'journal.tasks'},'http://127.0.0.1:5174') as {items:{id:string;revision_id:string}[]};assert.equal(tasks.items[0]?.id,task);assert.equal(tasks.items[0]?.revision_id,remoteId);
  for(const route of ['agenda.read','ledger.list','questions.list','documents.list','capture.status','events.list']){
   const result=await sync.work({route},'http://127.0.0.1:5174') as {path:string};assert(result.path.startsWith('/v1/'),route);
  }
  const commandId=randomUUID();await sync.work({route:'journal.command',command:JSON.stringify({action:'prepare',client_command_id:commandId,revision_id:localId})},'http://127.0.0.1:5174');
  assert.deepEqual(requests.at(-1)?.body,{action:'prepare',client_command_id:commandId,revision_id:remoteId});
  const turn=randomUUID();await sync.work({route:'conversation.turn',id:randomUUID(),client_turn_id:turn,text:`원문 속 ID ${localId}`},'http://127.0.0.1:5174');
  assert.equal(requests.at(-1)?.headers.get('Idempotency-Key'),turn);assert.equal(requests.at(-1)?.body.text,`원문 속 ID ${localId}`);
  const journal=await sync.work({route:'journal.list'},'http://127.0.0.1:5174') as {items:{id:string;original_available:boolean}[]};assert.equal(journal.items.length,1);assert.equal(journal.items[0]?.id,remoteId);assert.equal(journal.items[0]?.original_available,true);
  const before=requests.length,detail=await sync.work({route:'materials.detail',id:remoteId},'http://127.0.0.1:5174') as {revision:{id:string}};assert.equal(detail.revision.id,localId);assert.equal(requests.length,before,'own original metadata is resolved locally');
  assert.equal(await readFile(path.join(f.root,'연결현장.txt'),'utf8'),'현장: 연결현장\n자재 10개 요청');
 }finally{await f.clean();}
});

test('switching company and logging out hide owned PC documents, projects and direct original URLs',async()=>{
 const f=await connectedFixture();
 const first:CloudSession={apiUrl:'https://cloud.example',accessToken:'first',tenantId:randomUUID(),userId:randomUUID(),deviceId:randomUUID()};
 let session:CloudSession|null=first;
 const a={id:randomUUID(),display_name:'가회사현장'},b={id:randomUUID(),display_name:'나회사현장'};
 const request=(async(url:string|URL|Request,options?:RequestInit)=>{
  const pathname=new URL(String(url)).pathname,tenant=new Headers(options?.headers).get('X-Tenant-ID');
  if(pathname.endsWith('/context'))return Response.json({company:tenant===first.tenantId?'가회사':'나회사',projects:[tenant===first.tenantId?a:b]});
  if(pathname.endsWith('/push')){const body=JSON.parse(String(options?.body));return Response.json({items:body.items.map((item:{id:string})=>({local_id:item.id,revision_id:randomUUID()}))});}
  if(pathname.endsWith('/journal'))return Response.json({items:[],next_cursor:null});
  return Response.json({});
 }) as typeof fetch;
 const sync=new LocalCloudSync(f.agent,async()=>session,request);
 const app=createLocalServer(f.agent,new LocalAi(f.agent,{dailyCalls:0}),{port:5174,webDir:f.temp,pairToken:'test-pair'});
 try{
  await writeFile(path.join(f.root,'가회사현장.txt'),'현장: 가회사현장\n처음 회사 원문');await f.agent.start();await sync.sync();
  const document=f.agent.search().documents[0];assert(document);
  session={...first,userId:randomUUID(),tenantId:randomUUID(),accessToken:'second'};
  const context=await sync.work({route:'context'},'http://127.0.0.1:5174') as {company:string;projects:{display_name:string}[]};assert.equal(context.company,'나회사');assert.deepEqual(context.projects.map(p=>p.display_name),['나회사현장']);
  const journal=await sync.work({route:'journal.list'},'http://127.0.0.1:5174') as {items:unknown[]};assert.equal(journal.items.length,0);assert.equal(f.agent.search().total,0);
  await assert.rejects(sync.work({route:'materials.detail',id:document.id},'http://127.0.0.1:5174'),/DOCUMENT_NOT_FOUND/);
  await assert.rejects(f.agent.snapshot(document.id),/DOCUMENT_NOT_FOUND/);assert.throws(()=>f.agent.planCopies([document.id]),/DOCUMENT_NOT_FOUND/);
  assert.throws(()=>new LocalAi(f.agent,{dailyCalls:1,session:async()=>session}).prepare(document.id),/DOCUMENT_NOT_FOUND/);
  const pair=await app.inject({method:'POST',url:'/api/pair',headers:{host:'127.0.0.1:5174','x-sigongnote-local':'1'},payload:{token:'test-pair'}});
  const cookie=String(pair.headers['set-cookie']).split(';')[0]!;
  const original=await app.inject({method:'GET',url:`/local-original/${document.id}`,headers:{host:'127.0.0.1:5174',cookie}});assert.equal(original.statusCode,409);assert.equal(original.json().error,'DOCUMENT_NOT_FOUND');
  session=null;assert.equal(await sync.currentSession(),null);await assert.rejects(sync.work({route:'journal.tasks'},'http://127.0.0.1:5174'),/CLOUD_LOGIN_REQUIRED/);
  assert.equal(f.agent.search().total,0);assert.equal(await readFile(path.join(f.root,'가회사현장.txt'),'utf8'),'현장: 가회사현장\n처음 회사 원문');
 }finally{await app.close();await f.clean();}
});

test('offline work fails explicitly and a company switch cancels the previous in-flight response',async()=>{
 const f=await connectedFixture();
 const first:CloudSession={apiUrl:'https://cloud.example',accessToken:'first',tenantId:randomUUID(),userId:randomUUID(),deviceId:randomUUID()};
 let session=first,offline=false,release:()=>void=()=>{};
 let notify:()=>void=()=>{};const entered=new Promise<void>(resolve=>{notify=resolve;});
 const delayed=new Promise<void>(resolve=>{release=resolve;});
 const request=(async(url:string|URL|Request,options?:RequestInit)=>{
  if(offline)throw new Error('network disconnected');
  const pathname=new URL(String(url)).pathname;
  if(pathname.endsWith('/tasks')){notify();await delayed;return Response.json({items:[{id:randomUUID()}]});}
  if(pathname.endsWith('/context'))return Response.json({company:new Headers(options?.headers).get('X-Tenant-ID')===first.tenantId?'가회사':'나회사',projects:[]});
  return Response.json({items:[],next_cursor:null});
 }) as typeof fetch;
 try{
  const sync=new LocalCloudSync(f.agent,async()=>session,request);await sync.work({route:'context'},'http://127.0.0.1:5174');
  const inflight=sync.work({route:'journal.tasks'},'http://127.0.0.1:5174');await entered;
  session={...first,userId:randomUUID(),tenantId:randomUUID()};const context=await sync.work({route:'context'},'http://127.0.0.1:5174') as {company:string};assert.equal(context.company,'나회사');release();await assert.rejects(inflight,/CLOUD_ACCOUNT_CHANGED/);assert.equal(sync.info().status,'connected');
  offline=true;await assert.rejects(sync.work({route:'agenda.read'},'http://127.0.0.1:5174'),/CLOUD_WAITING_FOR_SERVER/);
  assert.equal(sync.info().status,'offline');
 }finally{release();await f.clean();}
});

test('explicit native recording scopes use the uploaded server record once instead of a second unsupported local file',async()=>{
 const f=await connectedFixture();const revision=randomUUID();
 const recording={source_id:randomUUID(),root:f.root,kind:'call_recording' as const,active:true,setup_state:'ready',pending:1,error:null,managed_root:false};
 const session:CloudSession={apiUrl:'https://cloud.example',accessToken:'test',tenantId:randomUUID(),userId:randomUUID(),deviceId:randomUUID(),nativeSources:[recording]};
 let pushes=0;
 const request=(async(url:string|URL|Request)=>{
  const pathname=new URL(String(url)).pathname;
  if(pathname.endsWith('/context'))return Response.json({company:'녹음회사',projects:[]});
  if(pathname.endsWith('/push')){pushes++;throw new Error('Native recording must not become another local-journal upload');}
  return Response.json({items:[{id:revision,received_at:new Date().toISOString(),project_id:null,project_name:null,categories:[],source_kind:'call_recording',declared_mime:'audio/wav',excerpt:'전사한 실제 녹음 자료',audio:{phase:'complete'}}],next_cursor:null});
 }) as typeof fetch;
 try{
  await writeFile(path.join(f.root,'녹음.wav'),'synthetic local audio');await f.agent.start();const sync=new LocalCloudSync(f.agent,async()=>session,request);await sync.sync();
  const journal=await sync.work({route:'journal.list'},'http://127.0.0.1:5174') as {items:{id:string;source_kind:string}[]};assert.deepEqual(journal.items.map(row=>[row.id,row.source_kind]),[[revision,'call_recording']]);assert.equal(pushes,0);assert.equal(f.agent.search().total,0);
  const info=sync.info();assert.equal(info.native_sources[0]?.pending,1);assert(!JSON.stringify(info).includes(f.root),'native file paths stay in the private bridge');
  assert.equal(await readFile(path.join(f.root,'녹음.wav'),'utf8'),'synthetic local audio');
 }finally{await f.clean();}
});

test('consented native document scope uses its hash-matched canonical server revision and never uploads a second metadata source',async()=>{
 const f=await connectedFixture(),revision=randomUUID(),body='네이티브 문서 원문';let pushes=0;
 const session:CloudSession={apiUrl:'https://cloud.example',accessToken:'test',tenantId:randomUUID(),userId:randomUUID(),deviceId:randomUUID(),nativeSources:[{source_id:randomUUID(),root:f.root,kind:'folder',active:true,setup_state:'ready',pending:0,error:null,managed_root:false}]};
 const request=(async(url:string|URL|Request)=>{
  const pathname=new URL(String(url)).pathname;
  if(pathname.endsWith('/context'))return Response.json({company:'문서회사',projects:[]});
  if(pathname.endsWith('/push')){pushes++;throw new Error('Native scope must not upload duplicate metadata');}
  return Response.json({items:[{id:revision,received_at:new Date().toISOString(),project_id:null,project_name:null,categories:[],source_kind:'folder',sha256:sha256(body),client_capture_id:windowsNativeCaptureId(session.nativeSources![0]!.source_id,'원문.txt',sha256(body)),capture_device_id:session.deviceId,declared_mime:'text/plain',excerpt:body}],next_cursor:null});
 }) as typeof fetch;
 try{
  await writeFile(path.join(f.root,'원문.txt'),body);await f.agent.start();const local=f.agent.search().documents[0];assert(local);
  const sync=new LocalCloudSync(f.agent,async()=>session,request);await sync.sync();const journal=await sync.work({route:'journal.list'},'http://127.0.0.1:5174') as {items:{id:string}[]};assert.deepEqual(journal.items.map(row=>row.id),[revision]);assert.equal(pushes,0);
  const detail=await sync.work({route:'materials.detail',id:revision},'http://127.0.0.1:5174') as {revision:{id:string}};assert.equal(detail.revision.id,local.id);assert.equal(await readFile(path.join(f.root,'원문.txt'),'utf8'),body);
 }finally{await f.clean();}
});

test('new arrivals in another company native scope keep that source owner after a company switch',async()=>{
 const f=await connectedFixture(),owner={userId:randomUUID(),tenantId:randomUUID()};
 const session:CloudSession={apiUrl:'https://cloud.example',accessToken:'current',tenantId:randomUUID(),userId:randomUUID(),deviceId:randomUUID(),nativeSources:[{source_id:randomUUID(),root:f.root,kind:'folder',active:true,setup_state:'ready',pending:0,error:null,managed_root:false,account:`${owner.userId}:${owner.tenantId}`}]};
 const request=(async(url:string|URL|Request)=>new URL(String(url)).pathname.endsWith('/context')?Response.json({company:'현재회사',projects:[]}):Response.json({items:[],next_cursor:null})) as typeof fetch;
 try{
  const sync=new LocalCloudSync(f.agent,async()=>session,request);await sync.work({route:'context'},'http://127.0.0.1:5174');
  await writeFile(path.join(f.root,'다른회사새자료.txt'),'다른회사 소스의 새 원문');await f.agent.start();await sync.sync();
  assert.equal(f.agent.search().total,0);assert.equal((await sync.work({route:'journal.list'},'http://127.0.0.1:5174') as {items:unknown[]}).items.length,0);assert.equal(sync.info().native_sources.length,0);
  assert.equal(String(f.agent.db.prepare('SELECT account FROM cloud_owner').get()?.account),`${owner.userId}:${owner.tenantId}`);
 }finally{await f.clean();}
});

test('same bytes from a different native capture stay separate and cannot redirect the original',async()=>{
 const f=await connectedFixture(),revision=randomUUID(),body='같은 바이트도 다른 원천일 수 있음';
 const session:CloudSession={apiUrl:'https://cloud.example',accessToken:'test',tenantId:randomUUID(),userId:randomUUID(),deviceId:randomUUID(),nativeSources:[{source_id:randomUUID(),root:f.root,kind:'folder',active:true,setup_state:'ready',pending:0,error:null,managed_root:false}]};
 let detailCalls=0;
 const request=(async(url:string|URL|Request)=>{
  const pathname=new URL(String(url)).pathname;
  if(pathname.endsWith('/context'))return Response.json({company:'원천구분회사',projects:[]});
  if(pathname.endsWith(`/materials/${revision}`)){detailCalls++;return Response.json({revision:{id:revision}});}
  return Response.json({items:[{id:revision,received_at:new Date().toISOString(),project_id:null,project_name:null,categories:[],sha256:sha256(body),client_capture_id:randomUUID(),capture_device_id:session.deviceId,source_kind:'folder',excerpt:body}],next_cursor:null});
 }) as typeof fetch;
 try{
  await writeFile(path.join(f.root,'다른파일.txt'),body);await f.agent.start();const sync=new LocalCloudSync(f.agent,async()=>session,request);await sync.sync();
  const journal=await sync.work({route:'journal.list'},'http://127.0.0.1:5174') as {items:{id:string}[]};assert.equal(journal.items.length,2);
  const detail=await sync.work({route:'materials.detail',id:revision},'http://127.0.0.1:5174') as {revision:{id:string}};assert.equal(detail.revision.id,revision);assert.equal(detailCalls,1);
 }finally{await f.clean();}
});

test('previous metadata delivery links only through the verified native-capture endpoint and stale native originals stay on the server',async()=>{
 const f=await connectedFixture(),revision=randomUUID(),body='기존 메타자료와 원본 연결';
 const session:CloudSession={apiUrl:'https://cloud.example',accessToken:'test',tenantId:randomUUID(),userId:randomUUID(),deviceId:randomUUID(),nativeSources:[{source_id:randomUUID(),root:f.root,kind:'folder',active:true,setup_state:'ready',pending:0,error:null,managed_root:false}]};
 let localId='',links=0,detailCalls=0;
 const request=(async(url:string|URL|Request,options?:RequestInit)=>{
  const pathname=new URL(String(url)).pathname;
  if(pathname.endsWith('/context'))return Response.json({company:'원본연결회사',projects:[]});
  if(pathname.endsWith('/native-links')){const requestBody=JSON.parse(String(options?.body));links++;assert.deepEqual(requestBody,{device_id:session.deviceId,items:[{id:localId,sha256:sha256(body),native_capture_id:windowsNativeCaptureId(session.nativeSources![0]!.source_id,'원문연결.txt',sha256(body))}]});return Response.json({items:[{local_id:localId,revision_id:revision,state:'linked'}]});}
  if(pathname.endsWith(`/materials/${revision}`)){detailCalls++;return Response.json({revision:{id:revision}});}
  return Response.json({items:[{id:revision,received_at:new Date().toISOString(),project_id:null,project_name:null,categories:[],sha256:sha256(body),client_capture_id:windowsNativeCaptureId(session.nativeSources![0]!.source_id,'원문연결.txt',sha256(body)),capture_device_id:session.deviceId,source_kind:'folder',excerpt:body}],next_cursor:null});
 }) as typeof fetch;
 try{
  await writeFile(path.join(f.root,'원문연결.txt'),body);await f.agent.start();localId=f.agent.search().documents[0]!.id;
  const sync=new LocalCloudSync(f.agent,async()=>session,request);f.agent.db.prepare('INSERT INTO cloud_delivery VALUES(?,?,?,?)').run(localId,`${session.userId}:${session.tenantId}`,'previous-metadata',randomUUID());await sync.sync();assert.equal(links,1);
  assert.equal(String(f.agent.db.prepare('SELECT fingerprint FROM cloud_delivery').get()?.fingerprint),`native:${sha256(body)}`);
  assert.equal((await sync.work({route:'materials.detail',id:revision},'http://127.0.0.1:5174') as {revision:{id:string}}).revision.id,localId);
  await writeFile(path.join(f.root,'원문연결.txt'),'원문이 수정됐음');await f.agent.start();
  assert.equal((await sync.work({route:'materials.detail',id:revision},'http://127.0.0.1:5174') as {revision:{id:string}}).revision.id,revision);assert.equal(detailCalls,1);
 }finally{await f.clean();}
});
