import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act} from 'react';
import {createFieldLedgerSnapshot,type FieldLedgerBundle,type FieldLedgerRecord} from '../packages/domain/src/field-ledger.js';
import {WorkFieldLedger,shareFieldLedgerFile,type FieldLedgerClient,type FieldLedgerQuery} from '../apps/web/src/work-field-ledger.js';

// Synthetic records belong only to this isolated regression test, never the demo seed.
function record(id:string,overrides:Partial<FieldLedgerRecord>={}):FieldLedgerRecord{return {
 id,projectId:'p1',projectName:'시험 현장',occurredAt:'2026-10-01',receivedAt:'2026-10-02T01:00:00Z',
 type:'청구',party:'시험 공급처',item:'시험 품목',quantity:'2개',amountMinor:'12000',request:'첫 청구 내역',
 change:null,status:'청구 접수',attribution:'assigned',confirmation:'pending',nextAction:null,
 previousIds:[],sourceIds:['s1'],updatedAt:null,origin:'import',...overrides,
};}
function data():FieldLedgerBundle{return {schemaVersion:1,projects:[{id:'p1',name:'시험 현장'},{id:'p2',name:'비교 현장'}],sources:[{id:'s1',kind:'document',label:'시험 청구서',locator:'1쪽 2행',url:'/api/sources/s1'},{id:'s2',kind:'sms',label:'시험 문자',locator:'기록 2',url:'/api/sources/s2'}],records:[record('r1'),record('r2',{request:'별도 귀속 기록',attribution:'review',confirmation:'recorded',amountMinor:null,sourceIds:['s2']})]};}
const buttons=(win:JSDOM['window'],label:string)=>Array.from(win.document.querySelectorAll<HTMLButtonElement>('button')).filter(button=>button.textContent?.trim()===label);
function clientFor(initial=data()){
 let bundle=initial,fail=false;const queries:FieldLedgerQuery[]=[],uploads:{file:File;projectId:string|null}[]=[];
 const client:FieldLedgerClient={async projects(){return bundle.projects;},async snapshot(query){queries.push(query);if(fail)throw Error('offline');return createFieldLedgerSnapshot(bundle,query,'2026-11-04T01:00:00Z');},async upload(file,projectId){uploads.push({file,projectId});bundle={...bundle,sources:[...bundle.sources,{id:'s-new',kind:'file',label:file.name,locator:'추가 자료 1',url:'/api/sources/s-new'}],records:[...bundle.records,record('r-new',{request:'새로 반영된 변경 요청',type:'변경',change:'시험 규격 A → B',sourceIds:['s-new'],previousIds:['r1'],receivedAt:'2026-11-04T01:02:00Z',occurredAt:'2026-11-04',nextAction:'변경 수량 확인'})]};},exportUrl(id,format){return `/api/snapshots/${id}.${format}`;}};
 return {client,queries,uploads,fail(){fail=true;},changeSource(){bundle={...bundle,sources:bundle.sources.map(source=>source.id==='s1'?{...source,label:'갱신된 청구서'}:source)};}};
}
async function mounted(client:FieldLedgerClient,initialFailure=false){
 const dom=new JSDOM('<div id="root"></div>',{pretendToBeVisual:true,url:'http://127.0.0.1:8768/'}),win=dom.window;
 Object.assign(globalThis,{window:win,document:win.document,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client'),root=createRoot(win.document.getElementById('root')!);
 await act(async()=>root.render(<WorkFieldLedger client={client}/>));
 const until=async(predicate:()=>boolean)=>{for(let i=0;i<100&&!predicate();i++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});assert(predicate(),'expected UI state did not arrive');};
 await until(()=>Boolean(win.document.querySelector(initialFailure?'[role="alert"]':'.fl-summary')));
 return {dom,win,root,until,close:async()=>{await act(async()=>root.unmount());win.close();}};
}

test('field ledger separates attribution review from pending confirmation and keeps normal records out of questions',async()=>{
 const mock=clientFor(),ui=await mounted(mock.client),{win}=ui;
 try{
  assert.equal(mock.queries.at(-1)?.attribution,'assigned');
  assert.match(win.document.body.textContent!,/첫 청구 내역/);assert.doesNotMatch(win.document.body.textContent!,/별도 귀속 기록/);
  assert.match(win.document.querySelector('.fl-attention-panel')!.textContent!,/확인할 업무가 없습니다/);
  const assigned=win.document.querySelector('[data-state-kind="attribution"][data-state="assigned"]');assert(assigned);assert(win.document.querySelector('[data-state-kind="confirmation"][data-state="pending"]'));
  const review=Array.from(win.document.querySelectorAll<HTMLButtonElement>('.fl-scope-switch button')).find(button=>button.textContent!.startsWith('귀속 검토'))!;
  await act(async()=>review.click());await ui.until(()=>win.document.body.textContent!.includes('별도 귀속 기록'));
  assert.equal(mock.queries.at(-1)?.attribution,'review');assert(win.document.querySelector('[data-state-kind="attribution"][data-state="review"]'));assert(win.document.querySelector('[data-state-kind="confirmation"][data-state="recorded"]'));
  assert.doesNotMatch(win.document.querySelector('.fl-record-list')!.textContent!,/첫 청구 내역/);
 }finally{await ui.close();}
});

test('new input updates ledger, change and snapshot exports; source locator and prior record open from the same snapshot',async()=>{
 const mock=clientFor(),ui=await mounted(mock.client),{win}=ui;
 try{
  await act(async()=>win.document.querySelector<HTMLButtonElement>('.fl-tabs button:last-child')!.click());
  const oldCsv=win.document.querySelector<HTMLAnchorElement>('a[download][href$=".csv"]')!.href;
  const file=new win.File(['isolated test source'],'new-source.txt',{type:'text/plain'}),input=win.document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input,'files',{configurable:true,value:[file]});
  await act(async()=>input.dispatchEvent(new win.Event('change',{bubbles:true})));await ui.until(()=>win.document.body.textContent!.includes('새 자료를 원장에 반영했습니다.'));
  assert.equal(mock.uploads.length,1);assert.equal(mock.uploads[0]!.projectId,'p1');
  const newCsv=win.document.querySelector<HTMLAnchorElement>('a[download][href$=".csv"]')!.href;assert.notEqual(newCsv,oldCsv);
  const newPdf=win.document.querySelector<HTMLAnchorElement>('a[download][href$=".pdf"]')!.href;assert.equal(newCsv.replace('.csv',''),newPdf.replace('.pdf',''));
  await act(async()=>win.document.querySelectorAll<HTMLButtonElement>('.fl-tabs button')[3]!.click());
  assert.match(win.document.body.textContent!,/시험 규격 A → B/);assert.match(win.document.body.textContent!,/변경 수량 확인/);
  await act(async()=>buttons(win,'근거와 이전 기록 보기 →')[0]!.click());
  const dialog=win.document.querySelector('[role="dialog"]')!;assert.match(dialog.textContent!,/추가 자료 1/);assert.match(dialog.textContent!,/첫 청구 내역/);
  assert.equal(dialog.querySelector<HTMLAnchorElement>('a')!.getAttribute('href'),'http://127.0.0.1:8768/api/sources/s-new');
  await act(async()=>Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent!.includes('첫 청구 내역'))!.click());
  assert.match(win.document.querySelector('[role="dialog"]')!.textContent!,/1쪽 2행/);
 }finally{await ui.close();}
});

