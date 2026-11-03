import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {act} from "react";
import {WorkApp} from "../apps/web/src/work-app.js";
import {previewWorkClient} from "../apps/web/src/work-preview-client.js";
import type {WorkRequest} from "../apps/web/src/work-client.js";
import {WorkRequestSchema,workHttp} from "@sigongnote/contracts";
import {randomUUID} from "node:crypto";

test("UI-only preview keeps the selected site in found materials and prepared documents",async()=>{
 const client=previewWorkClient({delayMs:0,guideDone:true});
 const context=await client.request<{projects:{id:string;display_name:string}[]}>({route:"context"}),site=context.projects[1]!;
 const request={route:"conversation.turn" as const,id:randomUUID(),client_turn_id:randomUUID(),text:"하자 자료 찾아줘",selected_project_id:site.id};
 const found=await client.request<{cards:{project_name:string}[]}>(request);assert.ok(found.cards.length);assert.ok(found.cards.every(c=>c.project_name===site.display_name));
 const turn=await client.request<{document_draft:{id:string}}>({...request,client_turn_id:randomUUID(),text:"견적서 준비해줘"});
 const draft=await client.request<{document:{project:{id:string}}}>({route:"documents.read",id:turn.document_draft.id});assert.equal(draft.document.project.id,site.id);
});

test("site selection survives back/reload, bounds lists and is visible in today's requests",async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:"http://localhost/#/materials",pretendToBeVisual:true}),win=dom.window;win.scrollTo=()=>{};
 Object.assign(globalThis,{window:win,document:win.document,location:win.location,HTMLElement:win.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import("react-dom/client");let root=createRoot(win.document.getElementById("root")!);
 const base=previewWorkClient({delayMs:0,guideDone:true}),calls:WorkRequest[]=[];
 const client={...base,async request<T>(r:WorkRequest){calls.push(r);return base.request<T>(r);}};
 const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,35));});
 const click=async(text:string)=>{const button=[...win.document.querySelectorAll<HTMLElement>('button,a')].find(e=>e.textContent?.includes(text));assert.ok(button,text);await act(async()=>button.click());await settle();};
 const clickControl=async(selector:string)=>{const control=win.document.querySelector<HTMLElement>(selector);assert.ok(control,selector);await act(async()=>control.click());await settle();};
 const render=async()=>{await act(async()=>root.render(<WorkApp client={client}/>));await settle();};
 try{
  await render();assert.match(win.document.body.textContent!,/합성 햇살현장/);assert.doesNotMatch(win.document.body.textContent!,/종류별로 보기/);
  await click("합성 햇살현장");await click("납품·작업");
  const ledger=calls.findLast(r=>r.route==='ledger.list');assert.ok(ledger?.route==='ledger.list');assert.ok(ledger.project_id);assert.equal(ledger.category,'delivery_work');
  const journal=calls.findLast(r=>r.route==='journal.list');assert.ok(journal?.route==='journal.list');assert.equal(journal.project_id,ledger.project_id);assert.equal(journal.category,'delivery_work');
  assert.match(win.document.body.textContent!,/주방 석고보드 납품/);assert.doesNotMatch(win.document.body.textContent!,/푸른마을 하자/);
  assert.equal(new URL('http://api.test'+workHttp(ledger).path).searchParams.get('project_id'),ledger.project_id);assert.equal(new URL('http://api.test'+workHttp(ledger).path).searchParams.get('category'),'delivery_work');
  await clickControl('button[aria-label="근거 자료 검색"]');
  const scoped=calls.findLast(r=>r.route==="materials.list");assert.equal(scoped?.route,"materials.list");if(scoped?.route!=="materials.list")throw Error("missing list");assert.equal(scoped.project_id,ledger.project_id);
  assert.match(win.document.body.textContent!,/석고보드 납품 확인/);assert.doesNotMatch(win.document.body.textContent!,/푸른마을 하자/);
  assert.equal(new URL('http://api.test'+workHttp(scoped).path).searchParams.get('project_id'),scoped.project_id);
  assert.equal(WorkRequestSchema.safeParse({...scoped,project_id:'invalid'}).success,false);
  await act(async()=>root.unmount());root=createRoot(win.document.getElementById("root")!);await render();
  assert.equal((calls.findLast(r=>r.route==="materials.list") as typeof scoped).project_id,scoped.project_id);
  await click("오늘");const selector=()=>win.document.querySelector<HTMLSelectElement>('select[aria-label="대화에서 찾을 현장"]')!;
  assert.equal(selector().value,scoped.project_id);
  await act(async()=>root.unmount());root=createRoot(win.document.getElementById("root")!);await render();assert.equal(selector().value,scoped.project_id);
  await clickControl('#nav-materials');await click("합성 푸른마을");await click("점검·하자");
  const otherLedger=calls.findLast(r=>r.route==='ledger.list');assert.ok(otherLedger?.route==='ledger.list');assert.notEqual(otherLedger.project_id,scoped.project_id);assert.equal(otherLedger.category,'inspection_defect');
  const otherJournal=calls.findLast(r=>r.route==='journal.list');assert.ok(otherJournal?.route==='journal.list');assert.equal(otherJournal.project_id,otherLedger.project_id);assert.equal(otherJournal.category,'inspection_defect');
  await clickControl('button[aria-label="근거 자료 검색"]');assert.doesNotMatch(win.document.body.textContent!,/석고보드 납품 확인/);assert.match(win.document.body.textContent!,/푸른마을 하자/);
  const otherMaterials=calls.findLast(r=>r.route==='materials.list');assert.ok(otherMaterials?.route==='materials.list');assert.equal(otherMaterials.project_id,otherLedger.project_id);
  await click("오늘");assert.notEqual(selector().value,scoped.project_id);const selected=selector().value;
  await act(async()=>{const input=win.document.querySelector<HTMLInputElement>('#today-ask-input')!;Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,'value')!.set!.call(input,'자료 찾아줘');input.dispatchEvent(new win.Event('input',{bubbles:true}));});await click("보내기");
  const turn=calls.findLast(r=>r.route==='conversation.turn');assert.ok(turn?.route==='conversation.turn');assert.equal(turn.selected_project_id,selected);
  await click("뒤로");assert.equal(selector().value,selected);
  await clickControl('#nav-materials');await click("모든 현장의 기록 보기");await clickControl('button[aria-label="근거 자료 검색"]');assert.match(win.document.body.textContent!,/자재상 거래명세서 5장/);
  const all=calls.findLast(r=>r.route==='materials.list');assert.ok(all?.route==='materials.list');assert.equal(all.project_id,undefined);assert.equal(new URL('http://api.test'+workHttp(all).path).searchParams.has('project_id'),false);
 }finally{await act(async()=>root.unmount());win.close();}
});

