import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act} from 'react';
import {WorkArchive} from '../apps/web/src/work-archive.js';
import {ArchiveProcessing} from '../apps/web/src/archive-processing.js';
import type {WorkClient,WorkRequest} from '../apps/web/src/work-client.js';
test('adding references selects the current site locally and never rewrites onboarding',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{pretendToBeVisual:true,url:'https://fixture.test'}),win=dom.window;win.scrollTo=()=>{};
 Object.assign(globalThis,{window:win,document:win.document,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(win.document.getElementById('root')!);const calls:string[]=[];
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:WorkRequest){calls.push(r.route);assert.equal(r.route,'setup.read');return {project_id:'a',policy:{id:'anthropic-work-records-v1',purpose:'work_records',provider:'anthropic',processing_location:'US primary',storage_location:'KR company',retention:'until_user_deletes',external_processing:true,processors:[{purpose:'long_stt',provider:'openai',processing_location:'US transcription',storage_location:'provider transient',retention:'delete after transcription'}]}} as T;}};
 try{
  await act(async()=>{root.render(<WorkArchive client={client} context={{company:'합성',user_id:'u',tenant_id:'t',projects:[{id:'a',display_name:'합성 A'},{id:'b',display_name:'합성 B'}]}} initialProject="b" initialFiles={[new win.File(['synthetic'],'photo.jpg',{type:'image/jpeg'})]} onExit={()=>{}} onOpen={()=>{}}/>);});
  const select=win.document.querySelector('select')!;assert.equal(select.value,'b');assert.equal(win.document.querySelector('h1')?.textContent,'어느 현장 사진인가요?');
  const notice=win.document.querySelector('.upload-policy')?.textContent??'';for(const expected of ['현장·업무 정리: Anthropic Claude','US primary','KR company','직접 삭제할 때까지','긴 녹음 전사: OpenAI','US transcription','provider transient','delete after transcription'])assert.ok(notice.includes(expected),expected);
  await act(async()=>{select.value='a';select.dispatchEvent(new win.Event('change',{bubbles:true}));});assert.deepEqual(calls,['setup.read']);
  assert.equal(select.value,'a');assert.equal(calls.filter(route=>route==='setup.capture').length,0,'selecting a site does not create a source or grant processing consent');
 }finally{await act(async()=>root.unmount());win.close();}
});

test('archive analysis needs an explicit start after the cost notice and stop stays direct',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://fixture.test'}),win=dom.window;
 Object.assign(globalThis,{window:win,document:win.document,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(win.document.getElementById('root')!);let enabled=false,version=0;const changes:boolean[]=[];
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:WorkRequest){if(r.route==='archive.command'){const c=JSON.parse(r.command!);enabled=c.enabled;version++;changes.push(enabled);}return {enabled,version,waiting:4,running:0,finished:2} as T;}};
 const click=async(text:string)=>act(async()=>{[...win.document.querySelectorAll('button')].find(x=>x.textContent===text)!.click();});
 try{
  await act(async()=>root.render(<ArchiveProcessing client={client}/>));await click('보관한 과거 자료 분석 시작');assert.deepEqual(changes,[]);assert.match(win.document.body.textContent!,/API 비용/);
  await click('나중에');assert.deepEqual(changes,[]);await click('보관한 과거 자료 분석 시작');await click('확인하고 분석 시작');assert.deepEqual(changes,[true]);await click('과거 분석 멈추기');assert.deepEqual(changes,[true,false]);
 }finally{await act(async()=>root.unmount());win.close();}
});
