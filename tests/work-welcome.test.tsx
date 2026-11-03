import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act} from 'react';
import {WorkGuide} from '../apps/web/src/work-guide.js';
import type {WorkClient,WorkRequest} from '../apps/web/src/work-client.js';

test('versioned guide appears once, resumes five steps and remeasures route targets',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/materials',pretendToBeVisual:true}),win=dom.window;
 Object.assign(globalThis,{window:win,document:win.document,HTMLElement:win.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
 win.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};win.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
 const {createRoot}=await import('react-dom/client');let root=createRoot(win.document.getElementById('root')!);let prepared=0;
 const saved:WorkRequest[]=[];
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(request:WorkRequest){saved.push(request);return (request.route==='guide.read'?{completed:true,step:2}:{saved:true}) as T;}};
 const render=async(scope='company:father',replay=0)=>act(async()=>root.render(<WorkGuide client={client} scope={scope} replay={replay} onStart={()=>{prepared++;}} onClose={()=>{}}/>));
 const click=async(text:string)=>{const b=[...win.document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.includes(text));assert.ok(b,text);await act(async()=>b.click());await act(async()=>{await new Promise(r=>setTimeout(r,20));});};
 const remount=async()=>{await act(async()=>root.unmount());root=createRoot(win.document.getElementById('root')!);};
 try{
  await render();assert.ok(win.document.querySelector('dialog[open] .guide-center'),'old completion must not hide the new guide');assert.equal(win.document.querySelector<HTMLInputElement>('input')!.checked,true);assert.equal(win.document.querySelectorAll('.welcome-features li').length,3);
  await click('사용법 함께 보기');assert.equal(prepared,1);assert.equal(win.document.querySelector('.guide-highlight'),null);
  await act(async()=>{const target=win.document.createElement('button');target.id='work-folder-entry';win.document.getElementById('root')!.append(target);await Promise.resolve();});assert.ok(win.document.querySelector('.guide-highlight'));
  await click('다음');await click('안내 닫기');assert.equal(win.document.querySelector('dialog'),null);await remount();await render();assert.match(win.document.querySelector('.progress-text')!.textContent!,/2 \/ 5/);
  await click('다음');await click('다음');await click('다음');await click('직접 해보기');await remount();await render();assert.equal(win.document.querySelector('dialog'),null);
  assert.ok(saved.filter(r=>r.route==='guide.save').every(r=>r.route==='guide.save'&&r.step>=0&&r.step<=2));
  await render('company:father',1);assert.ok(win.document.querySelector('.guide-center'));await click('바로 시작하기');
  await remount();await render('company:other');assert.ok(win.document.querySelector('dialog[open]'));
  await remount();win.sessionStorage.setItem('sigongnote:intro-shown','1');await render('company:new-cloud');assert.equal(win.document.querySelector('.guide-center'),null);assert.match(win.document.querySelector('.progress-text')!.textContent!,/1 \/ 5/);
  const address=win.location.href;assert.ok(win.history.state.workGuide);await act(async()=>{win.history.back();await new Promise(r=>setTimeout(r,20));});assert.equal(win.document.querySelector('dialog'),null,'phone/browser back dismisses the guide');assert.equal(win.location.href,address,'Back closes only the guide, keeping its underlying screen');
  await remount();const heading=win.document.createElement('h1');heading.id='screen-title';heading.tabIndex=-1;win.document.body.append(heading);const opener=win.document.createElement('button');win.document.body.append(opener);opener.focus();
  await render('company:focus');opener.remove();await click('바로 시작하기');assert.equal(win.document.activeElement,heading,'a removed opener falls back to the current screen heading');
 }finally{await act(async()=>root.unmount());win.close();}
});
