import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {act} from 'react';
import type {ReactNode} from 'react';
import {WorkApp} from '../apps/web/src/work-app.js';
import {WorkEventDetail,type EventDetail} from '../apps/web/src/work-events.js';
import {WorkAiConsent} from '../apps/web/src/work-ai-consent.js';
import {WorkDraft} from '../apps/web/src/work-draft.js';
import {previewWorkClient} from '../apps/web/src/work-preview-client.js';
import type {WorkClient,WorkContext,WorkRequest} from '../apps/web/src/work-client.js';
import type {CapturePolicy} from '@sigongnote/contracts';

async function mount(view:ReactNode,hash='today'){
 const dom=new JSDOM('<!doctype html><html lang="ko"><body><div id="root"></div></body></html>',{url:'https://fixture.test/#/'+hash,pretendToBeVisual:true}),win=dom.window;win.scrollTo=()=>{};
 Object.assign(globalThis,{window:win,document:win.document,location:win.location,HTMLElement:win.HTMLElement,Event:win.Event,CustomEvent:win.CustomEvent,localStorage:win.localStorage,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client'),root=createRoot(win.document.getElementById('root')!);
 const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,15));});
 await act(async()=>root.render(view));await settle();
 const click=async(label:string)=>{const b=[...win.document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label);assert.ok(b,label);await act(async()=>b.click());await settle();};
 const type=async(label:string,value:string)=>{const l=[...win.document.querySelectorAll('label')].find(l=>l.textContent===label),el=l?.querySelector('input,textarea');assert.ok(el,label);const proto=el instanceof win.HTMLTextAreaElement?win.HTMLTextAreaElement.prototype:win.HTMLInputElement.prototype;await act(async()=>{Object.getOwnPropertyDescriptor(proto,'value')!.set!.call(el,value);el.dispatchEvent(new win.Event('input',{bubbles:true}));});};
 return {win,click,type,settle,text:()=>win.document.body.textContent??'',submit:async(selector:string)=>{await act(async()=>{win.document.querySelector(selector)!.dispatchEvent(new win.Event('submit',{bubbles:true,cancelable:true}));});await settle();},close:async()=>{await act(async()=>root.unmount());win.close();}};
}
const eventId=randomUUID(),sourceId=randomUUID(),siteId=randomUUID();
const event={id:eventId,kind:'fact',summary:'합성 현장 자재 도착 연락',detail:'작업자가 자재 도착을 알림',project_id:siteId,project_name:'합성 현장',party:null,source_kind:'local',source_ref:sourceId,evidence_refs:[],version:1,missing:[],confidence:'high',status:'open',reasoning:'전날 통화의 현장과 연결',created_at:'2026-10-21T01:00:00Z',followups:[]};
const context:WorkContext={user_id:randomUUID(),tenant_id:randomUUID(),company:'합성 회사',cloud_connected:true,can_maintain:true,projects:[{id:siteId,display_name:'합성 현장'}]};
const detail:EventDetail={event,source:{id:sourceId,kind:'local',text:'합성 자재 도착 연락 원문',available:true},evidence:[{id:randomUUID(),kind:'local',text:null,available:false}],usage:null,corrections:[]};
const policy:CapturePolicy={id:'anthropic-work-records-v1',purpose:'work_records',provider:'anthropic',processing_location:'US primary',storage_location:'KR company',retention:'until_user_deletes',external_processing:true,processors:[{purpose:'long_stt',provider:'openai',processing_location:'US transcription',storage_location:'provider transient',retention:'delete after transcription'}]};

test('connected PC opens server facts without followups and document creation instead of local-only screens',async()=>{
 const base=previewWorkClient({delayMs:0,guideDone:true}),queries:string[]=[];
 const client:WorkClient={...base,kind:'local',async request<T>(r:WorkRequest){queries.push(r.route);if(r.route==='context')return context as T;if(r.route==='journal.tasks')return {items:[],events:[event],partial:false} as T;if(r.route==='events.read')return detail as T;if(r.route==='questions.list')return {questions:[],can_answer:true} as T;if(r.route==='documents.list')return {documents:[],prepared:[]} as T;return base.request<T>(r);}};
 const ui=await mount(<WorkApp client={client}/>);
 try{assert.match(ui.text(),/합성 현장 자재 도착 연락/);assert.ok(queries.includes('journal.tasks'));assert.doesNotMatch(ui.text(),/새 파일 자동 정리/);await ui.click('문서 만들기');assert.equal(ui.win.location.hash,'#/documents/new');assert.match(ui.text(),/근거로 쓸 기록|현장 선택/);assert.equal(ui.win.document.querySelector('h1')?.textContent,'문서 만들기');}finally{await ui.close();}
});

test('event detail keeps unavailable prior evidence explicit and retries one correction command',async()=>{
 const commands:Record<string,unknown>[]=[];let fail=true,reads=0;
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:WorkRequest){if(r.route==='events.read'){reads++;return {...detail,corrections:reads>1?[{created_at:'2026-10-21T02:00:00Z',reason:'현장명 확인'}]:[]} as T;}if(r.route==='journal.command'){commands.push(JSON.parse(r.command));if(fail){fail=false;throw Error('lost response');}return {event} as T;}throw Error(r.route);}};
 let opened='';const ui=await mount(<WorkEventDetail client={client} context={context} id={eventId} onEvent={()=>{}} onOpen={id=>{opened=id;}}/>);
 try{assert.match(ui.text(),/전날 통화/);assert.match(ui.text(),/현재 접근할 수 없는 자료/);await ui.click('자료 열기');assert.equal(opened,sourceId);await ui.click('현장·내용 수정');await ui.type('수정 이유','현장명 확인');await ui.submit('form');assert.match(ui.text(),/같은 수정/);await ui.submit('form');assert.equal(commands.length,2);assert.deepEqual(commands[0],commands[1]);assert.equal(commands[0]?.expected_version,1);assert.match(ui.text(),/수정 이력/);}finally{await ui.close();}
});

