import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act} from 'react';
import {WorkTasks} from '../apps/web/src/work-tasks.js';
import {JournalDraft} from '../apps/web/src/journal-draft.js';
import type {WorkRequest} from '@sigongnote/contracts';
import type {WorkClient} from '../apps/web/src/work-client.js';
import {WorkFailure} from '../apps/web/src/work-client.js';
test('journal task retry uses the same command and draft preparation opens the saved draft',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{pretendToBeVisual:true,url:'https://fixture.test'}),win=dom.window;
 Object.assign(globalThis,{window:win,document:win.document,Event:win.Event,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(win.document.getElementById('root')!);const commands:string[]=[];let opened='',savedDone=false,reads=0;
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:WorkRequest){if(r.route==='journal.tasks'){reads++;return {items:[{id:'task',revision_id:'source',text:'내일 납품 확인 요청',project_name:'합성',done:savedDone,version:savedDone?1:0}],partial:false} as T;}
  if(r.route==='journal.command'){commands.push(r.command);if(JSON.parse(r.command).action==='draft')return {id:'draft'} as T;if(commands.length===1)throw Error('unknown response');savedDone=true;return {done:true,version:1} as T;}throw Error('unexpected');}};
 const click=async(text:string)=>act(async()=>{const b=[...win.document.querySelectorAll('button')].find(b=>b.textContent===text);assert.ok(b);b.click();});
 try{
  await act(async()=>root.render(<WorkTasks client={client} onOpen={()=>{}}/>));await click('내 처리 완료');assert.match(win.document.body.textContent!,/반영 여부/);await click('내 처리 완료');assert.equal(commands[0],commands[1]);assert.equal(reads,2,'saved task state is reopened when the event list refreshes');assert.match(win.document.body.textContent!,/모두 처리했어요/);assert.doesNotMatch(win.document.body.textContent!,/현재 모인 요청·예정이 없어요/);
  await act(async()=>{(win.document.querySelector('input') as HTMLInputElement).click();});assert.match(win.document.body.textContent!,/다시 챙기기/);
  await act(async()=>root.render(<JournalDraft client={client} context={{user_id:'u',tenant_id:'t',company:'합성',can_maintain:true,projects:[{id:'p',display_name:'합성'}]}} item={{id:'r',organization_version:1,received_at:'2026-10-05T00:00:00Z',occurred_at:null,source_kind:'sms',declared_mime:'text/plain',project_id:'p',project_name:'합성',categories:[],excerpt:'요청',reading_state:'readable',parse_status:'complete',observations:[]}} onOpen={id=>{opened=id;}}/>));
  await click('이 기록으로 문서 준비');await click('초안 준비하고 내용 확인');assert.equal(opened,'draft');assert.equal(JSON.parse(commands[2]!).id,'r');
 }finally{await act(async()=>root.unmount());win.close();}
});
test('a conflict immediately reloads task state instead of resending a stale version',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{pretendToBeVisual:true,url:'https://fixture.test'}),win=dom.window;
 Object.assign(globalThis,{window:win,document:win.document,Event:win.Event,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(win.document.getElementById('root')!);let reads=0;
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:WorkRequest){if(r.route==='journal.tasks'){reads++;return {items:[{id:'t',revision_id:'r',text:'합성 요청',done:reads>1,version:reads>1?1:0}],partial:false} as T;}throw new WorkFailure('VERSION_CONFLICT');}};
 try{await act(async()=>root.render(<WorkTasks client={client} onOpen={()=>{}}/>));await act(async()=>{([...win.document.querySelectorAll('button')].find(b=>b.textContent==='내 처리 완료')!).click();});assert.equal(reads,2);assert.match(win.document.body.textContent!,/최신 상태를 불러왔어요/);assert.equal([...win.document.querySelectorAll('button')].some(b=>b.textContent==='내 처리 완료'),false);
 }finally{await act(async()=>root.unmount());win.close();}
});
