import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import {JSDOM} from "jsdom";
import {act} from "react";
import axe from "axe-core";
import {WorkApp} from "../apps/web/src/work-app.js";
import {previewWorkClient} from "../apps/web/src/work-preview-client.js";
import {readWon} from "../apps/web/src/work-shell.js";
import {WorkLedgerDetail} from '../apps/web/src/work-ledger.js';
import {WorkFailure,type WorkClient} from '../apps/web/src/work-client.js';

test('ledger preserves the last read during a connection failure but clears it on permission loss or another work',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true});const win=dom.window;
 Object.assign(globalThis,{window:win,document:win.document,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(win.document.getElementById('root')!);let fail='';
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(){if(fail)throw new WorkFailure(fail);return {id:'work',label:'보존할 업무',project_name:'합성 현장',events:[],evidence:[],documents:[],drafts:[],partial:false,next_cursor:null} as T;}};
 const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,20));});
 const render=async(id:string)=>{await act(async()=>root.render(<WorkLedgerDetail client={client} id={id} onEvidence={()=>{}} onDocument={()=>{}} onDraft={()=>{}}/>));await settle();};
 const refresh=async()=>{await act(async()=>{win.dispatchEvent(new win.Event('focus'));});await settle();};
 try{
  await render('first');assert.match(win.document.body.textContent??'',/보존할 업무/);
  fail='connection_wait';await refresh();assert.match(win.document.body.textContent??'',/보존할 업무/);assert.match(win.document.body.textContent??'',/마지막으로 확인한 기록/);
  await act(async()=>{win.document.querySelector<HTMLButtonElement>('button')!.click();});await settle();assert.match(win.document.body.textContent??'',/보존할 업무/);
  fail='NOT_FOUND';await refresh();assert.doesNotMatch(win.document.body.textContent??'',/보존할 업무/);
  fail='';await refresh();assert.match(win.document.body.textContent??'',/보존할 업무/);
  fail='connection_wait';await render('second');assert.doesNotMatch(win.document.body.textContent??'',/보존할 업무/);
 }finally{await act(async()=>root.unmount());win.close();}
});

