import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act} from 'react';
import {WorkLedgerDetail} from '../apps/web/src/work-ledger.js';
import type {WorkClient} from '../apps/web/src/work-client.js';
test('site ledger shows source subject, exact amounts, unknowns and suppresses withdrawn content',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{pretendToBeVisual:true,url:'http://localhost'}),win=dom.window;
 Object.assign(globalThis,{window:win,document:win.document,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client'),root=createRoot(win.document.getElementById('root')!);
 const base={kind:'request',mode:'observed',asserted:false,occurred_at:null,recorded_at:'2026-10-05T01:00:00Z',withdrawn:false,evidence_ids:[],supersedes:null,reverses:null};
 const events=[{...base,id:'one',subject:'합성 문틀 900 x 2100',quantity:{value:'28.5',unitCode:'ea'},amount:{knowledge:'known',minor:'9007199254740993',currency:'KRW'}},{...base,id:'two',subject:'합성 인수 미확인',quantity:null,amount:{knowledge:'unknown',minor:null,currency:'KRW'}},{...base,id:'three',withdrawn:true,subject:'철회한 비공개 품목',quantity:{value:'12345',unitCode:'ea'},amount:{knowledge:'known',minor:'99999',currency:'KRW'}}];
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(){return {id:'site',label:'합성 현장',project_name:'합성 현장',events,evidence:[],documents:[],drafts:[],partial:false,next_cursor:null} as T;}};
 try{await act(async()=>root.render(<WorkLedgerDetail client={client} id="site" onEvidence={()=>{}} onDocument={()=>{}} onDraft={()=>{}}/>));await act(async()=>{await new Promise(r=>setTimeout(r,20));});
 const text=win.document.body.textContent!;assert.match(text,/문틀 900 x 2100/);assert.match(text,/28.5 개/);assert.match(text,/9,007,199,254,740,993원/);assert.match(text,/수량 미확인 · 금액 미확인/);assert.match(text,/확인 전 내용/);assert.doesNotMatch(text,/철회한 비공개|12345|99,999/);
 }finally{await act(async()=>root.unmount());win.close();}
});
