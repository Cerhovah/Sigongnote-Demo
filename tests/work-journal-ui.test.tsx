import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act} from 'react';
import {WorkJournal} from '../apps/web/src/work-journal.js';
import type {WorkClient,WorkRequest} from '../apps/web/src/work-client.js';

test('journal keeps received unread evidence visible and preserves it on refresh failure',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{pretendToBeVisual:true,url:'https://fixture.test'}),win=dom.window;
 Object.assign(globalThis,{window:win,document:win.document,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(win.document.getElementById('root')!);let fail=false,opened='';
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(){if(fail)throw Error('offline');return {items:[{id:'one',received_at:'2026-10-05T10:00:00Z',occurred_at:null,source_kind:'call_recording',declared_mime:'audio/mp4',project_id:null,project_name:null,categories:[],excerpt:'',reading_state:'waiting',parse_status:'pending',observations:[]}],next_cursor:null} as T;}};
 try{
  await act(async()=>{root.render(<WorkJournal client={client} context={{user_id:'u',tenant_id:'t',company:'합성'}} onOpen={id=>{opened=id;}} onAdd={()=>{}}/>);});
  assert.match(win.document.body.textContent!,/통화 녹음/);assert.doesNotMatch(win.document.body.textContent!,/자료는 도착했어요|자료는 보관됐지만/);assert.equal(win.document.querySelector<HTMLDetailsElement>('.journal-entry')!.open,false);
  fail=true;await act(async()=>win.dispatchEvent(new win.Event('focus')));
  assert.match(win.document.body.textContent!,/다시 연결/);assert.match(win.document.body.textContent!,/통화 녹음/);
  await act(async()=>{win.document.querySelector<HTMLElement>('.journal-entry>summary')!.click();});assert.equal(win.document.querySelector<HTMLDetailsElement>('.journal-entry')!.open,true);
  await act(async()=>{(Array.from(win.document.querySelectorAll('button')).find(b=>b.textContent==='자료 열기') as HTMLButtonElement).click();});assert.equal(opened,'one');
 }finally{await act(async()=>root.unmount());win.close();}
});

test('empty filtered journal offers clearing filters without asking to reconnect collection',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://fixture.test'}),win=dom.window;
 Object.assign(globalThis,{window:win,document:win.document,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(win.document.getElementById('root')!);const queries:unknown[]=[];
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:WorkRequest){queries.push(r);return {items:[],next_cursor:null} as T;}};
 try{
  await act(async()=>root.render(<WorkJournal client={client} context={{user_id:'u',tenant_id:'t',company:'합성',projects:[{id:'p',display_name:'합성 현장'}]}} initialProject="p" onOpen={()=>{}} onAdd={()=>{}}/>));
  assert.match(win.document.body.textContent!,/기록 없음/);assert.doesNotMatch(win.document.body.textContent!,/문자·통화·사진 연결 확인/);
  await act(async()=>{[...win.document.querySelectorAll('button')].find(b=>b.textContent==='모든 기록 보기')!.click();});
  assert.deepEqual(queries.at(-1),{route:'journal.list'});assert.match(win.document.body.textContent!,/기록 없음/);assert.doesNotMatch(win.document.body.textContent!,/문자·통화·사진 연결 확인/);
 }finally{await act(async()=>root.unmount());win.close();}
});

test('an emptied older journal page offers recent records without reconnecting collection',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://fixture.test'}),win=dom.window;
 Object.assign(globalThis,{window:win,document:win.document,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(win.document.getElementById('root')!);
 const queries:WorkRequest[]=[];
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:WorkRequest){queries.push(r);return {items:[],next_cursor:r.route==='journal.list'&&!r.cursor?'older':null} as T;}};
 try{
  await act(async()=>root.render(<WorkJournal client={client} context={{user_id:'u',tenant_id:'t',company:'합성'}} onOpen={()=>{}} onAdd={()=>{}}/>));
  await act(async()=>{[...win.document.querySelectorAll('button')].find(b=>b.textContent==='이전 기록 보기')!.click();});
  assert.match(win.document.body.textContent!,/기록 없음/);assert.doesNotMatch(win.document.body.textContent!,/문자·통화·사진 연결 확인/);
  const back=[...win.document.querySelectorAll('button')].filter(b=>b.textContent==='최근 기록으로');assert.equal(back.length,1);
  await act(async()=>back[0]!.click());assert.deepEqual(queries.at(-1),{route:'journal.list'});
 }finally{await act(async()=>root.unmount());win.close();}
});