/** WCAG relative-luminance contrast of two #rrggbb colors. */
function contrast(a:string,b:string){const lum=(hex:string)=>{const [r,g,bl]=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(c=>c<=0.03928?c/12.92:((c+0.055)/1.055)**2.4);return 0.2126*r!+0.7152*g!+0.0722*bl!;};const [x,y]=[lum(a),lum(b)].sort((p,q)=>q-p);return (x!+0.05)/(y!+0.05);}
test("UX tokens keep senior contrast: body 7:1, secondary text 4.5:1, borders and icons 3:1",()=>{
 const css=readFileSync(new URL("../apps/web/src/tokens.css",import.meta.url),"utf8"),root=css.slice(css.indexOf(":root{"),css.indexOf("}",css.indexOf(":root{")));
 const t=Object.fromEntries([...root.matchAll(/--([a-z0-9-]+):(#[0-9a-f]{6})/g)].map(m=>[m[1],m[2]])) as Record<string,string>;
 for(const bg of ["paper","surface"]){assert.ok(contrast(t.ink!,t[bg]!)>=7,`ink on ${bg}`);assert.ok(contrast(t["ink-2"]!,t[bg]!)>=7,`ink-2 on ${bg}`);assert.ok(contrast(t["ink-3"]!,t[bg]!)>=4.5,`ink-3 on ${bg}`);assert.ok(contrast(t.primary!,t[bg]!)>=7,`primary on ${bg}`);assert.ok(contrast(t["line-strong"]!,t[bg]!)>=3,`input border on ${bg}`);}
 assert.ok(contrast(t["on-primary"]!,t.primary!)>=7,"button text");
 for(const [fg,bg] of [["ok","ok-soft"],["warn","warn-soft"],["danger","danger-soft"],["primary","primary-soft"]] as const)assert.ok(contrast(t[fg]!,t[bg]!)>=4.5,`${fg} on ${bg}`);
 assert.equal(readWon("1375000"),"137만 5천원");assert.equal(readWon("125000000"),"1억 2,500만원");assert.equal(readWon(null),"");assert.equal(readWon("0"),"0원");
});

test("UX every work screen carries one heading, at most one main action, labelled controls and no axe violations",async()=>{
 const dom=new JSDOM('<!doctype html><html lang="ko"><head><title>시공노트</title></head><body><div id="root"></div></body></html>',{url:"http://localhost/#/today",runScripts:"outside-only",pretendToBeVisual:true});
 const win=dom.window;win.scrollTo=()=>{};
 Object.assign(globalThis,{window:win,document:win.document,location:win.location,history:win.history,localStorage:win.localStorage,HTMLElement:win.HTMLElement,Event:win.Event,CustomEvent:win.CustomEvent,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import("react-dom/client");const root=createRoot(win.document.getElementById("root")!);
 const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,40));});
 const text=()=>win.document.body.textContent??"";
 const waitFor=async(pattern:RegExp)=>{for(let i=0;i<50&&!pattern.test(text());i++)await settle();assert.match(text(),pattern);};
 const go=async(hash:string)=>{await act(async()=>{win.location.hash=hash;});await settle();};
 const click=async(label:string|RegExp)=>{const button=[...win.document.querySelectorAll<HTMLElement>("button,a")].find(b=>typeof label==="string"?b.textContent?.trim()===label:label.test(b.textContent??""));assert.ok(button,`Missing control: ${label}`);await act(async()=>{button.click();});await settle();};
 const type=async(selector:string,value:string)=>{await act(async()=>{const input=win.document.querySelector<HTMLInputElement|HTMLTextAreaElement>(selector)!;const proto=input instanceof win.HTMLTextAreaElement?win.HTMLTextAreaElement.prototype:win.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,"value")!.set!.call(input,value);input.dispatchEvent(new win.Event("input",{bubbles:true}));});};
 const checked=new Set<string>();let stoppedPdf=false;
 const screen=async(name:string)=>{
  const main=win.document.querySelector("main")!;
  assert.equal(main.querySelectorAll("h1").length,1,`${name}: one heading`);
  assert.ok(main.querySelectorAll(".button-primary").length<=1,`${name}: at most one main action (${[...main.querySelectorAll(".button-primary")].map(b=>b.textContent).join(" / ")})`);
  for(const control of main.querySelectorAll<HTMLElement>("button,a[href]"))assert.ok((control.textContent??"").trim()||control.getAttribute("aria-label"),`${name}: control without a name`);
  assert.doesNotMatch(main.textContent??"",/tenant|revision|귀속|객체|undefined|NaN/,`${name}: internal words`);
  if(!checked.has(name)){checked.add(name);win.eval(axe.source);const result=await (win as unknown as {axe:typeof axe}).axe.run(win.document,{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa","wcag22aa"]},rules:{"color-contrast":{enabled:false}}});assert.equal(result.violations.length,0,`${name}: ${JSON.stringify(result.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)})))}`);}
 };
 try{
  await act(async()=>{const base=previewWorkClient({delayMs:0,guideDone:true});root.render(<WorkApp client={{...base,request:async<T,>(r:Parameters<typeof base.request>[0])=>{try{if(stoppedPdf&&r.route==='evidence.chunks')return {revision_id:r.id,index_job_id:null,source_hash:'a'.repeat(64),parser_version:null,source_status:'pending',coverage:{pdf_processing:{state:'dead',pages_seen:220,pages_processed:200,job_id:crypto.randomUUID(),resume_generation:0,can_resume:true}},complete_extracted_text:false,indexed_chunks:0,index_status:'pending',chunks:[],next_cursor:null} as T;return await base.request<T>(r);}catch(e){if(process.env.DEBUG_SCREENS)console.error("REQ FAIL",r.route,e);throw e;}}}}/>);});await settle();await settle();
  assert.equal(win.location.hash,'#/today');assert.ok(win.document.querySelector('#today-ask-input'),'the work screen opens directly without a launch gate');assert.equal([...win.document.querySelectorAll('button')].some(b=>b.textContent==='바로 시작하기'),false);
  await waitFor(/오늘 할 일/);await screen("today");assert.match(win.document.querySelector('.today-arrivals')?.textContent??'',/납품 부탁드립니다/,'received observations are visible on Today');
  assert.equal(win.document.querySelector('[aria-label="사용 기록 안내"]'),null,'ordinary work has no usage dashboard or consent controls');
  assert.equal(win.document.querySelector('#nav-materials')?.textContent,'현장');
  assert.equal(win.document.querySelector('#nav-more')?.textContent,'설정');
  // Decision flow: one question → result → remember scope → next question.
  await click(/지금 확인하기/);assert.match(win.location.hash,/questions/);await waitFor(/확인할 일 1 \/ 3/);await screen("question");
  await click("이대로 반영");await waitFor(/답변을 반영했어요/);await waitFor(/송금·업무 전체 완료는 별도/);await screen("answer-result");
  await click("다음에도 이렇게 처리하기");await act(async()=>{win.document.querySelector<HTMLInputElement>("input[type=radio][value=project]")!.click();});await screen("remember");
  await click("이 범위로 기억");await waitFor(/저장했어요/);
  await click(/다음 확인할 일/);await waitFor(/확인할 일 1 \/ 2/);
  await click("말이나 글로 답하기");assert.match(win.location.hash,/questions\/reply/);await screen("reply");
  await type("#reply-input","그대로 해줘");await click("이 답으로 반영");await waitFor(/답변을 반영했어요/);assert.match(win.location.hash,/#\/questions$/);
  // Back walks one screen at a time: the answered question screen → today, never the reply form again.
  await click("뒤로");await waitFor(/오늘 할 일/);assert.match(win.location.hash,/#\/today$/);
  // Home keeps a text request field next to the microphone.
  await type("#today-ask-input","발주서 준비해줘");await click("보내기");await waitFor(/발주서 초안이 준비됐어요/);assert.match(win.location.hash,/ask\/result/);
  await click("뒤로");await waitFor(/오늘 할 일/);assert.match(win.location.hash,/#\/today$/);
  // Request flow: write → one result → prepared document → answer one blank → review → issue → send.
  await go("#/ask");await screen("ask");await type("#work-chat-input","햇살현장 견적서 준비해줘");await click("요청하기");assert.match(win.location.hash,/ask\/result/);await waitFor(/견적서 초안이 준비됐어요/);await screen("ask-result");
  await click(/문서 확인하기/);assert.match(win.location.hash,/draft\//);await waitFor(/빈칸 채우기 1 \/ 1/);const recipientInput=win.document.querySelector<HTMLInputElement>('.one-question input[autocomplete="organization"]');assert.ok(recipientInput?.required,'the missing recipient is an explicitly labelled required answer');assert.match(recipientInput.closest('label')?.textContent??'',/누구에게 보내나요/);await screen("draft-answer");
  await type('.one-question input[autocomplete="organization"]',"합성 고객");await click("답하고 초안 이어서 준비");await waitFor(/내용 확인 2 \/ 3/);await waitFor(/137만 5천원/);await screen("draft-review");
  await click("이 내용으로 발행하러 가기");await waitFor(/발행 확인 3 \/ 3/);await screen("draft-issue");
  await click("확인하고 문서 발행");await settle();await waitFor(/PDF·엑셀 준비 완료/);assert.match(win.location.hash,/documents\//);await screen("issued");
  // Materials: kinds → list → one material.
  await go("#/materials");await screen("materials");await click(/합성 햇살현장/);await screen("site-materials");await click(/납품·작업/);assert.match(win.location.hash,/materials\/site/);await waitFor(/주방 석고보드 납품/);await screen("ledger");await click(/주방 석고보드 납품/);await waitFor(/업무 흐름/);await screen("ledger-detail");
  stoppedPdf=true;await click(/석고보드 납품 확인/);assert.match(win.location.hash,/materials\/item\//);await waitFor(/읽은 내용/);await waitFor(/이어서 읽기 재개/);await screen("stopped-pdf-material");
  await click("뒤로");assert.match(win.location.hash,/materials\/work/);
  // Documents and more.
  await go("#/documents");await screen("documents");await click("받은 자료");await waitFor(/받은 자료 찾기/);assert.ok(win.document.querySelector('#received-search'));await waitFor(/석고보드 납품 확인/);await screen("received-documents");await click("발행본");await click(/Q-2026-0931/);await settle();assert.match(win.location.hash,/documents\//);await screen("document");
  for(const hash of ["#/more","#/more/memory","#/more/aliases","#/more/display","#/more/status","#/more/privacy"]){await go(hash);await screen(hash);}
  assert.ok(win.document.querySelector('[aria-label="사용 기록 안내"]'),'consent and withdrawal remain reachable in settings');
  await go("#/more/display");await act(async()=>{win.document.querySelectorAll<HTMLInputElement>("input[name=text-size]")[2]!.click();});assert.equal(win.document.documentElement.dataset.text,"xlarge");
 }finally{await act(async()=>root.unmount());win.close();}
});
