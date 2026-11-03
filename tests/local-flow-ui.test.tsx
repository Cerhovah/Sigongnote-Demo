import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act} from 'react';
import {entryMode} from '../apps/web/src/entry-mode.js';
import {JournalRows,type JournalItem} from '../apps/web/src/work-journal.js';
import {WorkArchive} from '../apps/web/src/work-archive.js';
import {WorkApp} from '../apps/web/src/work-app.js';
import type {WorkClient,WorkRequest} from '../apps/web/src/work-client.js';

test('installed local launch uses the shared work screen without a cloud login',()=>{
 assert.equal(entryMode('http://127.0.0.1:5174/#pair=abc',false),'local-work');
 assert.equal(entryMode('http://127.0.0.1:5174/?work=local#pair=abc',false),'local-work');
 assert.equal(entryMode('http://127.0.0.1:5174/?work=1#pair=abc',true),'local-work');
 assert.equal(entryMode('http://127.0.0.1:5186/?work=local#pair=abc',true),'local-work');
 assert.equal(entryMode('http://127.0.0.1:5174/?legacy=1',false),'local');
 assert.equal(entryMode('https://sigongnote-api.onrender.com/',false),'cloud');
});

test('photo sheet receipt opens its sheet and never offers a transaction draft',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'}),win=dom.window;
 Object.assign(globalThis,{window:win,document:win.document,location:win.location,HTMLElement:win.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(win.document.getElementById('root')!);let opened='';
 const item:JournalItem={id:'sheet-one',received_at:new Date().toISOString(),occurred_at:null,source_kind:'photo_sheet',declared_mime:'application/pdf',project_id:'site',project_name:'시험 현장',categories:['delivery_work'],excerpt:'사진대지 4장',reading_state:'readable',parse_status:'complete',observations:[]};
 try{await act(async()=>root.render(<JournalRows items={[item]} onOpen={()=>{throw new Error('sheet treated as original material');}} onOpenSheet={id=>{opened=id;}} onOpenDraft={()=>{throw new Error('sheet treated as draft source');}}/>));const button=[...win.document.querySelectorAll('button')].find(b=>b.textContent==='사진대지 열기');assert.ok(button);await act(async()=>button.click());assert.equal(opened,'sheet-one');assert.doesNotMatch(win.document.body.textContent??'',/초안/);}finally{await act(async()=>root.unmount());win.close();}
});

test('captured photo offers existing site and one save action without a consent wizard',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'}),win=dom.window;win.scrollTo=()=>{};
 Object.assign(globalThis,{window:win,document:win.document,location:win.location,HTMLElement:win.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(){return {policy:{id:'policy',provider:'처리 업체',external_processing:true,storage_location:'server',processing_location:'provider_cloud'}} as T;}};
 const {createRoot}=await import('react-dom/client');const root=createRoot(win.document.getElementById('root')!);
 try{await act(async()=>root.render(<WorkArchive client={client} context={{user_id:'u',tenant_id:'t',company:'시험',projects:[{id:'site',display_name:'기존 현장'}]}} initialFiles={[new File(['image'],'photo.jpg',{type:'image/jpeg'})]} onExit={()=>{}} onOpen={()=>{}}/>));assert.equal(win.document.querySelector('select')?.value,'site');assert.equal(win.document.querySelectorAll('input[type=checkbox]').length,0);const save=[...win.document.querySelectorAll('button')].find(b=>b.textContent==='이 현장에 저장');assert.ok(save);assert.equal(save.disabled,false);assert.match(win.document.body.textContent??'',/photo.jpg/);}finally{await act(async()=>root.unmount());win.close();}
});

test('local Today shows receipts without requesting cloud tasks, questions or sync',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://127.0.0.1:5174/#/today',pretendToBeVisual:true}),win=dom.window;win.scrollTo=()=>{};const before=globalThis.fetch;
 Object.assign(globalThis,{window:win,document:win.document,location:win.location,HTMLElement:win.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
 const calls:string[]=[];globalThis.fetch=async()=>Response.json({total:1,pending:0,source_count:2,last_scan:new Date().toISOString(),discovering:false,baseline_count:0});
 const client:WorkClient={kind:'local',dispose(){},async request<T>(r:WorkRequest){calls.push(r.route);if(r.route==='context')return {user_id:'local',tenant_id:'local',company:'시공노트',projects:[]} as T;if(r.route==='activity.status')return {allowed:false,consent_id:null,can_view_activity:false} as T;if(r.route==='conversation.read')return {turns:[]} as T;if(r.route==='journal.list')return {items:[{id:'file',received_at:new Date().toISOString(),occurred_at:null,source_kind:'folder',declared_mime:'application/pdf',project_id:null,project_name:null,categories:['billing_payment'],excerpt:'실제경로시험.pdf',reading_state:'readable',parse_status:'complete',observations:[]}],next_cursor:null} as T;throw new Error('unexpected '+r.route);}};
 const {createRoot}=await import('react-dom/client');const root=createRoot(win.document.getElementById('root')!);
 try{await act(async()=>root.render(<WorkApp client={client}/>));await act(async()=>{await new Promise(r=>setTimeout(r,20));});assert.match(win.document.body.textContent??'',/실제경로시험.pdf/);assert.doesNotMatch(win.document.body.textContent??'',/로그인|폴더 연결|무엇을 도와/);assert.ok(!calls.includes('sync.changes'));assert.ok(!calls.includes('questions.list'));assert.ok(!calls.includes('agenda.read'));}finally{await act(async()=>root.unmount());win.close();globalThis.fetch=before;}
});
