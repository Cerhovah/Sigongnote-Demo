import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalAgent, inside, sha256 } from '../services/local-agent/src/agent.js';
import { CopyProtection } from '../services/local-agent/src/protection.js';
import { LocalAi } from '../services/local-agent/src/ai.js';
import { createLocalServer } from '../services/local-agent/src/server.js';

test('local journal: old metadata only, new document classified and filed without network, durable after restart',async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'sigongnote-local-journal-'));const root=path.join(temp,'Documents');const data=path.join(temp,'private');await mkdir(root);await mkdir(data);
  let reads=0;
  const parse=async(file:string)=>{reads++;const bytes=await readFile(file);return {status:'complete' as const,sourceHash:sha256(bytes),spans:[{text:bytes.toString('utf8'),locator:'line:1'}],issues:[]};};
  let agent=new LocalAgent(data,parse,new CopyProtection(Buffer.alloc(32,1)));
  try{
    await writeFile(path.join(root,'기존 견적.txt'),'과거 파일을 자동으로 읽으면 안 됨');
    await mkdir(path.join(root,'동우현장'));
    await agent.grant(root,'automatic_discovery');await agent.start();
    assert.equal(reads,0);assert.equal(agent.journal.status().baseline_count,1);
    assert.equal((await agent.journal.work({route:'journal.list'},'http://127.0.0.1:5174') as {items:unknown[]}).items.length,0);
    await writeFile(path.join(root,'동우현장','청구.txt'),'동우현장 자재 청구금액을 확인해 주세요.');
    await agent.start();assert.equal(reads,1);
    const journal=await agent.journal.work({route:'journal.list'},'http://127.0.0.1:5174') as {items:{id:string;project_name:string;categories:string[];received_at:string}[]};
    assert.equal(journal.items.length,1);assert.equal(journal.items[0]?.project_name,'동우현장');assert.deepEqual(journal.items[0]?.categories,['billing_payment']);
    const id=journal.items[0]!.id;const received=journal.items[0]!.received_at;
    const html=await readFile(path.join(agent.journal.outputRoot,'동우현장','청구·지급','자료목록.html'),'utf8');assert.match(html,/청구.txt/);assert.match(html,/file:\/\//);
    assert.equal(await readFile(path.join(root,'동우현장','청구.txt'),'utf8'),'동우현장 자재 청구금액을 확인해 주세요.');
    await agent.stop();agent.close();agent=new LocalAgent(data,parse,new CopyProtection(Buffer.alloc(32,1)));await agent.start();
    assert.equal(reads,1);const again=await agent.journal.work({route:'journal.list'},'http://127.0.0.1:5174') as {items:{id:string;received_at:string}[]};assert.deepEqual(again.items.map(d=>[d.id,d.received_at]),[[id,received]]);
    await writeFile(path.join(root,'동우현장','청구 복사.txt'),'동우현장 자재 청구금액을 확인해 주세요.');await agent.start();
    assert.equal((await agent.journal.work({route:'journal.list'},'http://127.0.0.1:5174') as {items:unknown[]}).items.length,1);
    await rename(path.join(root,'동우현장','청구.txt'),path.join(root,'동우현장','청구 수정이름.txt'));await agent.start();
    const renamed=await agent.journal.work({route:'journal.list'},'http://127.0.0.1:5174') as {items:{id:string;received_at:string}[]};assert.equal(renamed.items.length,1);assert.equal(renamed.items[0]?.id,id);assert.equal(renamed.items[0]?.received_at,received);
    assert.match(await agent.sourcePath(agent.document(id)),/청구 수정이름.txt$/);
    assert.equal(agent.journal.organizeHistory().queued,1);await agent.start();assert.equal(reads,4);
  }finally{await agent.stop();agent.close();assert(inside(os.tmpdir(),temp)&&path.basename(temp).startsWith('sigongnote-local-journal-'));await rm(temp,{recursive:true,force:true});}
});

test('local shared work API pairs without cloud login and imports a real file into journal',async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'sigongnote-local-journal-api-'));const data=path.join(temp,'private');await mkdir(data);
  const agent=new LocalAgent(data,async file=>({status:'complete',sourceHash:sha256(await readFile(file)),spans:[{text:await readFile(file,'utf8'),locator:'line:1'}],issues:[]}),new CopyProtection(Buffer.alloc(32,2)));
  const app=createLocalServer(agent,new LocalAi(agent,{dailyCalls:0}),{port:5174,webDir:temp,pairToken:'test-pair'});
  try{
    const pair=await app.inject({method:'POST',url:'/api/pair',headers:{host:'127.0.0.1:5174','x-sigongnote-local':'1'},payload:{token:'test-pair'}});assert.equal(pair.statusCode,200);
    const headers={host:'127.0.0.1:5174','x-sigongnote-local':'1',cookie:String(pair.headers['set-cookie']).split(';')[0]!};
    const context=await app.inject({method:'POST',url:'/api/work',headers,payload:{route:'context'}});assert.equal(context.statusCode,200);assert.equal(context.json().local,true);
    const imported=await app.inject({method:'POST',url:'/api/local/import',headers,payload:{name:'테스트현장 청구.txt',base64:Buffer.from('테스트현장 청구 자료').toString('base64')}});assert.equal(imported.statusCode,200,imported.body);
    await agent.start();
    const journal=await app.inject({method:'POST',url:'/api/work',headers,payload:{route:'journal.list'}});assert.equal(journal.statusCode,200);assert.equal(journal.json().items.length,1);assert.equal(journal.json().items[0].project_name,'테스트현장');
    const original=await app.inject({method:'GET',url:`/local-original/${imported.json().id}`,headers:{host:'127.0.0.1:5174',cookie:headers.cookie}});assert.equal(original.statusCode,200);assert.equal(original.body,'테스트현장 청구 자료');
    const unauthenticated=await app.inject({method:'GET',url:`/local-original/${imported.json().id}`,headers:{host:'127.0.0.1:5174'}});assert.equal(unauthenticated.statusCode,401);
  }finally{await agent.stop();await app.close();agent.close();assert(inside(os.tmpdir(),temp)&&path.basename(temp).startsWith('sigongnote-local-journal-api-'));await rm(temp,{recursive:true,force:true});}
});