test('filters and refresh preserve the chosen scope and keep prior records visible on a network error',async()=>{
 const mock=clientFor(),ui=await mounted(mock.client),{win}=ui;
 try{
  await act(async()=>win.document.querySelectorAll<HTMLButtonElement>('.fl-tabs button')[1]!.click());
  const search=win.document.querySelector<HTMLInputElement>('[aria-label="기록 검색"]')!;
  const setter=Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,'value')!.set!;
  await act(async()=>{setter.call(search,'첫 청구');search.dispatchEvent(new win.Event('input',{bubbles:true}));search.dispatchEvent(new win.Event('change',{bubbles:true}));});
  await act(async()=>win.document.querySelector<HTMLFormElement>('.fl-filters')!.dispatchEvent(new win.Event('submit',{bubbles:true,cancelable:true})));
  await ui.until(()=>mock.queries.at(-1)?.search==='첫 청구');
  mock.fail();await act(async()=>win.dispatchEvent(new win.Event('focus')));await ui.until(()=>Boolean(win.document.querySelector('[role="alert"]')));
  assert.equal(mock.queries.at(-1)?.search,'첫 청구');assert.equal(mock.queries.at(-1)?.attribution,'assigned');assert.match(win.document.querySelector('.fl-record-list')!.textContent!,/첫 청구 내역/);
  await act(async()=>buttons(win,'조건 지우기')[0]!.click());await ui.until(()=>mock.queries.at(-1)?.search===undefined);
 }finally{await ui.close();}
});

