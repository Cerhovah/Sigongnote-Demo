import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act} from 'react';
import {WorkLearning} from '../apps/web/src/work-learning.js';
import type {WorkClient,WorkRequest} from '../apps/web/src/work-client.js';
import {createActivityClient} from '../apps/web/src/work-activity.js';
import {WorkApp} from '../apps/web/src/work-app.js';
import {previewWorkClient} from '../apps/web/src/work-preview-client.js';
test('N27 protected dashboard requires explicit classification and hides content when authorization refresh fails',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost',pretendToBeVisual:true}),win=dom.window;Object.assign(globalThis,{window:win,document:win.document,HTMLElement:win.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client'),root=createRoot(win.document.getElementById('root')!);
 let failed=false,writes=0;const c={id:crypto.randomUUID(),version:1,state:'unreviewed',prompt:'합성 비공개 판단',created_at:new Date().toISOString()};
 let contextReads=0;
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:WorkRequest){if(failed)throw Error('withdrawn');if(r.route==='learning.command'){writes++;return {} as T;}if(r.route==='context-learning.list'){contextReads++;return {consent:{allowed:true},cases:[],procedures:[]} as T;}if(r.route==='learning.list')return {consent:{allowed:true},summary:{available:1,unreviewed:1,corrections:0,new_facts:0},cases:[c],next_cursor:null} as T;assert.equal(r.route,'learning.read');return {...c,snapshot:{prompt:c.prompt,context_id:'INTERNAL-CONTEXT',period:'2026-10'},answer:[{kind:'quality',action:'합성 정답'}],proposal:{},result:{},current:{},trace:[{id:'INTERNAL-TRACE',model:'synthetic-model',cost_minor:'987654',cost_known:false}],history:[],evidence:[],ground_truth:false} as T;}};
 const click=async(text:string)=>act(async()=>{const b=[...win.document.querySelectorAll('button')].find(e=>e.textContent?.includes(text));assert.ok(b,text);b.click();});
 try{await act(async()=>root.render(<WorkLearning client={client}/>));assert.equal(contextReads,1);assert.match(win.document.body.textContent!,/아직 확인할 현장 교정이 없어요/);await click('개선 동의 철회');assert.equal(writes,0);assert.match(win.document.body.textContent!,/복구되지 않아요/);await click('철회 취소');await click(c.prompt);assert.equal(writes,0);assert.match(win.document.body.textContent!,/평가 정답으로 사용하지 않음/);assert.equal(win.document.querySelector('select')!.value,'');assert.ok([...win.document.querySelectorAll('button')].find(b=>b.textContent==='분류 저장')!.disabled);assert.ok(win.document.querySelector('[data-activity-ignore="true"]'));assert.match(win.document.body.textContent!,/보완 조치: 합성 정답|알 수 없음 \(예약액/);assert.doesNotMatch(win.document.body.textContent!,/INTERNAL-|987654|987,654|context_id/);
  await click('이 개선 사례 삭제');await click('취소');assert.equal(writes,0);
  failed=true;await click('기록 다시 확인');assert.doesNotMatch(win.document.body.textContent!,/합성 비공개 판단|합성 정답/);assert.match(win.document.body.textContent!,/기록을 가렸어요/);
 }finally{await act(async()=>root.unmount());win.close();}
});
test('N27 addressed case Back returns to the list; full withdrawal requires confirmation and input failures do not recommend retry',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/more',pretendToBeVisual:true}),win=dom.window;win.scrollTo=()=>{};Object.assign(globalThis,{window:win,document:win.document,location:win.location,HTMLElement:win.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
 win.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};win.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
 const {createRoot}=await import('react-dom/client'),root=createRoot(win.document.getElementById('root')!);const base=previewWorkClient({delayMs:0,guideDone:true}),id=crypto.randomUUID();let writes=0;
 const c={id,version:1,state:'unreviewed',prompt:'합성 뒤로가기 사례',created_at:new Date().toISOString()};
 const client:WorkClient={...base,async request<T>(r:WorkRequest){if(r.route==='learning.command'){writes++;throw Object.assign(Error('invalid'),{code:'INVALID_CONTRACT'});}if(r.route==='learning.list')return {consent:{allowed:true},summary:{available:1,unreviewed:1,corrections:0,new_facts:0},cases:[c],next_cursor:null} as T;if(r.route==='learning.read')return {...c,snapshot:{prompt:c.prompt},answer:[],proposal:{},result:{},current:{},trace:[],history:[],evidence:[],ground_truth:false} as T;return base.request<T>(r);}};
 const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,25));});const click=async(text:string)=>{await act(async()=>{const b=[...win.document.querySelectorAll('button')].find(b=>b.textContent?.startsWith(text));assert.ok(b,text);b.click();});await settle();};
 try{await act(async()=>root.render(<WorkApp client={client}/>));await settle();if(win.document.querySelector('dialog')){await act(async()=>win.history.back());await settle();}await click('판단 개선 기록');await click(c.prompt);assert.equal(win.location.hash,'#/more/learning/'+id);assert.equal(win.document.getElementById('screen-title')?.textContent,'판단 사례');await act(async()=>win.history.back());await settle();assert.equal(win.location.hash,'#/more/learning');assert.equal(win.document.querySelector('[aria-label="판단 사례 상세"]'),null);
  await click('개선 동의 철회');assert.equal(writes,0);await click('동의 철회·삭제 확인');assert.equal(writes,1);assert.match(win.document.body.textContent!,/입력 내용을 저장할 수 없어요/);assert.doesNotMatch(win.document.body.textContent!,/같은 내용을 다시 보내면/);
 }finally{await act(async()=>root.unmount());win.close();}
});
test('N27 learning reasons and snapshots never enter the general activity request/result stream',async()=>{
 const calls:unknown[]=[];const base:WorkClient={kind:'fixture',dispose(){},async request<T>(r:WorkRequest){calls.push(r);if(r.route==='context')return {tenant_id:'t',user_id:'u',company:'synthetic'} as T;if(r.route==='activity.status')return {allowed:true,consent_id:crypto.randomUUID(),can_view_activity:true} as T;return {private:'protected learning snapshot'} as T;}};
 const {client,controller}=createActivityClient(base);try{await client.request({route:'context'});await controller.refresh();const before=controller.state.pending;await client.request({route:'learning.command',command:JSON.stringify({reason:'protected learning reason'})});await client.request({route:'learning.read',id:crypto.randomUUID()});assert.equal(controller.state.pending,before);assert.equal(calls.length>=3,true);}finally{controller.dispose();}
});
