import assert from 'node:assert/strict';
import {test} from 'node:test';
import React,{act,useState} from 'react';
import {JSDOM} from 'jsdom';
import {useAsk,AskResult,type Ask} from '../apps/web/src/work-ask.js';
import type {WorkClient,VoiceEvent} from '../apps/web/src/work-client.js';
test('continuation failures refresh state and distinguish conflict or revoked access from connection failure',async()=>{
 for(const code of ['VERSION_CONFLICT','NOT_FOUND']){
  const dom=new JSDOM('<div id="root"></div>',{url:'https://test.invalid/'}),win=dom.window;Object.assign(globalThis,{window:win,document:win.document,localStorage:win.localStorage,IS_REACT_ACT_ENVIRONMENT:true});
  const {createRoot}=await import('react-dom/client');const root=createRoot(win.document.getElementById('root')!);let ask:Ask;
  const id='11111111-1111-4111-8111-111111111111',result={run_id:id,turn_id:id,status:'needs_answer',text:'이어가기',cards:[],next_job:{id,status:'ready'}};const requests:string[]=[];
  const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:Parameters<WorkClient['request']>[0]){requests.push(r.route);if(r.route==='conversation.read')return {turns:[{text:'원래 요청',response:result}]} as T;if(r.route==='agent.continue')throw {code};return {...result,status:'cancelled',next_job:null} as T;}};
  function Harness(){ask=useAsk(client,'',()=>{},[],'typed-error');return <AskResult ask={ask} onOpen={()=>{}} onOpenDraft={()=>{}} onAgain={()=>{}}/>;}
  try{await act(async()=>root.render(<Harness/>));await act(async()=>{await ask.continueRun!();});assert.deepEqual(requests.slice(-2),['agent.continue','agent.read']);assert.match(ask!.error,code==='NOT_FOUND'?/자료나 처리 권한/:/작업 상태나 해석 기준/);assert.doesNotMatch(win.document.body.textContent??'',/남은 확인 이어가기/);assert.equal(win.document.querySelectorAll('.button-primary').length,1);
  }finally{await act(async()=>root.unmount());win.close();}
 }
});
test('continuation keeps the original request/site and recovers a lost activation response through the same root',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://test.invalid/'}),win=dom.window;
 Object.assign(globalThis,{window:win,document:win.document,localStorage:win.localStorage,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(win.document.getElementById('root')!);let ask:Ask;
 const id='11111111-1111-4111-8111-111111111111',next='22222222-2222-4222-8222-222222222222';let activated=false;
 const requests:any[]=[];const previous={run_id:id,turn_id:id,project_id:'first',status:'needs_answer',text:'이어갈 수 있어요',cards:[],next_job:{id:next,status:'ready'}};
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:Parameters<WorkClient['request']>[0]){requests.push(r);if(r.route==='conversation.read')return {turns:[{text:'원래 요청',response:previous}]} as T;if(r.route==='agent.continue'){activated=true;throw Error('lost response');}return {...previous,run_id:activated?next:id,status:activated?'completed':'needs_answer',next_job:activated?null:previous.next_job} as T;}};
 function Harness(){const [site,setSite]=useState('second');ask=useAsk(client,site,setSite,[{id:'first',display_name:'원래 현장'}],'resume-test');return <AskResult ask={ask} onOpen={()=>{}} onOpenDraft={()=>{}} onAgain={()=>{}}/>;}
 try{await act(async()=>root.render(<Harness/>));assert.equal(win.document.querySelectorAll('.button-primary').length,1);assert.match(win.document.querySelector('.button-primary')?.textContent??'',/이어가기/);
 await act(async()=>{await ask.continueRun!();});assert.equal(requests.at(-1).route,'agent.continue');assert.equal(requests.at(-1).id,id);
 await act(async()=>{await ask.retry();});assert.deepEqual(requests.at(-1),{route:'agent.read',id});assert.equal(ask!.answer?.run_id,next);assert.equal(ask!.asked,'원래 요청');assert.equal(ask!.askedSite,'원래 현장');assert.equal(win.localStorage.getItem('resume-test:run'),next);
 }finally{await act(async()=>root.unmount());win.close();}
});
test('N10 common UI restores the same run, retains its site and cancels through the fixed route',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://test.invalid/'}),win=dom.window;
 Object.assign(globalThis,{window:win,document:win.document,localStorage:win.localStorage,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(win.document.getElementById('root')!);let ask:Ask;
 const requests:any[]=[];const id='11111111-1111-4111-8111-111111111111';
 const result={run_id:id,turn_id:id,project_id:'first',status:'running',text:'처리 중',cards:[]};
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:Parameters<WorkClient["request"]>[0]){requests.push(r);if(r.route==='conversation.read')return {turns:[{text:'기존 요청',response:result}]} as T;return {...result,status:r.route==='agent.cancel'?'cancelled':'running'} as T;}};
 function Harness(){const [site,setSite]=useState('second');ask=useAsk(client,site,setSite,[{id:'first',display_name:'원래 현장'},{id:'second',display_name:'새 현장'}],'private-test-conversation');return <div>{ask.askedSite}:{ask.answer?.status}</div>;}
 try{await act(async()=>{root.render(<Harness/>);});assert.match(win.document.body.textContent??'',/원래 현장:running/);
  await act(async()=>{await ask.cancel!();});assert.match(win.document.body.textContent??'',/cancelled/);assert.equal(requests.at(-1).route,'agent.cancel');assert.equal(requests.at(-1).id,id);
  const q={id,version:2,project_id:'first',project_name:'원래 현장',work_label:'납품',prompt:'28개 반영할까요?',blocked:null};
  await act(async()=>{await ask.reply!(q,'28개로');});assert.equal(requests.at(-1).route,'agent.start');const command=JSON.parse(requests.at(-1).command);assert.equal(command.project_id,'first');assert.deepEqual(command.answer_to,{id,version:2});assert.equal(command.instruction,'28개로');
  assert.equal(win.localStorage.getItem('private-test-conversation:run'),id);
 }finally{await act(async()=>root.unmount());win.close();}
});

