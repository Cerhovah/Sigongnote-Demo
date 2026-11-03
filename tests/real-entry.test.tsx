import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act} from 'react';
import {entryMode} from '../apps/web/src/entry-mode.js';
import {CloudApp} from '../apps/web/src/cloud-app.js';
import {InstallApp} from '../apps/web/src/install-app.js';
import {serviceAddress} from '../apps/web/src/setup-install.js';

test('retired demonstration links cannot select synthetic data in public or local lab pages',()=>{
 for(const host of ['https://sigongnote-api.onrender.com','http://127.0.0.1:5190','http://localhost:5173'])for(const query of ['','?demo=1','?work=fixture','?work=preview','?work=1'])assert.equal(entryMode(host+'/'+query,false),'cloud');
 assert.equal(entryMode('https://sigongnote-api.onrender.com/install',false),'install');
 assert.equal(entryMode('https://sigongnote.work/?work=1',true),'native');
 assert.equal(entryMode('http://127.0.0.1:5174/?work=1',false),'local-work');
});

test('only configured logins are visible; missing provider is honest and install path has no example data',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://sigongnote-api.onrender.com/?login=retry'}),win=dom.window;
 const previousFetch=globalThis.fetch;
 Object.assign(globalThis,{window:win,document:win.document,location:win.location,HTMLElement:win.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
 win.localStorage.setItem('sigongnote:cloud-intro:v2','done');
 let providers=['google'],configFailed=false;globalThis.fetch=async input=>String(input)==='/connection.json'?(configFailed?Response.json({error:'temporary'},{status:503}):Response.json({providers})):Response.json({error:'LOGIN_REQUIRED'},{status:401});
 const {createRoot}=await import('react-dom/client');const root=createRoot(win.document.getElementById('root')!);
 const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,15));});
 try{
  await act(async()=>root.render(<CloudApp/>));await settle();
  assert.doesNotMatch(win.document.body.textContent??'',/네이버로|합성|체험/);
  assert.equal(win.document.querySelector('.naver-login')?.getAttribute('href'),'/web/auth/start?provider=google');
  providers=[];await act(async()=>root.render(<CloudApp key="unconfigured"/>));await settle();
  assert.equal(win.document.querySelector('a.naver-login'),null);
  assert.equal(win.document.querySelector('button.naver-login')?.hasAttribute('disabled'),true);
  assert.match(win.document.body.textContent??'',/지금 로그인에 연결하지 못했어요/);assert.match(win.document.body.textContent??'',/로그인이 완료되지 않았어요/);
  providers=['custom:naver'];configFailed=true;await act(async()=>root.render(<CloudApp key="connection-recovery"/>));await settle();assert.match(win.document.body.textContent??'',/서버에 연결하지 못했어요/);
  configFailed=false;await act(async()=>[...win.document.querySelectorAll('button')].find(x=>x.textContent==='다시 시도')!.click());await settle();
  assert.equal(win.document.querySelector('.naver-login')?.getAttribute('href'),'/web/auth/start?provider=custom%3Anaver');
  assert.equal(win.document.querySelector('a[href="/web/auth/start?provider=google"]'),null);
  await act(async()=>root.render(<InstallApp/>));const device=win.document.querySelector<HTMLSelectElement>('select')!;
  await act(async()=>{device.value='android';device.dispatchEvent(new win.Event('change',{bubbles:true}));});
  const download=win.document.querySelector<HTMLAnchorElement>('a[href="'+serviceAddress+'download/android"]')!;assert.equal(download.textContent,'Android 앱 받기');assert.equal(download.origin,new URL(serviceAddress).origin);
  assert.equal(win.document.querySelector('a[href="'+serviceAddress+'"]')?.textContent,'웹에서 바로 시작');assert.doesNotMatch(win.document.body.textContent??'',/합성|체험/);
 }finally{await act(async()=>root.unmount());win.close();globalThis.fetch=previousFetch;}
});
