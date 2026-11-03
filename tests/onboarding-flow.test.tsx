import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act} from 'react';
import {randomUUID} from 'node:crypto';
import {WorkSetup} from '../apps/web/src/work-setup.js';
import {InstallSteps} from '../apps/web/src/setup-install.js';
import {nativeWorkClient,type WorkClient,type WorkRequest} from '../apps/web/src/work-client.js';
import {needsDeviceSetup,writeSetupProgress,setupProgressKey} from '../apps/web/src/setup-progress.js';

async function screen(){
 const dom=new JSDOM('<div id="root"></div>',{pretendToBeVisual:true,url:'https://fixture.test'}),win=dom.window;win.scrollTo=()=>{};
 Object.assign(globalThis,{window:win,document:win.document,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(win.document.getElementById('root')!);
 return {win,root,text:()=>win.document.body.textContent??'',async click(label:string){const b=[...win.document.querySelectorAll('button')].find(b=>b.textContent===label);assert.ok(b,`Missing ${label}`);await act(async()=>b.click());},async close(){await act(async()=>root.unmount());win.close();}};
}
function data(){
 const project=randomUUID(),setup={project_id:project,version:1,dismissed:false,completed:false};
 const context={user_id:randomUUID(),tenant_id:randomUUID(),company:'합성 회사',projects:[{id:project,display_name:'합성 현장'}],setup};
 const calls:string[]=[];
 const client:WorkClient={kind:'remote',dispose(){},async request<T>(r:WorkRequest){calls.push(r.route);throw Error('Unexpected '+r.route);}};
 return {client,context,calls};
}

test('connections are optional: files open directly without setup, verification or completion calls',async()=>{
 const s=await screen(),d=data();let added=false,back=false;
 try{
  await act(async()=>s.root.render(<WorkSetup client={d.client} context={d.context} onExit={()=>{}} onAdd={()=>{added=true;}} onBack={()=>{back=true;}}/>));
  assert.equal(s.win.document.querySelector('h1')?.textContent,'자료 연결');
  assert.doesNotMatch(s.text(),/첫 자료|다른 기기|사용법|현장 이름|보관 확인|1 \/ 5/);
  await s.click('파일 추가');assert.equal(added,true);assert.deepEqual(d.calls,[]);
  await s.click('뒤로');assert.equal(back,true);
 }finally{await s.close();}
});

test('unfinished legacy progress and native installation never require onboarding',async()=>{
 const s=await screen(),d=data();
 try{
  for(const kind of ['remote','native'] as const){
   const client={...d.client,kind};
   writeSetupProgress(setupProgressKey(d.context,client),{step:'devices',project:d.context.setup.project_id});
   assert.equal(needsDeviceSetup(d.context,client),false);
  }
 }finally{await s.close();}
});

test('Android capture is direct and optional connection cancellation leaves work usable',async()=>{
 const s=await screen(),d=data();let captures=0,exited=false;
 const client:WorkClient={...d.client,kind:'native',capturePhoto(){captures++;},nativeSetup:{async status(){return {smsOriginal:'unsupported_standard',folderReadable:0,folderCloudReady:0};},async connect(){throw Object.assign(Error('cancel'),{code:'folder_not_selected'});}}};
 (s.win as unknown as Window).SigongnoteNative={postMessage(){}};
 try{
  await act(async()=>s.root.render(<WorkSetup client={client} context={d.context} onExit={()=>{exited=true;}}/>));
  assert.equal(s.win.document.querySelector('details')?.open,false);
  assert.ok(![...s.win.document.querySelectorAll('button')].some(b=>b.textContent==='업무 문자'));
  await s.click('사진 찍기');assert.equal(captures,1);
  await s.click('사진 폴더');assert.match(s.text(),/취소했어요/);assert.deepEqual(d.calls,[]);
  await s.click('뒤로');assert.equal(exited,true);
 }finally{await s.close();}
});

test('native setup routes matched replies and surfaces standard-SMS errors without breaking work requests',async()=>{
 const s=await screen();const sent:Record<string,unknown>[]=[];const win=s.win as unknown as Window;
 win.SigongnoteNative={postMessage(raw){sent.push(JSON.parse(raw));}};const client=nativeWorkClient();
 const reply=(request:Record<string,unknown>,ok:boolean,result:unknown,method=request.method)=>win.SigongnoteNative?.onmessage?.({data:JSON.stringify({...request,method,ok,result})} as MessageEvent);
 try{
  const status=client.nativeSetup!.status();reply(sent[0]!,true,JSON.stringify({smsOriginal:'unsupported_standard'}),'workRequest');reply(sent[0]!,true,JSON.stringify({smsOriginal:'unsupported_standard'}));assert.equal((await status).smsOriginal,'unsupported_standard');
  const connection=client.nativeSetup!.connect('sms');reply(sent[1]!,false,'sms_unavailable_in_standard');await assert.rejects(connection,(e:{code?:string})=>e.code==='sms_unavailable_in_standard');
  const work=client.request<{company:string}>({route:'context'});reply(sent[2]!,true,JSON.stringify({company:'same'}));assert.equal((await work).company,'same');
 }finally{client.dispose();await s.close();}
});


test('installation offers the selected download immediately and web opens work without another wizard',async()=>{
 const s=await screen();let returned=false;
 try{
  await act(async()=>s.root.render(<InstallSteps initial="windows" onReturn={()=>{returned=true;}}/>));
  const download=()=>s.win.document.querySelector<HTMLAnchorElement>('a.button-primary');
  assert.equal(download()?.href,'https://sigongnote-api.onrender.com/download/windows');
  assert.equal(s.win.document.querySelector('details')?.open,false);
  assert.doesNotMatch(s.text(),/1 \/ 3|받았어요|열었어요|연결 확인|이전 설치 단계/);
  const select=s.win.document.querySelector('select')!;
  await act(async()=>{select.value='web';select.dispatchEvent(new s.win.Event('change',{bubbles:true}));});
  assert.equal(download()?.href,'https://sigongnote-api.onrender.com/');assert.equal(s.win.document.querySelector('details'),null);
  await act(async()=>{select.value='android';select.dispatchEvent(new s.win.Event('change',{bubbles:true}));});
  assert.equal(download()?.href,'https://sigongnote-api.onrender.com/download/android');
  await s.click('업무로 돌아가기');assert.equal(returned,true);
  assert.ok([...s.win.document.querySelectorAll('a')].every(a=>!a.href.includes('tenant')&&!a.href.includes('token')));
 }finally{await s.close();}
});
