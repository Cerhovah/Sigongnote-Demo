import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act} from 'react';
import {WorkImprovements} from '../apps/web/src/work-improvements.js';
import {createActivityClient} from '../apps/web/src/work-activity.js';
import type {WorkClient,WorkRequest} from '../apps/web/src/work-client.js';
test('N28 protected improvement UI distinguishes no samples and requires explicit promotion/delegation confirmation',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost',pretendToBeVisual:true}),win=dom.window;Object.assign(globalThis,{window:win,document:win.document,HTMLElement:win.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client'),root=createRoot(win.document.getElementById('root')!);let failed=false;const writes:any[]=[];
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:WorkRequest){if(failed)throw Error('withdrawn');if(r.route==='improvements.command'){writes.push(JSON.parse(r.command));return {} as T;}return(r.route==='learning.list'?{cases:[{id:'one',state:'unreviewed',prompt:'미분류는 선택하지 않음'}],next_cursor:null}:{criteria:{min_test_groups:1,min_shadow_groups:1,min_improvement:1},head:{version:3,active_id:null,previous_id:null,delegation:{allowed:false,max_calls:100,max_cost_minor:0}},usage:{calls:1,cost:0,known_cost:0,unknown:1},versions:[{id:'two',state:'proposed',spec:{rules:[{from:'합성 임시 방문',to:'합성 문틀 재설치'}]},metrics:{shadow:{samples:0}}}]}) as T;}};
 const click=async(text:string)=>act(async()=>{const b=[...win.document.querySelectorAll('button')].find(e=>e.textContent===text);assert.ok(b,text);b.click();});
 try{await act(async()=>root.render(<WorkImprovements client={client}/>));assert.ok(win.document.querySelector('[data-activity-ignore="true"]'));assert.match(win.document.body.textContent!,/확인 표본 없음 · 통과 아님/);assert.equal(win.document.querySelector('input[type=checkbox]'),null);assert.match(win.document.body.textContent!,/비용 미확정 포함 · 확정분 0원/);
  await click('이 개선안 사용 검토');assert.equal(writes.length,0);await click('취소');await click('기본 기준 안에서 자동 승격 위임');assert.equal(writes.length,0);await click('확인하고 적용');assert.equal(writes.length,1);assert.equal(writes[0].head_version,3);assert.equal(writes[0].delegation.max_cost_minor,0);assert.equal(writes[0].delegation.max_calls,100);
  failed=true;await click('개선 기록 다시 확인');assert.doesNotMatch(win.document.body.textContent!,/합성 임시 방문|합성 문틀 재설치/);assert.match(win.document.body.textContent!,/개선 기록을 가렸어요/);
 }finally{await act(async()=>root.unmount());win.close();}
});
test('N28 improvement candidates and dataset selections never enter general activity logs',async()=>{
 const base:WorkClient={kind:'fixture',dispose(){},async request<T>(r:WorkRequest){if(r.route==='context')return {tenant_id:'t',user_id:'u',company:'synthetic'} as T;if(r.route==='activity.status')return {allowed:true,consent_id:crypto.randomUUID(),can_view_activity:true} as T;return {private:'protected rule'} as T;}};
 const {client,controller}=createActivityClient(base);try{await client.request({route:'context'});await controller.refresh();const before=controller.state.pending;await client.request({route:'improvements.list'});await client.request({route:'improvements.command',command:JSON.stringify({case_ids:['private-example']})});assert.equal(controller.state.pending,before);}finally{controller.dispose();}
});
