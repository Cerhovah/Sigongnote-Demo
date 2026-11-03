import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {act,type ReactNode} from 'react';
import {WorkLearning} from '../apps/web/src/work-learning.js';
import {WorkContextLearning} from '../apps/web/src/work-context-learning.js';
import type {WorkClient,WorkRequest} from '../apps/web/src/work-client.js';

async function mount(view:ReactNode){
 const dom=new JSDOM('<!doctype html><html lang="ko"><body><div id="root"></div></body></html>',{url:'https://fixture.test/#/more/learning',pretendToBeVisual:true}),win=dom.window;win.scrollTo=()=>{};
 Object.assign(globalThis,{window:win,document:win.document,location:win.location,HTMLElement:win.HTMLElement,Event:win.Event,CustomEvent:win.CustomEvent,localStorage:win.localStorage,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client'),root=createRoot(win.document.getElementById('root')!);
 const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,15));});
 await act(async()=>root.render(view));await settle();
 const button=(label:string)=>{const b=[...win.document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label);assert.ok(b,label);return b;};
 const click=async(label:string)=>{assert.equal(button(label).disabled,false,label+' is enabled');await act(async()=>button(label).click());await settle();};
 const type=async(label:string,value:string)=>{const l=[...win.document.querySelectorAll('label')].find(l=>l.textContent===label),el=l?.querySelector('input,textarea');assert.ok(el,label);const proto=el instanceof win.HTMLTextAreaElement?win.HTMLTextAreaElement.prototype:win.HTMLInputElement.prototype;await act(async()=>{Object.getOwnPropertyDescriptor(proto,'value')!.set!.call(el,value);el.dispatchEvent(new win.Event('input',{bubbles:true}));});await settle();};
 const checkbox=async()=>{const input=win.document.querySelector<HTMLInputElement>('input[type="checkbox"]');assert.ok(input);await act(async()=>input.click());await settle();};
 const refresh=async()=>{await act(async()=>win.document.dispatchEvent(new win.Event('visibilitychange')));await settle();};
 return {win,button,click,type,checkbox,refresh,text:()=>win.document.body.textContent??'',close:async()=>{await act(async()=>root.unmount());win.close();}};
}

