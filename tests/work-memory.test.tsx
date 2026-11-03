import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act} from 'react';
import {RememberAnswer} from '../apps/web/src/work-memory.js';
import type {WorkClient,WorkRequest} from '../apps/web/src/work-client.js';
import {replyEffects} from '../services/api/src/work-replies.js';
test('D13 explicit scope grant retries exact command after a lost response',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://localhost',pretendToBeVisual:true}),win=dom.window;Object.assign(globalThis,{window:win,document:win.document,HTMLElement:win.HTMLElement,Event:win.Event,IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client'),root=createRoot(win.document.getElementById('root')!);const commands:string[]=[];
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:WorkRequest){assert.equal(r.route,'policies.command');if(r.route!=='policies.command')throw new Error();commands.push(r.command);if(commands.length===1)throw new Error('response lost');return {automatic:true} as T;}};
 try{await act(async()=>root.render(<RememberAnswer client={client} decision={crypto.randomUUID()}/>));assert.equal(commands.length,0);await act(async()=>{win.document.querySelector<HTMLInputElement>('input[type=radio][value=project]')!.click();});const submit=()=>act(async()=>{win.document.querySelector('form')!.dispatchEvent(new win.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,10));});await submit();assert.match(win.document.body.textContent??'',/같은 버튼/);await submit();assert.equal(commands[0],commands[1]);assert.equal(JSON.parse(commands[0]!).scope,'project');assert.equal(JSON.parse(commands[0]!).max_amount_minor,'0');assert.match(win.document.body.textContent??'',/저장했어요/);}finally{await act(async()=>root.unmount());win.close();}
});
test('D13 voice transcription and text share closed reply semantics; no money or payment from prose',()=>{
 const effect={kind:'acceptance' as const,quantity:'8',ordered:'10',unit:'개'};
 assert.deepEqual(replyEffects('9개로',[effect])?.effects,[{...effect,quantity:'9'}]);assert.equal(replyEffects('9kg로',[effect]),null);assert.equal(replyEffects('100만원 보내줘',[effect]),null);assert.equal(replyEffects('그대로 하지 마',[effect]),null);assert.equal(replyEffects('2030-02-30로',[{kind:'schedule',date:'2030-01-01'}]),null);
});
