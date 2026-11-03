import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act} from 'react';
import {WorkEvidence,evidenceCoverage,evidencePlace,evidenceStatus} from '../apps/web/src/work-evidence.js';
import {workHttp,WorkRequestSchema} from '../packages/contracts/src/index.js';
import type {WorkClient} from '../apps/web/src/work-client.js';

test('N02 evidence route keeps bounded opaque cursors and fixed authenticated path',()=>{
 const id=crypto.randomUUID();assert.deepEqual(workHttp({route:'evidence.chunks',id,cursor:'abc_123-'}),{path:`/v1/evidence/${id}/chunks?cursor=abc_123-`,method:'GET'});
 assert.equal(WorkRequestSchema.safeParse({route:'evidence.chunks',id,cursor:'x'.repeat(241)}).success,false);
 assert.equal(WorkRequestSchema.safeParse({route:'evidence.chunks',id,cursor:'../../other'}).success,false);
 assert.equal(WorkRequestSchema.safeParse({route:'evidence.chunks',id,tenant_id:crypto.randomUUID()}).success,false);
 assert.equal(evidencePlace('sheet:1/cell:A1001'),'시트 2 · A1001');assert.equal(evidenceCoverage({pages_read:2,pages_seen:3}),'3쪽 중 2쪽 읽음');
 assert.equal(evidencePlace('page:2',{chunk_index:2}),'2쪽 · 3번째 묶음');
 assert.match(evidenceStatus('encrypted',{}),/암호/);assert.match(evidenceStatus('unsupported',{}),/아직 읽지/);
 assert.match(evidenceStatus('partial',{pages_read:200,next_page:201}),/200쪽까지만/);
 assert.match(evidenceStatus('failed',{}),/정상적으로 열리는지/);
});

test('N02 evidence viewer pages, retries and discards cancelled/withdrawn responses',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://localhost',pretendToBeVisual:true}),win=dom.window;
 Object.assign(globalThis,{window:win,document:win.document,HTMLElement:win.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client'),root=createRoot(win.document.getElementById('root')!);
 const id=crypto.randomUUID(),job=crypto.randomUUID();let mode='first',resolveLate:((v:unknown)=>void)|undefined;
 const page=(text:string,next:string|null,ordinal=0)=>({revision_id:id,index_job_id:job,source_hash:'a'.repeat(64),parser_version:'test',source_status:'partial',coverage:{pages_seen:3,pages_read:2},complete_extracted_text:true,indexed_chunks:1005,index_status:'complete',chunks:[{ordinal,text,locator:'page:2',position:{}}],next_cursor:next});
 const requests:Parameters<WorkClient['request']>[0][]=[];
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(request:Parameters<WorkClient['request']>[0]){requests.push(request);if(mode==='late')return await new Promise<unknown>(r=>{resolveLate=r;}) as T;if(mode==='fail')throw Error('temporary');if(mode==='withdrawn')throw Object.assign(Error('gone'),{code:'NOT_FOUND'});return page(mode==='first'?'첫 내용':'1001번째 근거',mode==='first'?'next':null,mode==='first'?0:1000) as T;}};
 const click=async(label:string)=>act(async()=>{const button=[...win.document.querySelectorAll('button')].find(b=>b.textContent===label);assert.ok(button);button.click();});
 try{
  await act(async()=>root.render(<WorkEvidence client={client} id={id} fallback={[{text:'이전 발췌',locator:'line:1'}]}/>));
  assert.match(win.document.body.textContent??'',/3쪽 중 2쪽 읽음/);assert.match(win.document.body.textContent??'',/첫 내용/);
  mode='late';await click('다음 내용 보기');await click('불러오기 취소');await act(async()=>resolveLate?.(page('늦은 내용',null)));assert.doesNotMatch(win.document.body.textContent??'',/늦은 내용/);
  mode='fail';await click('다시 시도');assert.match(win.document.body.textContent??'',/다시 시도해/);
  mode='last';await click('다시 시도');assert.match(win.document.body.textContent??'',/1001번째 근거/);assert.doesNotMatch(win.document.body.textContent??'',/첫 내용/);
  mode='withdrawn';await click('읽은 내용 새로고침');assert.match(win.document.body.textContent??'',/연결이 해제/);assert.doesNotMatch(win.document.body.textContent??'',/1001번째 근거|이전 발췌/);
  assert.ok(requests.every(r=>r.route==='evidence.chunks'&&r.id===id));assert.deepEqual(requests.map(r=>r.route==='evidence.chunks'?r.cursor:null),[undefined,'next','next','next',undefined]);
 }finally{await act(async()=>root.unmount());win.close();}
});

