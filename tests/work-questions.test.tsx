import {workSignals} from '../packages/domain/src/work-decisions.js';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act} from 'react';
import {WorkQuestions} from '../apps/web/src/work-questions.js';
import type {WorkClient,WorkRequest} from '../apps/web/src/work-client.js';
test('D12 one answer retries unchanged and shows effects without claiming payment',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://localhost',pretendToBeVisual:true}),win=dom.window;Object.assign(globalThis,{window:win,document:win.document,HTMLElement:win.HTMLElement,Event:win.Event,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client'),root=createRoot(win.document.getElementById('root')!);const commands:string[]=[];let done=false;
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:WorkRequest){if(r.route==='questions.list')return {questions:done?[]:[{id:crypto.randomUUID(),version:1,project_name:'합성현장',work_label:'보수',prompt:'받은 수량을 반영할까요?',category:'material',cause:'other',source_refs:[{revision:crypto.randomUUID(),span:1,organization_version:1}],proposal:{effects:[{kind:'acceptance',quantity:'8',ordered:'10',unit:'개'}],blocked:null}}],coverage:'합성',can_answer:true} as T;if(r.route==='work.command'){commands.push(r.command);if(commands.length===1)throw new Error('lost response');done=true;return {changed:['인수 8개 · 발주 10개'],payment_confirmed:false} as T;}throw new Error('unexpected');}};
 const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,15));});
 try{await act(async()=>root.render(<WorkQuestions client={client} onOpen={()=>{}}/>));await settle();const click=async()=>{await act(async()=>{Array.from(win.document.querySelectorAll('button')).find(b=>b.textContent==='이대로 반영')!.click();});await settle();};await click();assert.match(win.document.body.textContent??'',/결과를 아직/);await click();assert.equal(commands[0],commands[1]);assert.match(win.document.body.textContent??'',/인수 8개/);assert.match(win.document.body.textContent??'',/송금·업무 전체 완료는 별도/);}finally{await act(async()=>root.unmount());win.close();}
});

test('D12 shared defect/change money is one explicit choice, not two costs',()=>{const r=workSignals(['하자: 보완','조치: 재방문','부담: 회사','변경합의: 운반','추가비: 50000원'].map(text=>({text})),'2026-09-30');assert.equal(r.length,1);assert.equal(r[0]!.ambiguousCost,true);assert.equal(r[0]!.cost,'50000');});
