import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {act} from "react";
import {WorkFolders} from "../apps/web/src/work-folders.js";
import type {WorkClient,WorkContext,WorkRequest} from "../apps/web/src/work-client.js";

test("N08 one batch edit carries binding versions and generations and retries the same command",async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:"https://example.test/#/folders"}),win=dom.window;
 Object.assign(globalThis,{window:win,document:win.document,HTMLElement:win.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import("react-dom/client");const root=createRoot(win.document.getElementById("root")!);
 const bindings=[{id:"binding-1",source_id:"source-1",source_generation:2,scope_mode:"unassigned",project_id:null,version:4,display_name:"현장 자료"},
  {id:"binding-2",source_id:"source-2",source_generation:3,scope_mode:"unassigned",project_id:null,version:7,display_name:"회사 양식"}];
 const commands:string[]=[];let fail=true;
 const client:WorkClient={kind:"remote",dispose(){},async request<T>(request:WorkRequest){
  if(request.route==="capture.status")return {limit_bytes:100000000000,used_bytes:95000000000,reserved_bytes:4000000000,recovery:{checked:2,failed:1,last_checked_at:null}} as T;
  if(request.route==="folders.correct"){commands.push(request.command);if(fail){fail=false;throw new Error("offline");}}
  return {bindings} as T;
 }};
 const context:WorkContext={user_id:"user",tenant_id:"company",company:"합성 회사",can_resolve_site:true,projects:[{id:"project-1",display_name:"가람 현장"}]};
 try{
  await act(async()=>root.render(<WorkFolders client={client} context={context}/>));
  assert.match(win.document.body.textContent!,/남은 공간 1 GB/);assert.match(win.document.body.textContent!,/서버 사본 확인에 실패한 자료가 1개/);
  const selects=[...win.document.querySelectorAll<HTMLSelectElement>("select")];assert.equal(selects.length,2);
  await act(async()=>{selects[0]!.value="project-1";selects[0]!.dispatchEvent(new win.Event("change",{bubbles:true}));selects[1]!.value="company_common";selects[1]!.dispatchEvent(new win.Event("change",{bubbles:true}));});
  const button=win.document.querySelector<HTMLButtonElement>("button")!;
  assert.match(button.textContent!,/2개/);
  await act(async()=>button.click());assert.match(win.document.body.textContent!,/아직 저장을 확인하지 못/);
  await act(async()=>button.click());assert.equal(commands.length,2);assert.equal(commands[0],commands[1]);
  const command=JSON.parse(commands[0]!);
  assert.match(command.client_command_id,/^[0-9a-f-]{36}$/);
  assert.deepEqual(command.changes,[
   {id:"binding-1",expected_version:4,source_generation:2,scope_mode:"project",project_id:"project-1"},
   {id:"binding-2",expected_version:7,source_generation:3,scope_mode:"company_common",project_id:null},
  ]);
  assert.match(win.document.body.textContent!,/함께 저장/);
  await act(async()=>root.render(<WorkFolders client={client} context={{...context,can_resolve_site:false}}/>));
  assert.ok([...win.document.querySelectorAll<HTMLSelectElement>("select")].every(select=>select.disabled));
  assert.equal(win.document.querySelector("button"),null);
 }finally{await act(async()=>root.unmount());win.close();}
});

test("N08 stale binding conflicts reload current version before another batch edit",async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:"https://example.test/#/folders"}),win=dom.window;
 Object.assign(globalThis,{window:win,document:win.document,HTMLElement:win.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import("react-dom/client");const root=createRoot(win.document.getElementById("root")!);let version=1,reads=0;
 const client:WorkClient={kind:"remote",dispose(){},async request<T>(request:WorkRequest){
  if(request.route==="capture.status")return {limit_bytes:100000000000,used_bytes:95000000000,reserved_bytes:4000000000,recovery:{checked:2,failed:1,last_checked_at:null}} as T;
  if(request.route==="folders.correct"){version=2;throw Object.assign(new Error("conflict"),{code:"VERSION_CONFLICT"});}
  reads++;return {bindings:[{id:"b",source_id:"s",source_generation:2,scope_mode:"unassigned",project_id:null,version}]} as T;
 }};
 try{
  await act(async()=>root.render(<WorkFolders client={client} context={{user_id:"u",tenant_id:"t",company:"합성 회사"}}/>));
  const select=win.document.querySelector<HTMLSelectElement>("select")!;
  await act(async()=>{select.value="company_common";select.dispatchEvent(new win.Event("change",{bubbles:true}));});
  await act(async()=>win.document.querySelector<HTMLButtonElement>("button")!.click());
  assert.equal(reads,2);assert.equal(select.value,"unassigned");
  assert.match(win.document.body.textContent!,/다른 기기에서 폴더 연결이 바뀌었/);
  assert.equal(win.document.querySelector<HTMLButtonElement>("button")!.disabled,true);
 }finally{await act(async()=>root.unmount());win.close();}
});
