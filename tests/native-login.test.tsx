import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act} from 'react';
import {WorkApp} from '../apps/web/src/work-app.js';
import {nativeWorkClient,WorkFailure,type WorkClient} from '../apps/web/src/work-client.js';

test('native sign-in opens the account screen directly without the old folder walkthrough',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://appassets.androidplatform.net/assets/work/index.html'}),win=dom.window;
 Object.assign(globalThis,{window:win,document:win.document,location:win.location,history:win.history,HTMLElement:win.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
 win.scrollTo=()=>{};
 const {createRoot}=await import('react-dom/client');const root=createRoot(win.document.getElementById('root')!);let opens=0;
 const client:WorkClient={kind:'native',dispose(){},openAccount(){opens++;},async request<T>(){throw new WorkFailure('login_required');}};
 try{
  await act(async()=>{root.render(<WorkApp client={client}/>);await new Promise(r=>setTimeout(r,20));});
  await act(async()=>{[...win.document.querySelectorAll('button')].find(b=>b.textContent==='같은 계정으로 로그인')!.click();});
  assert.equal(opens,1);assert.equal(win.document.querySelector('a[href="/assets/index.html"]'),null);
 }finally{await act(async()=>root.unmount());win.close();}
});

test('Android native account and camera actions reach the existing trusted bridge methods',()=>{
 const dom=new JSDOM('',{url:'https://appassets.androidplatform.net'}),win=dom.window;const sent:unknown[]=[];
 Object.assign(globalThis,{window:win});Object.assign(win,{SigongnoteNative:{postMessage:(value:string)=>sent.push(JSON.parse(value))}});
 const client=nativeWorkClient();try{client.openAccount!();client.capturePhoto!();const item=sent[0] as {method:string;payload:unknown;requestId:string};assert.equal(item.method,'openAccount');assert.deepEqual(item.payload,{});assert.ok(item.requestId);const camera=sent[1] as typeof item;assert.equal(camera.method,'openPhotoCapture');assert.deepEqual(camera.payload,{});assert.ok(camera.requestId);assert.notEqual(camera.requestId,item.requestId);}finally{client.dispose();win.close();}
});
