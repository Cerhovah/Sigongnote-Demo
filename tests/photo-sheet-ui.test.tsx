import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act} from 'react';
import {WorkPhotoSheet} from '../apps/web/src/work-photo-sheet.js';
import type {WorkClient,WorkRequest} from '../apps/web/src/work-client.js';
test('N31a photo sheet polling reuses immutable previews and permission refresh clears them',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),w=dom.window;
 Object.assign(globalThis,{window:w,document:w.document,location:w.location,HTMLElement:w.HTMLElement,Event:w.Event,CustomEvent:w.CustomEvent,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client'),root=createRoot(w.document.getElementById('root')!);
 let reads=0,previews=0,revoked=false,previewRevoked=false;
 const client:WorkClient={kind:'native',dispose(){},async request<T>(r:WorkRequest){
  if(r.route==='sheets.read'){reads++;if(revoked)throw Error('revoked');return {id:'sheet',state:reads===1?'queued':'succeeded',sha256:reads===1?null:'a'.repeat(64),pages:1,snapshot:{title:'내부 사진대지',project_name:'내부 현장',layout:4,grayscale:false,photos:[{revision_id:'photo',caption:'',location:'',taken_date:null,rotation:0}]}} as T;}
  if(r.route==='photos.preview'){previews++;if(previewRevoked)throw Error('revoked');return {base64:'AA=='} as T;}
  if(r.route==='deliveries.list')return {deliveries:[],recipients:[],project_id:'site',ready:false,max_cost_krw:null,gate:'연결 대기'} as T;
  throw Error('unexpected route');
 }};
 try{await act(async()=>root.render(<WorkPhotoSheet client={client} id="sheet"/>));assert.equal(previews,1);
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,3150));});assert.equal(reads,2);assert.equal(previews,1);assert.equal(w.document.querySelectorAll('img').length,1);
  await act(async()=>{const details=w.document.querySelector('details')!;details.open=true;details.dispatchEvent(new w.Event('toggle'));});
  const name=w.document.querySelector<HTMLInputElement>('form input')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value')!.set!.call(name,'시험 수신처');name.dispatchEvent(new w.Event('input',{bubbles:true}));});
  await act(async()=>{w.dispatchEvent(new w.Event('photos-changed'));});assert.equal(w.document.querySelector('form input'),name);assert.equal(name.value,'시험 수신처');assert.equal(previews,2);
  previewRevoked=true;await act(async()=>{w.dispatchEvent(new w.Event('photos-changed'));});assert.equal(w.document.querySelectorAll('img').length,0);assert.equal(name.value,'시험 수신처');
  revoked=true;await act(async()=>{w.dispatchEvent(new w.Event('photos-changed'));});assert.equal(w.document.querySelectorAll('img').length,0);assert.match(w.document.body.textContent!,/자료 권한/);
  revoked=false;await act(async()=>{w.dispatchEvent(new w.Event('photos-changed'));});assert.doesNotMatch(w.document.body.textContent!,/사진대지를 열지 못했어요/);
 }finally{await act(async()=>root.unmount());w.close();}
});
