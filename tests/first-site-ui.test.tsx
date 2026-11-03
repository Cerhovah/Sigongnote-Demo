import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act} from 'react';
import {randomUUID} from 'node:crypto';
import {WorkSetup} from '../apps/web/src/work-setup.js';
import type {WorkClient,WorkRequest} from '../apps/web/src/work-client.js';

test('adding a site reuses the site step only and returns the new site',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{pretendToBeVisual:true,url:'https://fixture.test'}),win=dom.window;win.scrollTo=()=>{};
 Object.assign(globalThis,{window:win,document:win.document,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(win.document.getElementById('root')!);
 const existing=randomUUID(),created=randomUUID();let exited='',name='';
 const client:WorkClient={kind:'remote',dispose(){},async request<T>(r:WorkRequest){
  if(r.route==='setup.read')return {project_id:existing,version:3,dismissed:false,completed:true} as T;
  if(r.route==='setup.command'){const c=JSON.parse(r.command);assert.equal(c.action,'select');assert.equal(c.expected_version,3);name=c.display_name;return {project_id:created,version:4,dismissed:false,completed:true} as T;}
  throw Error('Unexpected request');}};
 try{
  await act(async()=>root.render(<WorkSetup client={client} mode="site" context={{user_id:'u',tenant_id:'t',company:'합성',projects:[{id:existing,display_name:'기존 현장'}]}} onExit={id=>{exited=id??'';}} onBack={()=>{}}/>));
  assert.match(win.document.body.textContent!,/현장 추가/);assert.doesNotMatch(win.document.body.textContent!,/자료를 어떻게 모을까요/);
  const input=win.document.querySelector('input')!;await act(async()=>{Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,'value')!.set!.call(input,'새 현장');input.dispatchEvent(new win.Event('input',{bubbles:true}));});
  await act(async()=>{(win.document.querySelector('.button-primary') as HTMLButtonElement).click();});
  assert.equal(name,'새 현장');assert.equal(exited,created);
 }finally{await act(async()=>root.unmount());win.close();}
});