test('AI consent can be granted once for a company then revoked with the returned version',async()=>{
 const commands:WorkRequest[]=[];const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:WorkRequest){commands.push(r);assert.equal(r.route,'ai.consent');return {allowed:r.allowed,version:r.expected_version+1,policy_current:true} as T;}};
 const ui=await mount(<WorkAiConsent client={client} context={{...context,ai_consent:{allowed:false,version:0,policy_current:true,processing_policy:policy}}} settings onChanged={()=>{}}/>);
 try{assert.match(ui.text(),/현장·업무 정리: Anthropic Claude/);assert.match(ui.text(),/긴 녹음 전사: OpenAI/);assert.match(ui.text(),/provider transient/);await ui.click('자료 AI 정리 허용');assert.match(ui.text(),/켜짐/);assert.match(ui.text(),/delete after transcription/);await ui.click('AI 정리 허용 철회');assert.equal(commands.length,2);assert.deepEqual(commands.map(r=>r.route==='ai.consent'?[r.allowed,r.expected_version]:null),[[true,0],[false,1]]);assert.deepEqual(commands[0]?.route==='ai.consent'?commands[0].processing_policy:null,policy);assert.equal(commands[1]?.route==='ai.consent'?commands[1].processing_policy:null,undefined,'revocation stays available independently of a changed provider policy');assert.doesNotMatch(ui.text(),/켜짐/);}finally{await ui.close();}
});

test('AI consent refreshes a changed same-ID processor policy without automatically authorizing it',async()=>{
 const updated:CapturePolicy={...policy,processors:[{...policy.processors![0]!,processing_location:'EU transcription'}]},commands:Extract<WorkRequest,{route:'ai.consent'}>[]=[];
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:WorkRequest){if(r.route==='setup.read')return {policy:updated} as T;assert.equal(r.route,'ai.consent');if(r.route!=='ai.consent')throw Error('unexpected route');commands.push(r);if(commands.length===1)throw Object.assign(Error('changed'),{code:'SOURCE_EXPIRED'});return {allowed:true,version:1,policy_current:true,processing_policy:updated} as T;}};
 const ui=await mount(<WorkAiConsent client={client} context={{...context,ai_consent:{allowed:false,version:0,policy_current:true,processing_policy:policy}}} settings onChanged={()=>{}}/>);
 try{await ui.click('자료 AI 정리 허용');assert.equal(commands.length,1);assert.match(ui.text(),/현재 조건을 읽고 다시 선택/);assert.match(ui.text(),/EU transcription/);assert.doesNotMatch(ui.text(),/· 켜짐/);await ui.click('자료 AI 정리 허용');assert.equal(commands.length,2);assert.deepEqual(commands[0]!.processing_policy,policy);assert.deepEqual(commands[1]!.processing_policy,updated);assert.notEqual(commands[0]!.client_command_id,commands[1]!.client_command_id);assert.match(ui.text(),/켜짐/);}finally{await ui.close();}
});

test('a stored consent can still be revoked when its policy is stale and the current notice is unavailable',async()=>{
 const commands:WorkRequest[]=[];
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:WorkRequest){if(r.route==='setup.read')return {policy:null} as T;commands.push(r);assert.equal(r.route,'ai.consent');return {allowed:false,version:4,policy_current:true} as T;}};
 const ui=await mount(<WorkAiConsent client={client} context={{...context,ai_consent:{allowed:true,version:3,policy_current:false,processing_policy:null}}} settings onChanged={()=>{}}/>);
 try{const allow=[...ui.win.document.querySelectorAll('button')].find(b=>b.textContent==='자료 AI 정리 허용');assert.equal(allow?.disabled,true);await ui.click('AI 정리 허용 철회');assert.equal(commands.length,1);assert.equal(commands[0]?.route==='ai.consent'?commands[0].allowed:null,false);assert.equal(commands[0]?.route==='ai.consent'?commands[0].processing_policy:null,undefined);assert.doesNotMatch(ui.text(),/· 켜짐/);}finally{await ui.close();}
});

test('estimate recovery edits the buy price rather than reusing the calculated sale price',async()=>{
 const id=randomUUID(),lineId=randomUUID();let command:WorkRequest|undefined;
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:WorkRequest){if(r.route==='documents.complete'){command=r;return {id} as T;}return {id,state:'needs_inputs',stale:false,source_candidate:true,missing:['수량'],source_refs:[],input_lines:[{id:lineId,description:'문틀',spec:'',unit:'개',quantity:'',unit_price:'20000'}],document:{type:'estimate',issuer:{name:'합성 회사'},recipient:{name:'합성 고객'},project:{id:siteId,name:'합성 현장'},date:'2026-10-21',lines:[{id:lineId,description:'문틀',spec:'',unit:'개',quantity:null,unit_price:'25000',supply:null,tax:null}],totals:{supply:null,tax:null,total:null}}} as T;}};
 const ui=await mount(<WorkDraft client={client} id={id} onOpen={()=>{}}/>);
 try{const price=[...ui.win.document.querySelectorAll('label')].find(l=>l.textContent==='매입단가 (원)')?.querySelector('input');assert.equal(price?.value,'20000');await ui.type('수량','100');await ui.submit('.draft-lines form');assert.equal(command?.route,'documents.complete');if(command?.route==='documents.complete')assert.deepEqual(JSON.parse(command.lines!),[{id:lineId,description:'문틀',spec:'',unit:'개',quantity:'100',unit_price:'20000'}]);}finally{await ui.close();}
});
