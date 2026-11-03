import {workId} from '../apps/web/src/work-id.js';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act} from 'react';
import {WorkDraft} from '../apps/web/src/work-draft.js';
import {WorkDocumentHistory} from '../apps/web/src/work-documents.js';
import {WorkFailure,type WorkClient,type WorkRequest} from '../apps/web/src/work-client.js';

test('D17 unrelated document changes preserve an open confirmation and do not refetch its detail',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://localhost',pretendToBeVisual:true}),win=dom.window;
 Object.assign(globalThis,{window:win,document:win.document,HTMLElement:win.HTMLElement,Event:win.Event,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client'),root=createRoot(win.document.getElementById('root')!);
 const id=crypto.randomUUID(),project={id:crypto.randomUUID(),name:'합성현장'};let reads=0,lists=0;
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:WorkRequest){
  if(r.route==='documents.list'){lists++;return {documents:[{id,state:'approved',number:'Q-TEST',type:'estimate',project,total:'100',recipient:'합성고객'}]} as T;}
  if(r.route==='documents.issued'){reads++;return {id,state:'approved',snapshot_hash:'a'.repeat(64),render_state:'succeeded',files:[],document:{type:'estimate',document_number:'Q-TEST',project,recipient:{name:'합성고객'},lines:[],totals:{total:'100',supply:'100',tax:'0'}}} as T;}
  throw new Error('unexpected mutation');
 }};
 const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,20));});
 const click=async(text:string)=>{await act(async()=>{Array.from(win.document.querySelectorAll('button')).find(b=>b.textContent?.includes(text))!.click();});await settle();};
 try{
  await act(async()=>root.render(<WorkDocumentHistory client={client}/>));await settle();await click('Q-TEST');await click('문서 취소');
  await act(async()=>{win.dispatchEvent(new win.CustomEvent('documents-changed',{detail:{ids:[crypto.randomUUID()],reset:false}}));});await settle();
  assert.match(win.document.body.textContent??'',/문서 취소 확정/);assert.equal(reads,1);assert.equal(lists,1,'hidden list is not reloaded while a document confirmation is open');
 }finally{await act(async()=>root.unmount());win.close();}
});

test('D16 one confirmation retries same command, hides old draft and shows fixed partial output',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://localhost',pretendToBeVisual:true}),win=dom.window;
 Object.assign(globalThis,{window:win,document:win.document,HTMLElement:win.HTMLElement,Event:win.Event,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client'),root=createRoot(win.document.getElementById('root')!);
 const id=crypto.randomUUID(),issued=crypto.randomUUID(),commands:WorkRequest[]=[];let failures=0,available='825000';
 const document={basis_hash:'a'.repeat(64),type:'invoice',document_number:'I-0000001',issuer:{name:'합성회사'},recipient:{name:'합성고객'},project:{id:crypto.randomUUID(),name:'합성현장'},date:'2026-09-30',lines:[],totals:{supply:'1250000',tax:'125000',total:'1375000'}};
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:WorkRequest){
  if(r.route==='documents.read')return {id,state:'draft_ready',stale:false,missing:['이미 청구한 금액을 뺀 이번 청구 범위'],source_refs:[],document,billing:{available}} as T;
  if(r.route==='documents.list')return {documents:[]} as T;
  if(r.route==='documents.issue'){commands.push(r);if(failures++===0)throw new Error('response lost');if(failures===2)throw new WorkFailure('VERSION_CONFLICT');return {documents:[{id:issued}]} as T;}
  if(r.route==='documents.issued')return {id:issued,state:'approved',snapshot_hash:'b'.repeat(64),render_state:'succeeded',files:[{format:'pdf'},{format:'xlsx'}],document:{...document,totals:{supply:'750000',tax:'75000',total:'825000'}}} as T;
  throw new Error('unexpected route');
 }};
 const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,15));});
 try{
  const toIssue=()=>act(async()=>{assert.equal(win.document.querySelector('input[inputmode="numeric"]'),null);[...win.document.querySelectorAll('button')].find(b=>b.textContent==='이 내용으로 발행하러 가기')!.click();});
  await act(async()=>root.render(<WorkDraft client={client} id={id} onOpen={()=>{}}/>));await settle();await toIssue();
  assert.equal(win.document.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!.value,'825000');
  const submit=()=>act(async()=>{win.document.querySelector('.work-issue form')!.dispatchEvent(new win.Event('submit',{bubbles:true,cancelable:true}));});
  async function amount(value:string){await act(async()=>{const input=win.document.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!;Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new win.Event('input',{bubbles:true}));});}
  await amount('900000');await submit();await settle();assert.equal(commands.length,0);assert.match(win.document.body.textContent??'',/사이로 입력/);
  await amount('825000');await submit();await settle();assert.match(win.document.body.textContent??'',/발행 결과/);
  await submit();await settle();assert.deepEqual(commands[0],commands[1]);
  assert.match(win.document.body.textContent??'',/최신 자료로 다시 준비/);await submit();await settle();assert.notEqual((commands[1] as any).client_command_id,(commands[2] as any).client_command_id);
  assert.equal(win.document.querySelector('.work-draft'),null);
  assert.match(win.document.body.textContent??'',/PDF·엑셀 준비 완료/);assert.match(win.document.body.textContent??'',/825,000원/);
  assert.doesNotMatch(win.document.body.textContent??'',/1,375,000원|아직 발행하지/);
  available='0';await act(async()=>root.render(<WorkDraft key="zero" client={client} id={id} onOpen={()=>{}}/>));await settle();await toIssue();assert.equal(win.document.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!.value,'');assert.match(win.document.body.textContent??'',/새로 청구할 금액이 없어요/);
 }finally{await act(async()=>root.unmount());dom.window.close();}
});

test('D16 local LAN IDs retain secure UUID randomness without randomUUID',()=>{const original=crypto.randomUUID;Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true});try{const one=workId(),two=workId();assert.match(one,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);assert.notEqual(one,two);}finally{Object.defineProperty(crypto,'randomUUID',{value:original,configurable:true});}});