test('N21 exception voice focuses the existing answer and submits once through the same registry',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://test.invalid/'}),win=dom.window;
 Object.assign(globalThis,{window:win,document:win.document,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(win.document.getElementById('root')!);
 let event:((e:VoiceEvent)=>void)|undefined;const calls:unknown[][]=[];
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(){return {} as T;},startVoice(callback){event=callback;return {id:'voice-answer',cancel(){}};}};
 const q={id:'question',version:1,project_id:'site',project_name:'현장',work_label:'납품',prompt:'인수량은?',blocked:null};
 const ask={text:'',project:'site',answer:{turn_id:'turn',status:'needs_answer',text:'확인해 주세요',cards:[],questions:[q]},busy:false,error:'',asked:'',askedSite:'',setText(){},setVoiceId(){},setProject(){},async submit(){},async retry(){},reset(){},async reply(...args:unknown[]){calls.push(args);}} satisfies Ask;
 const click=async(name:string)=>act(async()=>{const button=[...win.document.querySelectorAll('button')].find(b=>b.textContent===name);assert.ok(button);button.click();});
 try{
  await act(async()=>root.render(<AskResult ask={ask} client={client} onOpen={()=>{}} onOpenDraft={()=>{}} onAgain={()=>{}} issued={{}}/>));
  await click('말로 요청하기');await act(async()=>event?.({id:'voice-answer',phase:'final',text:'28개로'}));
  assert.equal(calls.length,0);assert.equal(win.document.activeElement?.id,'answer-question');assert.doesNotMatch(win.document.body.textContent??'',/요청했어요/);
  await click('답변 반영');assert.deepEqual(calls,[[q,'28개로','voice']]);
 }finally{await act(async()=>root.unmount());win.close();}
});

test('N21 corrected voice retry retains the original instruction, site and turn id',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://test.invalid/'}),win=dom.window;
 Object.assign(globalThis,{window:win,document:win.document,localStorage:win.localStorage,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(win.document.getElementById('root')!);let ask:Ask;
 const requests:any[]=[];let fail=true;
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:Parameters<WorkClient['request']>[0]){requests.push(r);if(fail)throw Error('lost response');return {turn_id:'saved',status:'completed',cards:[],text:'찾았어요'} as T;}};
 function Harness(){const [site,setSite]=useState('corrected-site');ask=useAsk(client,site,setSite,[{id:'corrected-site',display_name:'고친 현장'}]);return null;}
 try{
  await act(async()=>root.render(<Harness/>));
  await act(async()=>{ask.setText('28개 찾아줘');ask.setVoiceId('voice-turn');});
  await act(async()=>{await ask.submit();});
  await act(async()=>{ask.setProject('other-site');ask.setText('다른 요청');});fail=false;
  await act(async()=>{await ask.retry();});
  assert.deepEqual(requests[1],requests[0]);assert.equal(requests[0].input_kind,'voice');assert.equal(requests[0].selected_project_id,'corrected-site');assert.equal(ask!.text,'다른 요청');
 }finally{await act(async()=>root.unmount());win.close();}
});
