import assert from 'node:assert/strict';
import {test} from 'node:test';
import {act} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {JSDOM} from 'jsdom';
import {AskResult,useAsk,type Ask,type AskAnswer} from '../apps/web/src/work-ask.js';
import type {WorkClient} from '../apps/web/src/work-client.js';

const answer:AskAnswer={turn_id:'turn',status:'completed',text:'저장한 답변',cards:[]};
const question={id:'question',version:1,project_id:'project',project_name:'시험 현장',work_label:'수량',prompt:'수량을 확인해 주세요',blocked:null};
const artifact={id:'document',revision_id:'revision',label:'견적서',number:'Q1',state:'approved',render_state:'ready',files:[]};
const stub=(value:AskAnswer,error=''):Ask=>({text:'',project:'',answer:value,busy:false,error,asked:'내 요청',askedSite:'시험 현장',setVoiceId(){},setText(){},setProject(){},async submit(){},async retry(){},reset(){}});
test('result combinations keep one primary action and one question, including unavailable results',()=>{
 const cases:Partial<AskAnswer>[]=[{questions:[question]},{questions:[question,{...question,id:'second'}]},
  {artifacts:[artifact,{...artifact,id:'second'}]},
  {effects:[{decision_id:'decision'}],questions:[question],artifacts:[artifact]},
  {document_draft:{id:'draft'},questions:[question],artifacts:[artifact]},
  {deliveries:[{id:'d',source_id:'s',source_kind:'invoice',title:'전달'}],delivery_choices:true,photo_sheets:[{id:'s',title:'사진대지',state:'ready'}],photo_choices:true,artifacts:[artifact],questions:[question]}];
 for(const fields of cases)for(const error of ['', '결과 조회 실패']){
  const client:WorkClient={kind:'fixture',dispose(){},async request<T>(){return {} as T;}};
  const dom=new JSDOM(renderToStaticMarkup(<AskResult client={client} ask={stub({...answer,...fields},error)} onOpen={()=>{}} onOpenDraft={()=>{}} onOpenIssued={()=>{}} onAgain={()=>{}}/>));
  assert.equal(dom.window.document.querySelectorAll('.button-primary').length,1,JSON.stringify({fields,error}));
  assert.ok(dom.window.document.querySelectorAll('textarea[id^=answer-]').length<=1);
  assert.equal(dom.window.document.querySelector('textarea[id^=answer-]')?.closest('form')?.querySelectorAll('button[type=submit]').length??0,fields.questions?1:0);
  dom.window.close();
 }
});

test('failed saved-run read restores prior answer, keeps failure visible and retries the saved run',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(document.getElementById('root')!);
 const key='restore-test',run='00000000-0000-4000-8000-000000000002',oldRun='00000000-0000-4000-8000-000000000003';
 localStorage.setItem(key,'00000000-0000-4000-8000-000000000001');localStorage.setItem(key+':run',run);localStorage.setItem(key+':request',JSON.stringify({run_id:run,text:'아직 처리 중인 요청'}));
 let fail=true;const calls:string[]=[];
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:Parameters<WorkClient["request"]>[0]){
  if(r.route==='conversation.read')return {turns:[{text:'이전 요청문',response:{...answer,run_id:oldRun}}]} as T;
  if(r.route==='agent.read'){calls.push(r.id);if(fail)throw Error('TRANSIENT');return {...answer,run_id:run,text:'최신 결과'} as T;}
  throw Error('UNEXPECTED_WRITE');
 }};
 let captured:Ask;
 function Probe(){captured=useAsk(client,'',()=>{},[],key);return <AskResult ask={captured} onOpen={()=>{}} onOpenDraft={()=>{}} onAgain={()=>{}}/>;}
 try{
  await act(async()=>{root.render(<Probe/>);await new Promise(r=>setTimeout(r,30));});
  assert.equal(captured!.answer?.text,answer.text);assert.equal(captured!.asked,'이전 요청문');assert.match(captured!.error,/이전 대화/);
  assert.equal(localStorage.getItem(key+':run'),run);assert.deepEqual(calls,[run]);
  fail=false;await act(async()=>captured!.retry());
  assert.equal(captured!.answer?.text,'최신 결과');assert.equal(captured!.asked,'아직 처리 중인 요청');assert.equal(captured!.error,'');assert.deepEqual(calls,[run,run]);
 }finally{await act(async()=>root.unmount());dom.window.close();}
});

test('saved request text survives successful restoration even when conversation history is unavailable',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(document.getElementById('root')!);
 const run='00000000-0000-4000-8000-000000000002';localStorage.setItem('restore2:run',run);localStorage.setItem('restore2:request',JSON.stringify({run_id:run,text:'현장 자재 찾아줘'}));
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:Parameters<WorkClient["request"]>[0]){if(r.route==='conversation.read')throw Error('TRANSIENT');if(r.route==='agent.read')return {...answer,run_id:run} as T;throw Error('UNEXPECTED');}};
 let captured:Ask;function Probe(){captured=useAsk(client,'',()=>{},[],'restore2');return null;}
 try{await act(async()=>{root.render(<Probe/>);await new Promise(r=>setTimeout(r,30));});assert.equal(captured!.asked,'현장 자재 찾아줘');assert.equal(captured!.answer?.text,answer.text);assert.equal(captured!.error,'');}
 finally{await act(async()=>root.unmount());dom.window.close();}
});
