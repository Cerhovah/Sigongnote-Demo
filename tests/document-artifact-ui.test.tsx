import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act} from 'react';
import {AskResult,type Ask} from '../apps/web/src/work-ask.js';
import {WorkDraft} from '../apps/web/src/work-draft.js';
import {IssuedDocument} from '../apps/web/src/work-documents.js';
import type {WorkClient,WorkRequest} from '../apps/web/src/work-client.js';
test('N17 artifact card opens the exact issued document; partial-order editing submits the typed quantity contract',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),win=dom.window;Object.assign(globalThis,{window:win,document:win.document,location:win.location,HTMLElement:win.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client'),root=createRoot(win.document.getElementById('root')!);let opened='',saved:any;
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:WorkRequest){if(r.route==='documents.complete'){saved=r;return {id:'next'} as T;}return {id:'draft',stale:false,source_candidate:true,missing:[],source_refs:[],order_quantities:[{id:'item',description:'창틀',unit:'개',available:'10'}],document:{type:'purchase_order',project:{id:'site',name:'합성현장'},issuer:{name:'합성 업체'},recipient:{name:'합성 공급처'},date:'2030-01-01',lines:[{id:'item',description:'창틀',spec:'표준',unit:'개',quantity:'4',unit_price:'100',supply:'400',tax:'40'}],totals:{supply:'400',tax:'40',total:'440'}}} as T;}};
 try{
  const ask={answer:{text:'파일을 찾았어요',cards:[],artifacts:[{id:'issued',revision_id:'revision',label:'견적서',number:'Q-0000001',state:'approved',render_state:'succeeded',files:[{format:'pdf',sha256:'a'.repeat(64),byte_length:100}]}]},busy:false,asked:'최근 견적서 PDF 보여줘',askedSite:'합성현장'} as unknown as Ask;
  await act(async()=>root.render(<AskResult ask={ask} onOpen={()=>{}} onOpenDraft={()=>{}} onOpenIssued={id=>{opened=id;}} onAgain={()=>{}}/>));
  const button=[...win.document.querySelectorAll('button')].find(b=>b.textContent==='발행 문서와 파일 보기')!;assert.ok(button);await act(async()=>button.click());assert.equal(opened,'issued');
  ask.answer!.artifacts![0]!.files=[];ask.answer!.artifacts![0]!.render_state='dead';
  await act(async()=>root.render(<AskResult ask={ask} onOpen={()=>{}} onOpenDraft={()=>{}} onAgain={()=>{}}/>));assert.match(win.document.body.textContent??'',/출력을 마치지 못했어요/);assert.doesNotMatch(win.document.body.textContent??'',/출력 파일을 준비하고/);
  const failedClient:WorkClient={...client,async request<T>(){return {id:'issued',state:'approved',render_state:'dead',render_error:'INVALID_PUBLIC_DOCUMENT',files:[],document:{type:'estimate',document_number:'Q-0000001',recipient:{name:'합성 고객'},project:{name:'합성현장'},totals:{supply:'100',tax:'10',total:'110'},lines:[]}} as T;}};
  await act(async()=>root.render(<IssuedDocument client={failedClient} id="issued"/>));assert.match(win.document.body.textContent??'',/문서 형식 확인이 필요/);assert.ok(![...win.document.querySelectorAll('button')].some(b=>b.textContent?.includes('출력 다시 시도')));
  await act(async()=>root.render(<WorkDraft client={client} id="draft" onOpen={()=>{}}/>));assert.match(win.document.body.textContent??'',/일부만 발주/);
  await act(async()=>{win.document.querySelector('form')!.dispatchEvent(new win.Event('submit',{bubbles:true,cancelable:true}));});assert.equal(saved.route,'documents.complete');assert.deepEqual(JSON.parse(saved.quantities),[{id:'item',quantity:'4'}]);
 }finally{await act(async()=>root.unmount());win.close();}
});