function correction(){
 const source=randomUUID();return {id:randomUUID(),version:1,state:'unreviewed',eligible:true,source_ref:source,source_version:'1:'+('a'.repeat(64))+':1',snapshot:{previous:{summary:'합성 이전 연락',project_name:'합성 이전 현장'},replacement:{summary:'확인한 합성 현장 연락',project_name:'합성 확인 현장'},evidence:[{id:source,kind:'local',version:'1:'+('a'.repeat(64))+':1'}]},review_reason:null as string|null};
}
type Procedure={id:string;version:number;state:string;usable:boolean;train_ids:string[];evaluation:null|{independent:number;matched:number;wrong:number;abstained:number;leakage:number;canPromote:boolean}};
test('owner learning UI connects consent, reasoned truth adoption, evidence, candidate retry, independent comparison, promotion and withdrawal',async()=>{
 let allowed=false,lostCreate=true;const c=correction(),procedures:Procedure[]=[],commands:Record<string,any>[]=[],receipts=new Set<string>();let contextReads=0;
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:WorkRequest){
  if(r.route==='learning.list')return {consent:{allowed},summary:{available:0,unreviewed:0,corrections:0,new_facts:0},cases:[],next_cursor:null} as T;
  if(r.route==='learning.command'){const b=JSON.parse(r.command);assert.equal(b.action,'consent');assert.equal(b.purpose,'company-improvement-v1');allowed=b.allowed;return {saved:true} as T;}
  if(r.route==='context-learning.list'){contextReads++;return structuredClone({consent:{allowed},cases:allowed?[c]:[],procedures:allowed?procedures:[]}) as T;}
  assert.equal(r.route,'context-learning.command');if(r.route!=='context-learning.command')throw Error('Unexpected fixture route');
  const b=JSON.parse(r.command);commands.push(b);if(receipts.has(b.command_id))return {saved:true} as T;
  receipts.add(b.command_id);
  if(b.action==='case.review'){assert.equal(b.id,c.id);assert.equal(b.version,c.version);c.state=b.state;c.version++;c.review_reason=b.reason;}
  else if(b.action==='procedure.create'){assert.deepEqual(b.case_ids,[c.id]);procedures.push({id:randomUUID(),version:1,state:'shadow',usable:true,train_ids:[c.id],evaluation:null});if(lostCreate){lostCreate=false;throw Error('server saved; response lost');}}
  else{const p=procedures.find(p=>p.id===b.id);assert.ok(p);assert.equal(b.version,p.version);
   if(b.action==='procedure.evaluate')p.evaluation={independent:3,matched:3,wrong:0,abstained:0,leakage:0,canPromote:true};
   else if(b.action==='procedure.promote'){assert.equal(p.evaluation?.canPromote,true);p.state='promoted';p.version++;}
   else if(b.action==='procedure.withdraw'){p.state='withdrawn';p.version++;}
   else throw Error(b.action);
  }
  return {saved:true} as T;
 }};
 const ui=await mount(<WorkLearning client={client}/>);
 try{
  assert.match(ui.text(),/내 개선 기록 수집: 꺼짐/);assert.equal(contextReads,0);assert.doesNotMatch(ui.text(),/확인한 합성 현장 연락/);
  await ui.click('회사 내부 개선에 동의하고 수집 시작');assert.match(ui.text(),/내 개선 기록 수집: 켜짐/);assert.match(ui.text(),/확인한 합성 현장 연락/);
  assert.equal(ui.button('이 교정을 정답으로 확인').disabled,true);await ui.type('확인한 이유','원문과 현장 주소를 대조함');assert.equal(ui.button('이 교정을 정답으로 확인').disabled,false);
  assert.equal(ui.win.document.querySelector('a[href="#/materials/item/'+c.source_ref+'"]')?.textContent,'근거 열기');
  await ui.click('이 교정을 정답으로 확인');assert.equal(commands[0]?.state,'adopted');assert.equal(commands[0]?.reason,'원문과 현장 주소를 대조함');assert.match(ui.text(),/확인한 정답/);
  assert.equal(ui.button('선택한 사례로 읽기 절차 비교 시작').disabled,true);await ui.checkbox();await ui.click('선택한 사례로 읽기 절차 비교 시작');
  assert.match(ui.text(),/저장 결과를 확인하지 못했어요/);assert.doesNotMatch(ui.text(),/확인한 합성 현장 연락/);
  await ui.click('다시 확인');assert.match(ui.text(),/새 자료에서 비교 중/);await ui.click('선택한 사례로 읽기 절차 비교 시작');
  const createCommands=commands.filter(c=>c.action==='procedure.create');assert.equal(createCommands.length,2);assert.deepEqual(createCommands[0],createCommands[1],'lost successful response retries the exact command ID');assert.equal(procedures.length,1,'retry creates no second procedure');
  assert.equal(ui.button('이 읽기 절차 사용').disabled,true);await ui.click('새 자료 비교 결과 확인');assert.match(ui.text(),/나중에 들어온 독립 자료 3건 · 일치 3 · 오류 0 · 미특정 0 · 평가에 섞인 학습 자료 0/);
  await ui.click('이 읽기 절차 사용');assert.match(ui.text(),/읽기 절차 사용 중/);assert.equal(commands.find(c=>c.action==='procedure.promote')?.version,1);
  await ui.click('절차 사용 중지');assert.match(ui.text(),/사용 중지/);assert.equal(commands.find(c=>c.action==='procedure.withdraw')?.version,2);
  await ui.click('개선 동의 철회하고 내 사례 삭제');await ui.click('동의 철회·삭제 확인');assert.match(ui.text(),/내 개선 기록 수집: 꺼짐/);assert.equal(ui.win.document.querySelector('[aria-label="현장 연결 교정 학습"]'),null,'revocation immediately unmounts protected correction cases');assert.doesNotMatch(ui.text(),/확인한 합성 현장 연락/);
 }finally{await ui.close();}
});

test('learning UI hides old protected cases after a permission failure and does not retain their actions',async()=>{
 let denied=false;const c=correction();const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:WorkRequest){assert.equal(r.route,'context-learning.list');if(denied)throw Object.assign(Error('permission revoked'),{code:'NOT_FOUND'});return {consent:{allowed:true},cases:[c],procedures:[]} as T;}};
 const ui=await mount(<WorkContextLearning client={client}/>);
 try{assert.match(ui.text(),/확인한 합성 현장 연락/);denied=true;await ui.refresh();assert.match(ui.text(),/권한과 연결을 다시 확인/);assert.doesNotMatch(ui.text(),/확인한 합성 현장 연락/);assert.equal(ui.win.document.querySelector('input'),null);assert.equal([...ui.win.document.querySelectorAll('button')].some(b=>b.textContent==='이 교정을 정답으로 확인'),false);}finally{await ui.close();}
});

test('learning consent OFF never renders stale cases returned alongside the off state',async()=>{
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(){return {consent:{allowed:false},cases:[correction()],procedures:[]} as T;}};
 const ui=await mount(<WorkContextLearning client={client}/>);
 try{assert.match(ui.text(),/회사 내부 개선에 동의한 뒤/);assert.doesNotMatch(ui.text(),/확인한 합성 현장 연락/);assert.equal(ui.win.document.querySelector('input'),null);}finally{await ui.close();}
});
