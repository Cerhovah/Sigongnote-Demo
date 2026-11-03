import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act,StrictMode} from 'react';
import {WorkStrategies,type StrategyReport} from '../apps/web/src/work-strategies.js';
import type {WorkClient,WorkRequest} from '../apps/web/src/work-client.js';
test('strategy UI keeps scopes separate and requires explicit head-bound promotion after StrictMode setup',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost',pretendToBeVisual:true}),win=dom.window;Object.assign(globalThis,{window:win,document:win.document,HTMLElement:win.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client'),root=createRoot(win.document.getElementById('root')!);const writes:any[]=[];let reloads=0;
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:WorkRequest){writes.push(JSON.parse((r as any).command));return {saved:true} as T;}};
 const report:StrategyReport={heads:[{scope:'search',active_id:null,previous_id:null,version:4,delegated:false},{scope:'tool_selection',active_id:null,previous_id:null,version:7,delegated:false}],usage:{calls:2,limit:100},contexts:[],runs:[],cases:[],versions:[{id:'search-one',scope:'search',state:'proposed',spec:{rules:[{from:'별칭',to:'문틀'}]},metrics:{test:{samples:1,groups:1,errors:0,improvement:1,passed:true}},invalid_reason:null}]};
 const click=async(text:string)=>act(async()=>{const b=[...win.document.querySelectorAll('button')].find(e=>e.textContent===text);assert.ok(b,text);b.click();});
 try{await act(async()=>root.render(<StrictMode><WorkStrategies client={client} report={report} reload={async()=>{reloads++;}}/></StrictMode>));assert.ok(win.document.querySelector('[data-activity-ignore="true"]'));assert.match(win.document.body.textContent!,/이후 별도 업무: 아직 비교하지 못했어요/);await click('이 개선안 사용 검토');assert.equal(writes.length,0);await click('확인하고 적용');assert.equal(writes[0].head_version,4);assert.equal(writes[0].scope,'search');assert.equal(reloads,1);
  await click('조회 도구 선택');assert.doesNotMatch(win.document.body.textContent!,/별칭 → 문틀/);await click('이 범위의 자동 승격 위임');assert.equal(writes.length,1);await click('취소');assert.equal(writes.length,1);await click('이 범위의 자동 승격 위임');await click('확인하고 적용');assert.equal(writes[1].head_version,7);assert.equal(writes[1].scope,'tool_selection');
 }finally{await act(async()=>root.unmount());win.close();}
});
