import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act} from 'react';
import {WorkAudio} from '../apps/web/src/work-audio.js';
import type {WorkClient,WorkRequest} from '../apps/web/src/work-client.js';
test('N22 transcript pages are bounded, correction keeps original, stale cursor refreshes and revocation hides text',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://localhost',pretendToBeVisual:true}),win=dom.window;
 Object.assign(globalThis,{window:win,document:win.document,HTMLElement:win.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client'),root=createRoot(win.document.getElementById('root')!);
 const id=crypto.randomUUID(),job=crypto.randomUUID(),correction=crypto.randomUUID();let stale=false,blocked=false,saved:any=null,played=0,failSave=true,legacy=false;
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:WorkRequest){
  if(r.route==='audio.correct'){saved=JSON.parse(r.command);if(failSave){failSave=false;throw Error('network');}return {saved:true} as T;}
  assert.equal(r.route,'evidence.chunks');if(r.route!=='evidence.chunks')throw Error();
  if(blocked)throw Object.assign(Error(),{code:'FORBIDDEN'});if(stale&&r.cursor)throw Object.assign(Error(),{code:'VERSION_CONFLICT'});
  const ordinal=r.cursor?1000:0;
  return {revision_id:id,index_job_id:job,source_hash:'a'.repeat(64),parser_version:'timed-stt-v2',source_status:'complete',coverage:{},complete_extracted_text:!legacy,indexed_chunks:1001,index_status:legacy?'legacy_excerpt_only':'complete',next_cursor:r.cursor?null:'next',chunks:[{ordinal,text:'20개',locator:`audio:${ordinal}-${ordinal+500}:0`,position:{original_text:'28개',correction_id:correction,speaker:'1구간 A'}}]} as T;
 }};
 const click=async(label:string)=>act(async()=>{const b=[...win.document.querySelectorAll('button')].find(x=>x.textContent===label);assert.ok(b);b.click();});
 try{
  await act(async()=>root.render(<WorkAudio client={client} id={id} progress={{phase:'complete',chunks:1,completed:1,truncated:true}} spans={[]} corrections={[{command_id:correction,locator:'audio:1000-1500:0',text:'20개'}]} canCorrect onSaved={()=>{}} onOriginal={s=>{played=s??0;}}/>));
  assert.match(win.document.body.textContent??'',/전체 1,001개/);assert.equal(win.document.querySelectorAll('article').length,1);
  await click('다음 전사 보기');assert.match(win.document.body.textContent??'',/1001–1001/);assert.match(win.document.body.textContent??'',/28개.*고친 내용.*20개/);
  await click('원음 0:01–0:01 확인');assert.equal(played,1);await click('잘못 들은 내용 고치기');await click('고친 내용 저장');assert.equal(win.document.querySelector('textarea')?.value,'20개');const pending=saved.client_command_id;await click('고친 내용 저장');assert.equal(saved.client_command_id,pending);assert.equal(saved.expected_id,correction);assert.equal(saved.text,'20개');
  await click('처음부터 다시 확인');stale=true;await click('다음 전사 보기');assert.match(win.document.body.textContent??'',/1–1번째/);
  legacy=true;await click('처음부터 다시 확인');assert.equal([...win.document.querySelectorAll('button')].some(b=>b.textContent==='잘못 들은 내용 고치기'),false);
  blocked=true;await click('처음부터 다시 확인');assert.equal(win.document.querySelectorAll('article').length,0);assert.match(win.document.body.textContent??'',/연결이 해제/);
 }finally{await act(async()=>root.unmount());dom.window.close();}
});