test('N02 PDF progress refreshes only while this viewer is mounted and active',async(t)=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://localhost',pretendToBeVisual:true}),win=dom.window;
 Object.assign(globalThis,{window:win,document:win.document,HTMLElement:win.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client'),root=createRoot(win.document.getElementById('root')!);
 const id=crypto.randomUUID();let calls=0,finished=false;const cursors:(string|undefined)[]=[];
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(request:Parameters<WorkClient['request']>[0]){if(request.route!=='evidence.chunks')throw Error('unexpected route');calls++;cursors.push(request.cursor);if(finished&&request.cursor)throw Object.assign(Error('new index'),{code:'VERSION_CONFLICT'});return {revision_id:id,index_job_id:null,source_hash:'a'.repeat(64),parser_version:null,source_status:finished?'complete':'pending',coverage:finished?{pages_seen:203,pages_read:203}:{pdf_processing:{state:'queued',pages_seen:203,pages_processed:200}},complete_extracted_text:finished,indexed_chunks:0,index_status:finished?'complete':'legacy_excerpt_only',chunks:[],next_cursor:finished?null:'next'} as T;}};
 t.mock.timers.enable({apis:['setTimeout']});
 try{
  await act(async()=>root.render(<WorkEvidence client={client} id={id} fallback={[]}/>));
  assert.match(win.document.body.textContent??'',/203쪽 중 200쪽까지 확인/);assert.match(win.document.body.textContent??'',/화면을 닫아도 계속/);
  await act(async()=>{[...win.document.querySelectorAll('button')].find(b=>b.textContent==='다음 내용 보기')!.click();});assert.equal(calls,2);
  await act(async()=>{t.mock.timers.tick(4000);});assert.equal(calls,3);assert.equal(cursors.at(-1),'next','polling retains the reader page');
  finished=true;await act(async()=>{t.mock.timers.tick(4000);});assert.equal(calls,5);assert.deepEqual(cursors.slice(-2),['next',undefined],'a newly published index restarts once without showing an error');
  await act(async()=>{t.mock.timers.tick(12000);});assert.equal(calls,5);assert.doesNotMatch(win.document.body.textContent??'',/갱신됐어요|다시 시도/);
  assert.doesNotMatch(win.document.body.textContent??'',/자동으로 이어 읽고/);
 }finally{await act(async()=>root.unmount());await act(async()=>{t.mock.timers.tick(12000);});assert.equal(calls,5);t.mock.timers.reset();win.close();}
});

test('N02 stopped PDF resumes the observed job once and preserves its checkpoint in the screen',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://localhost',pretendToBeVisual:true}),win=dom.window;
 Object.assign(globalThis,{window:win,document:win.document,HTMLElement:win.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client'),root=createRoot(win.document.getElementById('root')!);
 const id=crypto.randomUUID(),job=crypto.randomUUID();let resumed=false;const commands:string[]=[];
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:Parameters<WorkClient['request']>[0]){
  if(r.route==='evidence.resume'){commands.push(r.command);resumed=true;return {resumed:true} as T;}
  return {revision_id:id,index_job_id:null,source_hash:'a'.repeat(64),parser_version:null,source_status:'pending',coverage:{pdf_processing:{state:resumed?'queued':'dead',pages_seen:220,pages_processed:200,job_id:job,resume_generation:3,can_resume:!resumed}},complete_extracted_text:false,indexed_chunks:0,index_status:'pending',chunks:[],next_cursor:null} as T;
 }};
 try{
  await act(async()=>root.render(<WorkEvidence client={client} id={id} fallback={[]}/>));
  assert.match(win.document.body.textContent!,/200쪽까지 처리 기록/);
  await act(async()=>{[...win.document.querySelectorAll('button')].find(b=>b.textContent==='이어서 읽기 재개')!.click();});
  assert.deepEqual(commands.map(c=>JSON.parse(c)),[{job_id:job,resume_generation:3}]);
  assert.match(win.document.body.textContent!,/220쪽 중 200쪽까지 확인/);assert.doesNotMatch(win.document.body.textContent!,/이어서 읽기 재개/);
 }finally{await act(async()=>root.unmount());win.close();}
});
