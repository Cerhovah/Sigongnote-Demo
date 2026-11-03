import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {act} from "react";
import {randomUUID} from "node:crypto";
import {WorkApp} from "../apps/web/src/work-app.js";
import {previewWorkClient} from "../apps/web/src/work-preview-client.js";
import type {WorkClient,WorkRequest} from "../apps/web/src/work-client.js";

/** One DOM per flow. Every screen is checked for one heading and at most one main action. */
async function mount(client:WorkClient,hash="#/today"){
 const dom=new JSDOM('<!doctype html><html lang="ko"><head><title>시공노트</title></head><body><div id="root"></div></body></html>',{url:"http://localhost/"+hash,pretendToBeVisual:true}),win=dom.window;win.scrollTo=()=>{};
 Object.assign(globalThis,{window:win,document:win.document,location:win.location,history:win.history,localStorage:win.localStorage,sessionStorage:win.sessionStorage,HTMLElement:win.HTMLElement,Event:win.Event,CustomEvent:win.CustomEvent,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import("react-dom/client");const root=createRoot(win.document.getElementById("root")!);
 const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,30));});
 const text=()=>win.document.querySelector("main")?.textContent??"";
 const waitFor=async(pattern:RegExp)=>{for(let i=0;i<40&&!pattern.test(text());i++)await settle();assert.match(text(),pattern);};
 const click=async(label:string|RegExp)=>{const control=[...win.document.querySelectorAll<HTMLElement>("button,a,summary")].find(b=>typeof label==="string"?b.textContent?.trim()===label:label.test(b.textContent??""));assert.ok(control,`Missing control: ${label}`);await act(async()=>{control.click();});await settle();};
 const type=async(selector:string,value:string)=>{await act(async()=>{const input=win.document.querySelector<HTMLInputElement>(selector)!;assert.ok(input,selector);Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,"value")!.set!.call(input,value);input.dispatchEvent(new win.Event("input",{bubbles:true}));});};
 const screen=(name:string)=>{const main=win.document.querySelector("main")!;assert.equal(main.querySelectorAll("h1").length,1,`${name}: one heading`);assert.ok(main.querySelectorAll(".button-primary").length<=1,`${name}: at most one main action (${[...main.querySelectorAll(".button-primary")].map(b=>b.textContent).join(" / ")})`);for(const control of main.querySelectorAll<HTMLElement>("button,a[href]"))assert.ok((control.textContent??"").trim()||control.getAttribute("aria-label"),`${name}: control without a name`);};
 await act(async()=>{root.render(<WorkApp client={client}/>);});await settle();await settle();
 return {win,root,settle,text,waitFor,click,type,screen,close:async()=>{await act(async()=>root.unmount());win.close();}};
}
const site={id:randomUUID(),display_name:"합성 첫 현장"};
const sms={id:randomUUID(),organization_version:1,received_at:new Date().toISOString(),occurred_at:null,source_kind:"sms",declared_mime:"application/vnd.sigongnote.message+json",project_id:site.id,project_name:site.display_name,categories:["delivery_work"],excerpt:"내일 오전 석고보드 20장 추가 납품 부탁드립니다.",reading_state:"readable",parse_status:"complete",observations:[]};
const readiness=(sources:number)=>({checked_at:new Date().toISOString(),capabilities:[],coverage:{source_count:sources,reported_scanned_count:0,last_scan_at:null,full_content:"not_verified"},limits:{daily_krw:10000,monthly_krw:50000,source_bytes:"100000000000",scope:"per_user",budget_enforced:true},formats:[]});
/** The synthetic preview plus a controllable first-use state. */
function fixture(options:{firstUse:boolean;noSites?:boolean}){
 const base=previewWorkClient({delayMs:0,guideDone:true});
 const setup={project_id:options.firstUse?null:site.id as string|null,version:0,dismissed:false,completed:!options.firstUse};
 const projects:{id:string;display_name:string}[]=options.firstUse||options.noSites?[]:[site];
 const journal=options.firstUse?[]:[sms];const commands:Record<string,unknown>[]=[];const turns:Record<string,unknown>[]=[];const draftId=randomUUID();let taskDone=false;
 const client:WorkClient={kind:"fixture",dispose(){},async request<T>(r:WorkRequest):Promise<T>{
  switch(r.route){
   case "context":return {user_id:"u",tenant_id:"t",company:"합성 회사",can_maintain:true,can_resolve_site:true,projects:[...projects],setup:{...setup},readiness:readiness(0)} as T;
   case "setup.read":return {...setup,policy:null} as T;
   case "setup.command":{const c=JSON.parse(r.command);commands.push(c);if(c.action==="select"){if(c.display_name){projects.push({...site,display_name:c.display_name});setup.project_id=site.id;}else setup.project_id=c.project_id;}if(c.action==="complete")setup.completed=true;if(c.action==="dismiss")setup.dismissed=true;setup.version++;return {...setup} as T;}
   case "journal.list":return {items:journal.filter(i=>(!r.project_id||i.project_id===r.project_id)&&(!r.category||i.categories.includes(r.category))),next_cursor:null} as T;
   case "journal.tasks":return {items:options.firstUse?[]:[{id:"task",revision_id:sms.id,text:"내일 오전 석고보드 20장 추가 납품",project_name:site.display_name,project_id:site.id,done:taskDone,version:taskDone?2:1}],partial:false} as T;
   case "journal.command":{const c=JSON.parse(r.command);commands.push(c);if(c.action==="draft")return {id:draftId} as T;taskDone=Boolean(c.done);return {done:taskDone,version:2} as T;}
   case "agenda.read":return {today:new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Seoul"}),items:[],partial:false} as T;
   case "questions.list":return {questions:[],can_answer:true,coverage:"합성"} as T;
   case "documents.list":return {documents:[],prepared:[]} as T;
   case "documents.read":if(r.id===draftId)return {id:draftId,state:"needs_inputs",stale:false,source_candidate:true,missing:["받는 곳"],source_refs:[sms.id],document:{basis_hash:"e".repeat(64),type:"estimate",document_number:"초안",issuer:{name:"합성 회사"},recipient:{name:null},project:{id:site.id,name:site.display_name},date:"2026-10-06",lines:[],totals:{supply:null,tax:null,total:null}}} as T;return base.request<T>(r);
   case "conversation.turn":turns.push(r as unknown as Record<string,unknown>);return base.request<T>(r);
   case "ledger.list":return {items:[],next_cursor:null} as T;
   case "materials.detail":return {revision:{id:r.id,status:"complete",declared_mime:"text/plain"},organization:null,result:{created_at:new Date().toISOString(),processor_version:"fixture",output:{status:"complete",spans:[{text:sms.excerpt,locator:"line:1"}],issues:[],excerptTruncated:false,sourceHash:"a".repeat(64)}}} as T;
   default:return base.request<T>(r);
  }
 }};
 return {client,commands,turns,setup,draftId};
}

test('UX central camera opens native capture once and leaves a site photo collection screen',async()=>{
 const {client}=fixture({firstUse:false});let captures=0;
 const ui=await mount({...client,capturePhoto(){captures++;}});
 try{
  const nav=ui.win.document.querySelector('nav')!;
  assert.deepEqual([...nav.children].map(e=>e.textContent),['오늘','현장','촬영','문서','설정']);
  await act(async()=>{const camera=ui.win.document.querySelector<HTMLButtonElement>('#nav-camera')!;camera.click();camera.click();});await ui.settle();
  assert.equal(captures,1);assert.equal(ui.win.location.hash,'#/photos');
  assert.equal(ui.win.document.querySelector('h1')?.textContent,'현장 사진');
  assert.match(ui.text(),/사진을 모을 현장/);
  assert.doesNotMatch(ui.text(),/사진을 찍거나 갤러리에서|설치 앱에 사진 폴더/);
 }finally{await ui.close();}
});

test('UX browser camera cancellation stays put; a photo survives adding a first site and waits for consent',async()=>{
 const {client,commands}=fixture({firstUse:false,noSites:true});const ui=await mount(client);
 try{
  const input=ui.win.document.querySelector<HTMLInputElement>('input[capture="environment"]')!;
  assert.equal(input.accept,'image/*');let opens=0;input.click=()=>{opens++;};
  await act(async()=>ui.win.document.querySelector<HTMLButtonElement>('#nav-camera')!.click());
  assert.equal(opens,1);assert.equal(ui.win.location.hash,'#/today');
  Object.defineProperty(input,'files',{value:[new ui.win.File(['synthetic'],'photo.jpg',{type:'image/jpeg'})]});
  await act(async()=>input.dispatchEvent(new ui.win.Event('change',{bubbles:true})));await ui.settle();
  assert.equal(ui.win.location.hash,'#/add/photo');assert.match(ui.text(),/photo.jpg/);
  assert.equal(ui.win.document.querySelector<HTMLSelectElement>('main select')!.value,'');
  assert.equal(ui.win.document.querySelector<HTMLButtonElement>('main .button-primary')!.disabled,true);
  await ui.click('현장 추가');await ui.waitFor(/현장 이름/);await ui.type('main input','합성 사진 현장');await ui.click('이 현장 추가');await ui.settle();
  assert.match(ui.win.location.hash,/^#\/add\/photo\?project=/);assert.match(ui.text(),/photo.jpg/);
  assert.equal(ui.win.document.querySelector<HTMLSelectElement>('main select')!.value,site.id);
  assert.equal(commands.length,1);assert.equal(commands[0]?.action,'select');
  assert.equal(ui.win.document.querySelector<HTMLButtonElement>('main .button-primary')!.disabled,true);
  await ui.click('뒤로');await ui.settle();assert.equal(ui.win.location.hash,'#/journal');assert.equal(ui.win.document.querySelector('h1')?.textContent,'업무일지');assert.doesNotMatch(ui.text(),/photo.jpg/);assert.equal(commands.length,1,'leaving the selected photo does not upload or approve it');
 }finally{await ui.close();}
});

test("UX first use enters Today without a site, sources or completed onboarding",async()=>{
 const {client,commands,setup}=fixture({firstUse:true});const ui=await mount(client);
 try{
  await ui.waitFor(/오늘/);ui.screen("today-first");
  assert.equal(ui.win.location.hash,'#/today');
  assert.ok(ui.win.document.querySelector('#today-ask-input'));
  assert.ok(ui.win.document.querySelector('#nav-camera'));
  assert.doesNotMatch(ui.text(),/어느 현장부터|첫 자료 확인|다른 기기에서도|처음 시작 마치기/);
  assert.equal(commands.length,0);assert.equal(setup.completed,false);
  await ui.click("현장");await ui.waitFor(/현장 추가/);await ui.click("현장 추가");
  await ui.type("main input","합성 첫 현장");await ui.click("이 현장 추가");await ui.settle();
  assert.match(ui.win.location.hash,/^#\/materials\/site/);assert.equal(commands[0]?.display_name,"합성 첫 현장");
  await ui.click("오늘");await ui.settle();assert.equal(ui.win.location.hash,'#/today');
  assert.doesNotMatch(ui.text(),/어느 현장부터|첫 자료 확인|처음 시작 마치기/);
 }finally{await ui.close();}
});

test("UX with records: today lists the request, opens its site, and the site shows dated records before documents",async()=>{
 const {client:base,commands}=fixture({firstUse:false});let releaseAgenda!:()=>void;
 const agendaGate=new Promise<void>(resolve=>{releaseAgenda=resolve;});
 const client:WorkClient={...base,async request<T>(r:WorkRequest){if(r.route==='agenda.read')await agendaGate;return base.request<T>(r);}};
 const ui=await mount(client);
 try{
  await ui.waitFor(/오늘 할 일/);ui.screen("today");
  assert.match(ui.text(),/내일 오전 석고보드 20장 추가 납품/);assert.match(ui.text(),/업무일지/);const arrival=ui.win.document.querySelector('.today-arrivals .journal-row');assert.ok(arrival,'Today keeps received source observations visible beside the actionable checklist');assert.match(arrival.textContent??'',/납품 부탁드립니다/);assert.equal(ui.win.document.querySelectorAll('.today-arrivals .journal-list').length,1);
  const beforeAgenda=ui.win.document.querySelector('#today-next')?.getAttribute('aria-busy');
  await act(async()=>{releaseAgenda();});await ui.settle();
  assert.deepEqual([beforeAgenda,ui.win.document.querySelector('#today-next')?.getAttribute('aria-busy')],['true','false'],'visible tasks do not mark Today settled while its actual agenda request is still pending');
  assert.equal(ui.win.document.querySelectorAll("main .button-primary").length,0,"no competing main action once work exists");
  assert.ok(ui.win.document.querySelector("#today-ask-input"),"one entry for a written request");assert.match(ui.text(),/자료 찾기/);assert.ok(ui.win.document.querySelector("#nav-camera"));
  assert.doesNotMatch(ui.text(),/새 문자·통화·사진에서|요청과 예정을 모으고|준비된 문서|문자·통화·사진 연결새로/);
  await ui.click("내 처리 완료");assert.equal(commands.at(-1)?.action,"task");assert.equal(commands.at(-1)?.done,true);assert.match(ui.text(),/새로 확인할 일이 없어요/);assert.match(ui.win.document.querySelector('.today-arrivals')?.textContent??'',/납품 부탁드립니다/,'checking off work does not erase the received source');
  await ui.click("현장");await ui.waitFor(/현장 추가/);ui.screen("sites");assert.doesNotMatch(ui.text(),/현장을 고르면|처음부터 따라 하기|모든 현장 업무 보기/);
  await ui.click(/합성 첫 현장/);await ui.waitFor(/날짜별 기록/);ui.screen("site");
  assert.equal(ui.win.document.querySelector("h1")?.textContent,"합성 첫 현장");const entry=ui.win.document.querySelector<HTMLDetailsElement>(".journal-entry")!;assert.equal(entry.open,false);await act(async()=>entry.querySelector<HTMLElement>("summary")!.click());assert.equal(entry.open,true);assert.match(entry.textContent!,/납품 부탁드립니다/);
  assert.equal(ui.win.document.querySelectorAll("main select").length,0,"the site is the title, not a picker");
  await ui.click("납품·작업");assert.match(ui.win.location.hash,/category=delivery_work/);assert.match(ui.text(),/납품 부탁드립니다/);
  await ui.click("점검·하자");assert.match(ui.text(),/기록 없음/);
  await ui.click("문서");await ui.waitFor(/초안 없음/);ui.screen("documents");
  assert.doesNotMatch(ui.text(),/구분해 관리합니다|새 초안이 생겨도/);
  const photos=[...ui.win.document.querySelectorAll("main button")].findIndex(b=>/현장 사진/.test(b.textContent??"")),make=[...ui.win.document.querySelectorAll("main button")].findIndex(b=>/문서 만들기/.test(b.textContent??""));
  assert.ok(make>=0&&photos>make,"photos are a quiet entry after the document list");
 }finally{releaseAgenda();await ui.close();}
});

test("UX empty documents lead to a real draft from a site record, or to a request fixed to that site",async()=>{
 const {client,commands,turns,draftId}=fixture({firstUse:false});const ui=await mount(client,"#/documents");
 try{
  await ui.waitFor(/초안 없음/);await ui.click("문서 만들기");await ui.waitFor(/요청으로 준비/);ui.screen("document-new");
  assert.equal(ui.win.document.querySelector<HTMLSelectElement>("main select")!.value,"","no site is chosen for the user");
  await act(async()=>{const select=ui.win.document.querySelector<HTMLSelectElement>("main select")!;select.value=site.id;select.dispatchEvent(new ui.win.Event("change",{bubbles:true}));});await ui.settle();
  await ui.waitFor(/납품 부탁드립니다/);await ui.click("발주서");
  await ui.click(/납품 부탁드립니다/);const draft=commands.find(c=>c.action==="draft");assert.ok(draft);assert.equal(draft.type,"purchase_order");assert.equal(draft.project_id,site.id);assert.equal(draft.id,sms.id);assert.equal(draft.expected_version,1);
  await ui.waitFor(/누구에게 보내나요/);assert.equal(ui.win.location.hash,`#/draft/${draftId}`);ui.screen("draft");
  await act(async()=>{ui.win.location.hash="#/documents/new";});await ui.settle();await ui.waitFor(/근거로 쓸 기록/);
  assert.equal(ui.win.document.querySelector<HTMLSelectElement>("main select")!.value,site.id,"the chosen site is kept");
  await ui.click(/견적서 요청으로 준비/);await ui.waitFor(/견적서 초안이 준비됐어요/);ui.screen("ask-result");
  assert.equal(turns.length,1);assert.equal(turns[0]?.text,"견적서 준비해줘");assert.equal(turns[0]?.selected_project_id,site.id);
 }finally{await ui.close();}
});

test("UX settings keep frequent actions visible and optional management in one closed section",async()=>{
 const {client}=fixture({firstUse:false});const ui=await mount(client,"#/more");
 try{
  await ui.waitFor(/사용 기록·동의/);ui.screen("settings");
  const rows=[...ui.win.document.querySelectorAll("main .row")].map(r=>r.textContent??"");
  assert.doesNotMatch(rows.join("|"),/날짜별 업무일지|현장 사진/,"journal and photos are not repeated in settings");
  const advanced=ui.win.document.querySelector<HTMLDetailsElement>("details.settings-advanced")!;assert.ok(advanced);assert.equal(advanced.open,false);
  assert.match(advanced.textContent??"",/과거 자료 보관·정리/);assert.match(advanced.textContent??"",/연결·보관 상태/);
  const visible=[...ui.win.document.querySelectorAll("main .settings-group .row")].map(r=>r.textContent??"").join("|");
  assert.doesNotMatch(visible,/과거 자료 보관/);assert.doesNotMatch(visible,/사용 기록·동의/);assert.match(advanced.textContent??"",/사용 기록·동의/);assert.match(visible,/글자 크기/);
  assert.equal(ui.win.document.querySelector("main .settings-group .row")?.textContent?.includes("자료 연결"),true,"connections are optional settings");
  await ui.click("더 보기");assert.equal(advanced.open,true);await ui.click(/과거 자료 보관·정리/);await ui.waitFor(/기존 자료 정리/);assert.equal(ui.win.document.querySelector('h1')?.textContent,'기존 자료 정리');assert.match(ui.text(),/보관한 과거 자료 분석 시작/);assert.match(ui.win.location.hash,/#\/archive/);
 }finally{await ui.close();}
});
test('UX fresh native installation opens Today even when another device has unfinished setup',async()=>{
 const fixtureData=fixture({firstUse:true});const requests:string[]=[];
 const client:WorkClient={...fixtureData.client,kind:'native',async request<T>(r:WorkRequest){requests.push(r.route);return fixtureData.client.request<T>(r);}};
 const ui=await mount(client);
 try{
  assert.equal(ui.win.location.hash,'#/today');assert.ok(ui.win.document.querySelector('#today-ask-input'));
  assert.ok(ui.win.document.querySelector('#nav-camera'));assert.equal(requests.includes('setup.read'),false);
  assert.equal(requests.includes('setup.command'),false);assert.doesNotMatch(ui.text(),/현장 이름|자동 수집 연결|첫 자료 확인/);
  await ui.click('문서');await ui.waitFor(/문서 만들기/);assert.equal(ui.win.location.hash,'#/documents');
 }finally{await ui.close();}
});
