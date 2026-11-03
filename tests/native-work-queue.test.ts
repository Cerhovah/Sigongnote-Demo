import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {nativeWorkClient,type WorkRequest} from '../apps/web/src/work-client.js';

type Command={bridgeVersion:number;requestId:string;method:string;payload:WorkRequest};
function bridge(){
 const dom=new JSDOM('',{url:'https://appassets.androidplatform.net'}),sent:Command[]=[];
 const native:{postMessage:(wire:string)=>void;onmessage?:((event:MessageEvent)=>void)|null}={postMessage:wire=>sent.push(JSON.parse(wire))};
 Object.assign(globalThis,{window:dom.window});Object.assign(dom.window,{SigongnoteNative:native});
 const reply=(command:Command,ok=true,result='{}')=>native.onmessage?.({data:JSON.stringify({...command,ok,result})} as MessageEvent);
 return {dom,native,sent,reply};
}

test('Android Today read burst stays below the real four-slot admission limit and sends each read once',async()=>{
 const fixture=bridge();let active=0,maximum=0,rejected=0;
 fixture.native.postMessage=wire=>{const command=JSON.parse(wire) as Command;fixture.sent.push(command);const accepted=active<4;if(accepted){active++;maximum=Math.max(maximum,active);}else rejected++;
  setTimeout(()=>{if(accepted)active--;fixture.reply(command,accepted,accepted?'{}':'work_busy');},accepted?10:0);
 };
 const client=nativeWorkClient(),requests:WorkRequest[]=[{route:'questions.list'},{route:'journal.tasks'},{route:'agenda.read'},{route:'journal.list'},{route:'documents.list'},{route:'sync.changes',sync_version:2}];
 try{const results=await Promise.allSettled(requests.map(r=>client.request(r)));assert.equal(results.filter(r=>r.status==='fulfilled').length,6);assert.equal(rejected,0);assert.equal(maximum,2);assert.deepEqual(fixture.sent.map(c=>c.payload.route),requests.map(r=>r.route));assert.equal(new Set(fixture.sent.map(c=>c.requestId)).size,6);}finally{client.dispose();fixture.dom.window.close();}
});

test('Android pending work is bounded and closing the client never submits its waiting commands',async()=>{
 const fixture=bridge(),client=nativeWorkClient();
 try{const results=Promise.allSettled(Array.from({length:40},()=>client.request({route:'journal.command',command:'{}'})));assert.equal(fixture.sent.length,2);client.dispose();const settled=await results;assert.equal(settled.filter(r=>r.status==='rejected'&&(r.reason as {code?:string}).code==='work_busy').length,8);assert.equal(settled.filter(r=>r.status==='fulfilled').length,0);assert.equal(fixture.sent.length,2);await assert.rejects(client.request({route:'journal.tasks'}),{code:'account_changed'});assert.equal(fixture.sent.length,2);}finally{client.dispose();fixture.dom.window.close();}
});

test('an expired submitted command is never replayed and independent reads remain possible after missing responses',async t=>{
 const fixture=bridge(),client=nativeWorkClient();t.mock.timers.enable({apis:['setTimeout','Date'],now:0});
 try{const results=Promise.allSettled([client.request({route:'journal.command',command:'{}'}),client.request({route:'agenda.read'}),client.request({route:'journal.tasks'})]);assert.equal(fixture.sent.length,2);t.mock.timers.tick(45000);const settled=await results;assert.equal(settled.every(r=>r.status==='rejected'&&(r.reason as {code?:string}).code==='connection_wait'),true);assert.equal(fixture.sent.length,2,'an expired waiting read must never be submitted');const next=client.request({route:'journal.tasks'});assert.equal(fixture.sent.length,3,'missing replies cannot permanently lock the client');fixture.reply(fixture.sent[2]!);await next;fixture.reply(fixture.sent[0]!);assert.equal(fixture.sent.length,3);assert.equal(fixture.sent.filter(c=>c.payload.route==='journal.command').length,1);}finally{client.dispose();fixture.dom.window.close();}
});
