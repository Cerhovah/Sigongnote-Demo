import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { WorkApp } from "../apps/web/src/work-app.js";
import { WorkFailure, type WorkClient, type WorkRequest } from "../apps/web/src/work-client.js";
test("work UI serializes slow refresh, preserves offline data and clears revoked account",async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:"http://localhost/#/materials/list",pretendToBeVisual:true});const win=dom.window;
 Object.assign(globalThis,{window:win,document:win.document,location:win.location,HTMLElement:win.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import("react-dom/client");const container=win.document.getElementById("root");assert.ok(container);const root=createRoot(container);
 let release:(()=>void)|undefined,slow=false,failure="",active=0,max=0,calls=0;
 const client:WorkClient={kind:"fixture",dispose(){},async request<T>(input:WorkRequest){if(input.route==="documents.list")return {documents:[]} as T;if(input.route==="sync.changes")return {changes:[],next_cursor:"0",has_more:false} as T;if(input.route==="questions.list")return {questions:[],can_answer:true,coverage:"합성"} as T;active++;max=Math.max(max,active);calls++;try{
  if(slow)await new Promise<void>(resolve=>{release=resolve;});
  if(failure)throw new WorkFailure(failure);
  if(input.route==="guide.read")return {step:0,completed:true} as T;
  return (input.route==="context"?{user_id:"one",tenant_id:"one",company:"합성회사"}:{materials:[{id:"one",title:"보존할 납품자료",status:"complete",created_at:new Date().toISOString(),sha256:"a".repeat(64)}],next_cursor:null}) as T;
 }finally{active--;}}};
 const settle=()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});
 const refresh=async()=>{await act(async()=>{win.dispatchEvent(new win.Event("focus"));});await settle();};
 try{
  await act(async()=>{root.render(<WorkApp client={client}/>);});await settle();assert.match((win.document.body.textContent??""),/보존할 납품자료/);
  slow=true;await refresh();const before=calls;await refresh();await refresh();assert.equal(calls,before);assert.equal(max,1);
  failure="connection_wait";slow=false;await act(async()=>{assert.ok(release);release();});await settle();assert.match((win.document.body.textContent??""),/보존할 납품자료/);assert.match((win.document.body.textContent??""),/최신 자료를 아직/);
  failure="login_required";await refresh();assert.doesNotMatch((win.document.body.textContent??""),/보존할 납품자료/);assert.match((win.document.body.textContent??""),/로그인이 필요/);
 }finally{await act(async()=>{root.unmount();});dom.window.close();}
});
