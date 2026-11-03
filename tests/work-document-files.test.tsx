import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act} from 'react';
import {DocumentFiles} from '../apps/web/src/work-document-files.js';
import type {WorkClient,WorkRequest} from '../apps/web/src/work-client.js';
test('D17 native share is unknown, retry is same intent, explicit sent does not issue',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://localhost'}),win=dom.window;
 Object.assign(globalThis,{window:win,document:win.document,HTMLElement:win.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client'),root=createRoot(win.document.getElementById('root')!);
 const requests:WorkRequest[]=[],id=crypto.randomUUID(),intent=crypto.randomUUID();let attempt=0;
 const client:WorkClient={kind:'native',dispose(){},async request<T>(r:WorkRequest){requests.push(r);if(r.route==='documents.share')return {id:intent} as T;if(r.route==='documents.file'){if(attempt++===0)throw new Error('offline');return {outcome:'unknown'} as T;}if(r.route==='documents.shareOutcome')return {recorded:true} as T;throw new Error('unexpected');}};
 async function click(text:string){await act(async()=>{[...win.document.querySelectorAll('button')].find(b=>b.textContent===text)!.click();await new Promise(r=>setTimeout(r,10));});}
 try{
  await act(async()=>root.render(<DocumentFiles client={client} id={id} onRefresh={()=>{}}/>));
  await click('PDF 공유');await click('PDF 공유');
  const intents=requests.filter(r=>r.route==='documents.share');assert.deepEqual(intents[0],intents[1]);assert.equal(requests.find(r=>r.route==='documents.shareOutcome')?.outcome,'unknown');assert.ok(!requests.some(r=>r.route==='documents.issue'));
  await act(async()=>root.render(<DocumentFiles client={client} id={id} shares={[{id:intent,format:'pdf',state:'unknown',own:true}]} onRefresh={()=>{}}/>));
  await click('이 문서를 보냈어요');assert.equal(requests.at(-1)?.route,'documents.shareOutcome');assert.match(win.document.body.textContent??'',/상대 수신·입금 확인과는 구분/);
 }finally{await act(async()=>root.unmount());win.close();}
});
