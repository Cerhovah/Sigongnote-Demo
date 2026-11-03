import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act} from 'react';
import {WorkDraft} from '../apps/web/src/work-draft.js';
import type {WorkClient,WorkRequest} from '../apps/web/src/work-client.js';
test('D14 UI asks only missing recipient, retries the same answer, and never offers issuance',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://localhost',pretendToBeVisual:true}),win=dom.window;
 Object.assign(globalThis,{window:win,document:win.document,HTMLElement:win.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client'),root=createRoot(win.document.getElementById('root')!);
 const commands:WorkRequest[]=[],id=crypto.randomUUID(),next=crypto.randomUUID();let fail=true;
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:WorkRequest){
  if(r.route==='documents.complete'){commands.push(r);if(fail){fail=false;throw new Error('lost response');}return {id:next} as T;}
  if(r.route!=='documents.read')throw new Error('unexpected route');
  return {id:r.id,state:r.id===next?'draft_ready':'needs_inputs',stale:r.id===next,source_candidate:true,missing:r.id===next?[]:['받는 곳'],source_refs:[],document:{type:'estimate',issuer:{name:'합성회사'},recipient:{name:r.id===next?'고객':null},project:{name:'합성현장'},date:'2026-09-30',lines:[],totals:{supply:null,tax:null,total:null}}} as T;
 }};
 const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,10));});
 try{
  await act(async()=>root.render(<WorkDraft client={client} id={id} onOpen={()=>{}}/>));await settle();
  assert.equal(win.document.querySelectorAll('input').length,1);assert.match(win.document.body.textContent??'',/확인 필요/);assert.doesNotMatch(win.document.body.textContent??'',/0원/);
  await act(async()=>{const input=win.document.querySelector('input')!;Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,'value')!.set!.call(input,'고객');input.dispatchEvent(new win.Event('input',{bubbles:true}));});
  const submit=()=>act(async()=>{win.document.querySelector('form')!.dispatchEvent(new win.Event('submit',{bubbles:true,cancelable:true}));});
  await submit();await settle();assert.match(win.document.body.textContent??'',/같은 답변/);await submit();await settle();assert.deepEqual(commands[0],commands[1]);assert.match(win.document.body.textContent??'',/합성회사 → 고객/);
  await act(async()=>{[...win.document.querySelectorAll('button')].find(b=>b.textContent==='최신 자료로 다시 준비')!.click();});await settle();const refresh=commands.at(-1)!;assert.equal(refresh.route,'documents.complete');assert.equal('recipient' in refresh,false);assert.equal('margin_bps' in refresh,false);
  assert.equal([...win.document.querySelectorAll('button')].some(b=>/발행|공유/.test(b.textContent??'')),false);
 }finally{await act(async()=>root.unmount());dom.window.close();}
});
