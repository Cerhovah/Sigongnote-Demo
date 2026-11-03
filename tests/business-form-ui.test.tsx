import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act} from 'react';
import type {WorkClient,WorkRequest} from '../apps/web/src/work-client.js';

test('business information survives failed save, blocks issuance while dirty, and is visible in the approval step',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://localhost',pretendToBeVisual:true}),win=dom.window;
 Object.assign(globalThis,{window:win,document:win.document,HTMLElement:win.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client'),{WorkDraft}=await import('../apps/web/src/work-draft.js'),root=createRoot(win.document.getElementById('root')!);
 const first=crypto.randomUUID(),next=crypto.randomUUID(),sent:WorkRequest[]=[];let saved:unknown={},fail=true;
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:WorkRequest){
  if(r.route==='documents.complete'){sent.push(r);if(fail){fail=false;throw Error('synthetic lost response');}saved=r.form;return {id:next} as T;}
  assert.equal(r.route,'documents.read');return {id:'id' in r?r.id:first,state:'draft_ready',stale:false,source_candidate:true,missing:[],source_refs:[],document:{type:'estimate',issuer:{name:'합성업체'},recipient:{name:'합성고객'},project:{id:crypto.randomUUID(),name:'합성현장'},date:'2030-01-01',basis_hash:'a'.repeat(64),form:saved,lines:[],totals:{supply:'100',tax:'10',total:'110'}}} as T;
 }};
 const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,10));});
 const button=(label:string)=>[...win.document.querySelectorAll('button')].find(b=>b.textContent===label)!;
 try{
  await act(async()=>root.render(<WorkDraft client={client} id={first} onOpen={()=>{}}/>));await settle();
  const businessForm=()=>win.document.querySelector<HTMLFormElement>('form[aria-label="문서 사업자 정보"]')!;
  const input=[...businessForm().querySelectorAll('label')].find(l=>l.textContent==='대표자')!.querySelector('input')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,'value')!.set!.call(input,'가상 대표');input.dispatchEvent(new win.Event('input',{bubbles:true}));});
  assert.equal(button('이 내용으로 발행하러 가기').disabled,true);
  const save=()=>act(async()=>{businessForm().dispatchEvent(new win.Event('submit',{bubbles:true,cancelable:true}));});
  await save();await settle();assert.equal(input.value,'가상 대표');assert.equal(button('이 내용으로 발행하러 가기').disabled,true);
  await save();await settle();assert.deepEqual(sent[0],sent[1]);assert.equal(sent[0]?.route,'documents.complete');assert.ok('form' in sent[0]!);assert.equal('lines' in sent[0]!,false);assert.equal((saved as any).issuer.representative,'가상 대표');assert.equal(button('이 내용으로 발행하러 가기').disabled,false);
  await act(async()=>button('이 내용으로 발행하러 가기').click());await settle();assert.match(win.document.body.textContent??'',/가상 대표/);assert.match(win.document.body.textContent??'',/직인 전용 빈칸/);assert.match(win.document.body.textContent??'',/사업자 정보 11개가 비어/);
 }finally{await act(async()=>root.unmount());dom.window.close();}
});