test('an open evidence detail retains its snapshot while a background refresh brings a newer source',async()=>{
 const mock=clientFor(),ui=await mounted(mock.client),{win}=ui;
 try{
  await act(async()=>win.document.querySelector<HTMLButtonElement>('.fl-record-button')!.click());assert.match(win.document.querySelector('[role="dialog"]')!.textContent!,/시험 청구서/);
  mock.changeSource();const prior=mock.queries.length;await act(async()=>win.dispatchEvent(new win.Event('focus')));await ui.until(()=>mock.queries.length>prior);await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});
  assert.match(win.document.querySelector('[role="dialog"]')!.textContent!,/시험 청구서/);assert.doesNotMatch(win.document.querySelector('[role="dialog"]')!.textContent!,/갱신된 청구서/);
  await act(async()=>win.document.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));assert.equal(win.document.querySelector('[role="dialog"]'),null);
  await act(async()=>win.document.querySelector<HTMLButtonElement>('.fl-record-button')!.click());assert.match(win.document.querySelector('[role="dialog"]')!.textContent!,/갱신된 청구서/);
 }finally{await ui.close();}
});


test('a failed initial project request can be retried without reloading the application',async()=>{
 const mock=clientFor();let calls=0;const client={...mock.client,async projects(){calls++;if(calls===1)throw Error('offline');return mock.client.projects();}};
 const ui=await mounted(client,true),{win}=ui;
 try{
  assert.equal(calls,1);await act(async()=>buttons(win,'다시 불러오기')[0]!.click());await ui.until(()=>Boolean(win.document.querySelector('.fl-summary')));
  assert.equal(calls,2);assert.match(win.document.body.textContent!,/첫 청구 내역/);assert.equal(win.document.querySelector('[role="alert"]'),null);
 }finally{await ui.close();}
});


test('file sharing pins clicked snapshot bytes, handles cancellation, and falls back to file download',async()=>{
 const mock=clientFor(),ui=await mounted(mock.client),{win}=ui;const requested:string[]=[],shared:File[]=[];let release:(response:Response)=>void=()=>{};
 Object.defineProperty(win,'fetch',{configurable:true,value:async(url:string)=>{requested.push(url);return new Promise<Response>(resolve=>{release=resolve;});}});
 Object.defineProperty(win.navigator,'canShare',{configurable:true,value:()=>true});Object.defineProperty(win.navigator,'share',{configurable:true,value:async(data:ShareData)=>{shared.push(...data.files??[]);}});
 try{
  await act(async()=>win.document.querySelector<HTMLButtonElement>('.fl-tabs button:last-child')!.click());
  const originalUrl=win.document.querySelector<HTMLAnchorElement>('a[download][href$=".pdf"]')!.href,originalId=originalUrl.split('/').at(-1)!.replace('.pdf','');
  await act(async()=>buttons(win,'PDF 파일 공유 ↗')[0]!.click());assert.equal(requested[0],originalUrl);
  mock.changeSource();await act(async()=>win.dispatchEvent(new win.Event('focus')));await ui.until(()=>win.document.querySelector<HTMLAnchorElement>('a[download][href$=".pdf"]')!.href!==originalUrl);
  await act(async()=>release(new Response('%PDF-test',{headers:{'content-type':'application/pdf'}})));await ui.until(()=>win.document.body.textContent!.includes('파일 공유 창을 열었습니다.'));
  assert.equal(shared.length,1);assert.equal(shared[0]!.type,'application/pdf');assert.match(shared[0]!.name,new RegExp(originalId.slice(0,12)));assert.equal(shared[0]!.size,9);
  Object.defineProperty(win,'fetch',{configurable:true,value:async()=>new Response('first,second\r\nvalue,value')});
  Object.defineProperty(win.navigator,'share',{configurable:true,value:async()=>{throw new win.DOMException('cancelled','AbortError');}});
  await act(async()=>buttons(win,'CSV 파일 공유 ↗')[0]!.click());await ui.until(()=>win.document.body.textContent!.includes('공유를 취소했습니다.'));assert.doesNotMatch(win.document.querySelector('[role="status"]')!.textContent!,/파일을 저장|공유 창/);
  Object.defineProperty(win.navigator,'canShare',{configurable:true,value:()=>false});let saved:File|undefined,download='';
  Object.defineProperty(win.URL,'createObjectURL',{configurable:true,value:(file:File)=>{saved=file;return 'blob:local-test';}});Object.defineProperty(win.URL,'revokeObjectURL',{configurable:true,value:()=>{}});
  const originalClick=win.HTMLAnchorElement.prototype.click;win.HTMLAnchorElement.prototype.click=function(){download=this.download;};
  try{assert.equal(await shareFieldLedgerFile(mock.client,originalId,'csv'),'saved');assert(saved);assert.equal(saved.type,'text/csv;charset=utf-8');assert.equal(download,saved.name);}finally{win.HTMLAnchorElement.prototype.click=originalClick;}
 }finally{await ui.close();}
});

