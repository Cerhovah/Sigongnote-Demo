import assert from 'node:assert/strict';import {test} from 'node:test';import {JSDOM} from 'jsdom';import {act} from 'react';import {CloudAccountPanel} from '../apps/web/src/cloud-account.js';
import {CloudApp} from '../apps/web/src/cloud-app.js';
test('N25 account panel exposes enabled providers and preserves a useful return path when linking is unavailable',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://fixture.example',pretendToBeVisual:true}),win=dom.window,oldFetch=globalThis.fetch;
 Object.assign(globalThis,{window:win,document:win.document,HTMLElement:win.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});const {createRoot}=await import('react-dom/client'),root=createRoot(win.document.getElementById('root')!);
 let closed=0,changed=0,starts=0;const user='11111111-1111-4111-8111-111111111111';
 globalThis.fetch=async(url,init)=>{if(String(url).includes('/web/session'))return Response.json({user_id:user,linked_providers:['custom:naver']});starts++;assert.deepEqual(JSON.parse(String(init?.body)),{provider:'custom:kakao',expected_user_id:user});return Response.json({error:{code:'IDENTITY_LINK_UNAVAILABLE'}},{status:503});};
 const flush=()=>act(async()=>{await new Promise(r=>setTimeout(r,0));});
 try{
  await act(async()=>root.render(<CloudAccountPanel user={user} providers={['custom:naver','custom:kakao']} onClose={()=>{closed++;}} onChanged={()=>{changed++;}}/>));await flush();
  assert.match(win.document.body.textContent??'',/네이버 · 연결됨/);assert.equal(win.document.activeElement?.id,'cloud-account-title');
  const link=[...win.document.querySelectorAll('button')].find(b=>b.textContent==='내 카카오로도 로그인하기')!;await act(async()=>link.click());await flush();assert.equal(starts,1);assert.match(win.document.body.textContent??'',/기존 회사와 자료는 그대로예요/);assert.equal(changed,0);
  await act(async()=>[...win.document.querySelectorAll('button')].find(b=>b.textContent==='회사로 돌아가기')!.click());assert.equal(closed,1);
 }finally{await act(async()=>root.unmount());globalThis.fetch=oldFetch;dom.window.close();}
});

test('N25 opening login settings preserves the work tree and browser back returns to the same input',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://fixture.example/?account=linked#/ask',pretendToBeVisual:true}),win=dom.window,oldFetch=globalThis.fetch;
 Object.assign(globalThis,{window:win,document:win.document,location:win.location,history:win.history,sessionStorage:win.sessionStorage,HTMLElement:win.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client'),root=createRoot(win.document.getElementById('root')!);const user='11111111-1111-4111-8111-111111111111',tenant='22222222-2222-4222-8222-222222222222';
 globalThis.fetch=async(url,init)=>{if(String(url)==='/connection.json')return Response.json({providers:['custom:naver']});if(String(url).startsWith('/web/session'))return Response.json({user_id:user,memberships:[{tenant_id:tenant,tenant_name:'합성 회사',role:'owner'}],linked_providers:['custom:naver']});const q=JSON.parse(String(init?.body)).request;return Response.json(q.route==='context'?{user_id:user,tenant_id:tenant,company:'합성 회사',projects:[]}:q.route==='guide.read'?{step:0,completed:true}:q.route==='sync.changes'?{changes:[],next_cursor:'0',has_more:false}:q.route==='conversations.list'?{conversations:[]}:{questions:[],documents:[],turns:[],messages:[]});};
 const flush=()=>act(async()=>{await new Promise(r=>setTimeout(r,30));});
 try{
  await act(async()=>root.render(<CloudApp/>));await flush();await flush();
  assert.equal(win.location.search,'');const input=win.document.querySelector('textarea')!;assert.ok(input);await act(async()=>{Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype,'value')!.set!.call(input,'작성 중인 합성 질문');input.dispatchEvent(new win.Event('input',{bubbles:true}));});
  await act(async()=>[...win.document.querySelectorAll('button')].find(b=>b.textContent==='내 로그인 수단')!.click());await flush();
  assert.equal(win.document.querySelector('textarea'),input);assert.ok(input.closest('[hidden]'));assert.equal(win.document.querySelector('h1#cloud-account-title')?.textContent,'내 로그인 수단');
  await act(async()=>{win.history.back();await new Promise(r=>setTimeout(r,30));});await flush();
  assert.equal(win.document.querySelector('#cloud-account-title'),null);assert.equal(win.location.hash,'#/ask');assert.equal(win.document.querySelector('textarea'),input);assert.equal(input.value,'작성 중인 합성 질문');assert.equal(input.closest('[hidden]'),null);
 }finally{await act(async()=>root.unmount());globalThis.fetch=oldFetch;dom.window.close();}
});
