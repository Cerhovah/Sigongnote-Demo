import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act} from 'react';
import {WorkPhotos} from '../apps/web/src/work-photos.js';
import type {WorkClient,WorkRequest} from '../apps/web/src/work-client.js';
test('N18 native capture entry and photo selections preserve order, unknown dates and a retry key',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),w=dom.window;Object.assign(globalThis,{window:w,document:w.document,location:w.location,HTMLElement:w.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client'),root=createRoot(w.document.getElementById('root')!);let camera=0,opened='',saved:any;
 const client:WorkClient={kind:'native',dispose(){},capturePhoto(){camera++;},async request<T>(r:WorkRequest){if(r.route==='photos.list')return {photos:[{id:'a',project_id:'site',created_at:'2030-01-01'},{id:'b',project_id:null,created_at:'2030-01-02'}],groups:[],next_cursor:null} as T;if(r.route==='photos.preview')return {base64:'AA==',exif_date_hint:null} as T;if(r.route==='photos.command'){saved=JSON.parse(r.command);return {id:'group'} as T;}throw Error('unexpected');}};
 try{await act(async()=>root.render(<WorkPhotos client={client} context={{tenant_id:'tenant',user_id:'owner',company:'합성',projects:[{id:'site',display_name:'합성현장'}]}} project="site" setProject={()=>{}} onOpen={id=>{opened=id;}}/>));
  await act(async()=>{[...w.document.querySelectorAll('button')].find(b=>b.textContent?.includes('사진 찍기'))!.click();});assert.equal(camera,1);
  const boxes=w.document.querySelectorAll<HTMLInputElement>('input[type=checkbox]');await act(async()=>{boxes[1]!.click();});await act(async()=>{boxes[0]!.click();});
  await act(async()=>root.render(<WorkPhotos client={client} context={{tenant_id:'tenant',user_id:'owner',company:'합성',projects:[{id:'site',display_name:'합성현장'}]}} project="site" setProject={()=>{}} onOpen={id=>{opened=id;}}/>));
  await act(async()=>w.dispatchEvent(new w.Event('focus')));
  assert.equal(w.document.querySelectorAll('input[type=checkbox]:checked').length,2,'context polling and focus must preserve selected photos');
  await act(async()=>{[...w.document.querySelectorAll('button')].find(b=>b.textContent==='사진 순서·설명 저장')!.click();});assert.deepEqual(saved.photos.map((p:any)=>p.revision_id),['b','a']);assert.ok(saved.photos.every((p:any)=>p.taken_date===null&&p.caption===''));assert.equal(opened,'group');assert.ok(saved.client_command_id);assert.match(w.document.body.textContent!,/사진 순서와 설명을 저장했어요/);
 }finally{await act(async()=>root.unmount());w.close();}
});
