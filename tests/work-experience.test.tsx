import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act} from 'react';
import {WorkDocumentHistory} from '../apps/web/src/work-documents.js';
import {WorkReading} from '../apps/web/src/work-reading.js';
import {buildReadiness} from '../services/api/src/readiness.js';
import {renderToStaticMarkup} from 'react-dom/server';
import type {WorkClient,WorkContext} from '../apps/web/src/work-client.js';
import {WorkApp} from '../apps/web/src/work-app.js';
import {previewWorkClient} from '../apps/web/src/work-preview-client.js';

test('N26 discovery, pending transfer and withdrawn permission never imply full reading',()=>{
 const value=buildReadiness([{id:crypto.randomUUID(),kind:'folder',active:true,device_active:true,server_upload_consent:true,permission:'revoked',reported_permission:null,capability:'passive',last_successful_scan_at:new Date(),permission_checked_at:new Date(),last_error_code:null,pending_count:4}],{});
 const html=renderToStaticMarkup(<WorkReading value={value} onFolders={()=>{}}/>);
 assert.match(html,/내 자료 위치 1곳 중 1곳 살펴봄/);assert.match(html,/권한을 다시 연결/);assert.match(html,/읽은 범위는 자료를 열어/);assert.doesNotMatch(html,/판독 완료|disabled/);
 const empty=renderToStaticMarkup(<WorkReading value={buildReadiness([],{})} onFolders={()=>{}}/>);assert.match(empty,/업무 폴더를 한 번 연결/);assert.match(empty,/>업무 폴더 연결</);
 assert.match(renderToStaticMarkup(<WorkReading value={undefined}/>),/아직 확인하지 못했어요/);
});

test('N26 documents distinguish drafts and issued copies in the selected site, retain last list on failure',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost',pretendToBeVisual:true}),win=dom.window;
 Object.assign(globalThis,{window:win,document:win.document,HTMLElement:win.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client'),root=createRoot(win.document.getElementById('root')!);
 const context:WorkContext={user_id:'user',tenant_id:'tenant',company:'합성',projects:[{id:'one',display_name:'합성 첫 현장'},{id:'two',display_name:'합성 둘째 현장'}]};
 let project='one',opened='',failed=false;
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(){if(failed)throw Error('offline');return {prepared:[{id:'draft-one',type:'estimate',project_id:'one',work_label:'준비할 창틀'},{id:'draft-two',type:'estimate',project_id:'two',work_label:'준비할 도장'}],documents:[{id:'issued-one',state:'approved',number:'Q-FIRST',type:'estimate',project:{id:'one',name:'첫 현장'},total:'100',recipient:'발행 받는 곳'},{id:'issued-two',state:'replaced',number:'Q-SECOND',type:'estimate',project:{id:'two',name:'둘째 현장'},total:'200',recipient:'다른 받는 곳'}]} as T;}};
 const render=()=>root.render(<WorkDocumentHistory client={client} context={context} project={project} onProject={v=>{project=v;render();}} onDraft={id=>{opened=id;}} onSelect={id=>{opened=id??'';}} selected={null}/>);
 const click=async(text:string)=>act(async()=>{const button=[...win.document.querySelectorAll('button')].find(b=>b.textContent?.includes(text));assert.ok(button,text);button.click();});
 try{
  await act(async()=>render());assert.match(win.document.body.textContent!,/준비된 초안|Q-FIRST/);assert.doesNotMatch(win.document.body.textContent!,/Q-SECOND|준비할 도장/);
  await click('견적서 초안 확인');assert.equal(opened,'draft-one');
  await act(async()=>{const select=win.document.querySelector('select')!;select.value='two';select.dispatchEvent(new win.Event('change',{bubbles:true}));});
  assert.doesNotMatch(win.document.body.textContent!,/Q-FIRST|준비할 창틀/);await click('Q-SECOND');assert.equal(opened,'issued-two');
  failed=true;await click('목록 새로 확인');assert.match(win.document.body.textContent!,/마지막 확인 목록/);assert.match(win.document.body.textContent!,/Q-SECOND/);
 }finally{await act(async()=>root.unmount());win.close();}
});

test('N26 optional connections reopen and return through existing history without a first-screen guide',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/today',pretendToBeVisual:true}),win=dom.window;win.scrollTo=()=>{};
 Object.assign(globalThis,{window:win,document:win.document,location:win.location,HTMLElement:win.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client'),root=createRoot(win.document.getElementById('root')!);
 const base=previewWorkClient({delayMs:0,guideDone:true}),requests:Parameters<WorkClient['request']>[0][]=[];
 const client:WorkClient={...base,async request<T>(r:Parameters<WorkClient['request']>[0]){requests.push(r);return base.request<T>(r);}};
 const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,30));});
 const click=async(text:string)=>{await act(async()=>{const b=[...win.document.querySelectorAll<HTMLElement>('button,a')].find(e=>e.textContent?.trim()===text||e.textContent?.startsWith(text));assert.ok(b,text);b.click();});await settle();};
 const back=async()=>{await act(async()=>win.history.back());await settle();};
 try{
  await act(async()=>root.render(<WorkApp client={client}/>));await settle();assert.equal(win.history.length,1);assert.equal(win.document.querySelector('dialog'),null);assert.equal(win.document.getElementById('screen-title')?.textContent,'오늘');
  await click('설정');assert.equal(win.location.hash,'#/more');await click('자료 연결');assert.equal(win.location.hash,'#/setup');assert.equal(win.document.getElementById('screen-title')?.textContent,'자료 연결');
  assert.ok([...win.document.querySelectorAll('button')].find(b=>b.textContent==='파일 추가'));assert.equal(win.document.querySelector('dialog'),null);
  await back();assert.equal(win.location.hash,'#/more');assert.equal(win.document.activeElement?.id,'screen-title');
  await click('자료 연결');assert.equal(win.location.hash,'#/setup');await click('뒤로');assert.equal(win.location.hash,'#/more');
  await back();assert.equal(win.location.hash,'#/today','the next Back follows the existing work history');assert.equal(win.document.activeElement?.id,'screen-title');
  assert.equal(requests.some(r=>['guide.read','guide.save','setup.command','setup.capture'].includes(r.route)),false,'navigation alone never completes setup or saves guide progress');
 }finally{await act(async()=>root.unmount());win.close();}
});