test('first structured import populates and selects its project without an application reload',async()=>{
 let bundle:FieldLedgerBundle={schemaVersion:1,projects:[],sources:[],records:[]};let projectRequests=0;
 const client:FieldLedgerClient={async projects(){projectRequests++;return bundle.projects;},async snapshot(query){return createFieldLedgerSnapshot(bundle,query);},async upload(){bundle=data();},exportUrl(id,format){return `/api/snapshots/${id}.${format}`;}};
 const ui=await mounted(client),{win}=ui;
 try{
  assert.equal(win.document.querySelector('h1')!.textContent,'전체 현장');
  const input=win.document.querySelector<HTMLInputElement>('input[type="file"]')!,file=new win.File(['{}'],'test-bundle.json',{type:'application/json'});Object.defineProperty(input,'files',{configurable:true,value:[file]});
  await act(async()=>input.dispatchEvent(new win.Event('change',{bubbles:true})));await ui.until(()=>win.document.querySelector('h1')!.textContent==='시험 현장'&&win.document.body.textContent!.includes('첫 청구 내역'));
  assert.equal(win.document.querySelector<HTMLSelectElement>('[aria-label="현장 선택"]')!.value,'p1');assert.equal(projectRequests,1);assert.match(win.document.querySelector<HTMLSelectElement>('[aria-label="현장 선택"]')!.textContent!,/비교 현장/);
 }finally{await ui.close();}
});


test('recent arrivals compare UTC and KST timestamps by instant, with undated records last and stable ID order',async()=>{
 const bundle=data();bundle.records=[record('older-kst',{request:'이전 한국시간 접수',receivedAt:'2026-11-04T10:00:00+09:00'}),record('newer-utc',{request:'최근 UTC 접수',receivedAt:'2026-11-04T01:30:00Z'}),record('z-undated',{request:'날짜 없는 뒤 기록',receivedAt:null}),record('a-undated',{request:'날짜 없는 앞 기록',receivedAt:null})];
 const mock=clientFor(bundle),ui=await mounted(mock.client);
 try{assert.deepEqual(Array.from(ui.win.document.querySelectorAll('.fl-record-list .fl-record-title')).map(element=>element.textContent),['최근 UTC 접수','이전 한국시간 접수','날짜 없는 앞 기록','날짜 없는 뒤 기록']);}finally{await ui.close();}
});

test('an unassigned upload from all projects stays visible in attribution review when projects already exist',async()=>{
 let bundle=data();let uploadedProject:string|null|undefined;
 const client:FieldLedgerClient={async projects(){return bundle.projects;},async snapshot(query){return createFieldLedgerSnapshot(bundle,query);},async upload(_file,projectId){uploadedProject=projectId;bundle={...bundle,records:[...bundle.records,record('unassigned-new',{projectId:null,projectName:null,attribution:'review',confirmation:'recorded',amountMinor:null,request:'새 현장 미지정 접수'})]};},exportUrl(id,format){return `/api/snapshots/${id}.${format}`;}};
 const ui=await mounted(client),{win}=ui;
 try{
  const picker=win.document.querySelector<HTMLSelectElement>('[aria-label="현장 선택"]')!;
  await act(async()=>{picker.value='';picker.dispatchEvent(new win.Event('change',{bubbles:true}));});
  await ui.until(()=>win.document.querySelector('h1')!.textContent==='전체 현장'&&Boolean(win.document.querySelector('.fl-summary')));
  const input=win.document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input,'files',{configurable:true,value:[new win.File(['test receipt'],'unassigned.txt',{type:'text/plain'})]});
  await act(async()=>input.dispatchEvent(new win.Event('change',{bubbles:true})));
  await ui.until(()=>Boolean(win.document.querySelector('.fl-record-list')?.textContent?.includes('새 현장 미지정 접수')));
  assert.equal(uploadedProject,null);assert.equal(picker.value,'');assert.equal(win.document.querySelector('h1')!.textContent,'전체 현장');
  assert.match(win.document.querySelector('.fl-scope-switch [aria-pressed="true"]')!.textContent!,/귀속 검토/);
  assert.equal(win.document.querySelector('.fl-tabs [aria-current="page"]')!.textContent,'현장 업무원장업무원장');
 }finally{await ui.close();}
});