test("changing sites preserves a delayed request failure, its retry key and prepared document",async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:"http://localhost/#/materials",pretendToBeVisual:true}),win=dom.window;win.scrollTo=()=>{};
 Object.assign(globalThis,{window:win,document:win.document,location:win.location,HTMLElement:win.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import("react-dom/client"),root=createRoot(win.document.getElementById("root")!);
 const base=previewWorkClient({delayMs:0,guideDone:true}),turns:Extract<WorkRequest,{route:"conversation.turn"}>[]=[],draftReads:{id:string;projectId:string}[]=[];let preparedId='';
 let rejectFirst:(error:Error)=>void=()=>{};
 const client={...base,async request<T>(r:WorkRequest){if(r.route==="conversation.turn"){turns.push(r);if(turns.length===1)return new Promise<T>((_resolve,reject)=>{rejectFirst=reject;});}const result=await base.request<T>(r);if(r.route==='conversation.turn')preparedId=(result as {document_draft:{id:string}}).document_draft.id;if(r.route==='documents.read')draftReads.push({id:r.id,projectId:(result as {document:{project:{id:string}}}).document.project.id});return result;}};
 const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,35));});
 const click=async(text:string)=>{const b=[...win.document.querySelectorAll<HTMLElement>('button,a')].find(e=>e.textContent?.includes(text));assert.ok(b,text);await act(async()=>b.click());await settle();};
 const go=async(hash:string)=>{await act(async()=>{win.location.hash=hash;});await settle();};
 try{
  await act(async()=>root.render(<WorkApp client={client}/>));await settle();await click('합성 햇살현장');await click('오늘');
  await act(async()=>{const input=win.document.querySelector<HTMLInputElement>('#today-ask-input')!;Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,'value')!.set!.call(input,'견적서 준비해줘');input.dispatchEvent(new win.Event('input',{bubbles:true}));});await click('보내기');assert.equal(turns.length,1);
  await go('#/materials');await click('합성 푸른마을');await click('오늘');
  await act(async()=>rejectFirst(new Error('response lost')));await settle();assert.match(win.document.body.textContent!,/합성 햇살현장 요청의 답을 아직/);
  await click('같은 요청 이어서 확인');assert.equal(turns.length,2);assert.equal(turns[0]!.client_turn_id,turns[1]!.client_turn_id);assert.equal(turns[0]!.selected_project_id,turns[1]!.selected_project_id);
  assert.match(win.document.body.textContent!,/요청한 현장: 합성 햇살현장/);
  await go('#/today');const pending=[...win.document.querySelectorAll('button')].find(b=>b.querySelector('strong')?.textContent==='준비한 견적서 이어서 보기');assert.ok(pending);assert.equal(pending.querySelector('small')?.textContent,'합성 햇살현장');assert.ok(preparedId);
  assert.equal(win.document.querySelector<HTMLSelectElement>('select[aria-label="대화에서 찾을 현장"]')!.selectedOptions[0]!.textContent,'합성 푸른마을');
  await click('준비한 견적서 이어서 보기');assert.equal(win.location.hash,'#/draft/'+preparedId);assert.deepEqual(draftReads.at(-1),{id:preparedId,projectId:turns[0]!.selected_project_id});
  assert.match(win.document.body.textContent!,/합성 햇살현장/);assert.match(win.document.body.textContent!,/받는 곳 확인 필요/);assert.match(win.document.body.textContent!,/이 견적서는 누구에게 보내나요/);
  await go('#/today');assert.equal(win.document.querySelector<HTMLSelectElement>('select[aria-label="대화에서 찾을 현장"]')!.selectedOptions[0]!.textContent,'합성 푸른마을');
  await go('#/materials/list?project=00000000-0000-4000-8000-000000000001');assert.match(win.document.body.textContent!,/현재 회사에서 이 현장을 찾을 수 없어요/);assert.doesNotMatch(win.document.body.textContent!,/전체 현장 · 현장 확인 전 포함/);
 }finally{await act(async()=>root.unmount());win.close();}
});
