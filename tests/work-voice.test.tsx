import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {act,useState} from "react";
import {WorkVoice} from "../apps/web/src/work-voice.js";
import type {WorkClient,VoiceEvent,WorkRequest} from "../apps/web/src/work-client.js";
test("N21 partial speech, correction before execution, duplicate final, permission denial and delayed consent",async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://localhost',pretendToBeVisual:true}),win=dom.window;
 Object.assign(globalThis,{window:win,document:win.document,HTMLElement:win.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(win.document.getElementById('root')!);
 let correct:(v:string)=>void=()=>{},setBusy:(v:boolean)=>void=()=>{};
 let event:((e:VoiceEvent)=>void)|undefined,text='',count=0,cancelled=0,consentResolve:(()=>void)|undefined;
 const id=crypto.randomUUID();const client:WorkClient={kind:'fixture',dispose(){},startVoice(callback){event=callback;return{id,cancel(){cancelled++;}};},async request<T>(input:WorkRequest){if(input.route==='voice.status')return {enabled:true,consented:false,provider:'합성',consent_version:'short-voice-v1'} as T;if(input.route==='voice.consent')await new Promise<void>(r=>{consentResolve=r;});return {} as T;}};
 const click=async(label:string)=>act(async()=>{const button=[...win.document.querySelectorAll('button')].find(b=>b.textContent===label);assert.ok(button);button.click();});
 function Harness(){const [draft,setDraft]=useState(''),[busy,changeBusy]=useState(false);correct=setDraft;setBusy=changeBusy;return <form onSubmit={e=>{e.preventDefault();text=draft;count++;changeBusy(true);}}><input id="voice-draft" value={draft} onChange={e=>setDraft(e.target.value)}/><WorkVoice client={client} disabled={busy} inputId="voice-draft" onText={v=>{text=v;setDraft(v);}} onRecognized={()=>{}}/><button type="submit">요청하기</button></form>;}
 try{
  await act(async()=>root.render(<Harness/>));
  await click('말로 요청하기');await act(async()=>event?.({id,phase:'partial',text:'12개'}));assert.equal(text,'');assert.match(win.document.body.textContent??'',/12개/);
  await act(async()=>{event?.({id,phase:'final',text:'20개 찾아줘'});event?.({id,phase:'final',text:'20개 찾아줘'});});assert.equal(count,0);assert.equal(text,'20개 찾아줘');
  await act(async()=>correct('햇살현장 28개 찾아줘'));assert.equal(win.document.activeElement?.id,'voice-draft');await click('요청하기');assert.equal(count,1);assert.equal(text,'햇살현장 28개 찾아줘');assert.doesNotMatch(win.document.body.textContent??'',/취소했어요/);await act(async()=>setBusy(false));
  await click('말로 요청하기');await click('음성 취소');await act(async()=>event?.({id,phase:'final',text:'늦은 요청'}));assert.equal(count,1);assert.equal(cancelled,1);
  await click('말로 요청하기');await act(async()=>event?.({id,phase:'error',code:'permission_denied'}));assert.match(win.document.body.textContent??'',/마이크 권한/);assert.equal(count,1);
  await click('말로 요청하기');await act(async()=>event?.({id,phase:'error',code:'voice_unavailable'}));await click('동의하고 말하기');await click('음성 취소');await act(async()=>consentResolve?.());assert.match(win.document.body.textContent??'',/취소했어요/);assert.equal(count,1);
 }finally{await act(async()=>root.unmount());dom.window.close();}
});
