import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createDemoServer} from '../services/demo/server.js';
import {DemoStore,digest} from '../services/demo/store.js';
import {createFieldLedgerSnapshot,fieldLedgerCsv,type FieldLedgerBundle,type FieldLedgerRecord} from '../packages/domain/src/field-ledger.js';

const record=(patch:Partial<FieldLedgerRecord>={}):FieldLedgerRecord=>({id:'r1',projectId:'p1',projectName:'시험 현장',occurredAt:'2026-11-01',receivedAt:'2026-11-02T01:00:00Z',type:'청구',party:null,item:null,quantity:null,amountMinor:'120000',request:'시험 청구 자료',change:null,status:'청구 기록',attribution:'assigned',confirmation:'pending',nextAction:'입금 확인',previousIds:[],sourceIds:['s1'],updatedAt:null,origin:'import',...patch});
const bundle=():FieldLedgerBundle=>({schemaVersion:1,projects:[{id:'p1',name:'시험 현장'},{id:'p2',name:'비교 현장'}],sources:[{id:'s1',kind:'document',label:'시험 원문.txt',locator:'줄 1',sha256:digest('시험 원문')}],records:[record()]});
async function setup(){const dir=await mkdtemp(path.join(os.tmpdir(),'sigongnote-demo-runtime-'));const privateDir=path.join(dir,'private'),source=path.join(dir,'original.txt');await mkdir(privateDir);await writeFile(source,'시험 원문');await writeFile(path.join(privateDir,'bundle.json'),JSON.stringify(bundle()));await writeFile(path.join(privateDir,'source-paths.json'),JSON.stringify({s1:{path:source,sha256:digest('시험 원문'),mime:'text/plain;charset=utf-8'}}));return {dir,privateDir,source};}
async function cleanup(dir:string){assert(path.dirname(dir)===os.tmpdir()&&path.basename(dir).startsWith('sigongnote-demo-runtime-'));await rm(dir,{recursive:true,force:true});}
const fileBody=(name:string,text:string,projectId:string|null='p1')=>({name,base64:Buffer.from(text).toString('base64'),projectId});

test('demo imports a new receipt, preserves source, deduplicates and exports immutable snapshots after restart',async()=>{
 const fixture=await setup();let app=await createDemoServer({dataDir:fixture.privateDir,pollIntervalMs:0});
 try{
  const firstResponse=await app.inject('/api/ledger?project=p1&attribution=assigned');assert.equal(firstResponse.statusCode,200,firstResponse.body);const first=firstResponse.json();assert.equal(first.snapshot.records.length,1);assert.equal(first.snapshot.records[0].confirmation,'pending');assert(!firstResponse.body.includes(fixture.dir));
  assert.equal((await app.inject('/api/sources/s1')).body,'시험 원문');
  const payload=fileBody('새 요청.txt','자재 규격을 확인해 주세요.');const headers={'x-sigongnote-csrf':first.csrfToken};
  const added=await app.inject({method:'POST',url:'/api/import',headers,payload});assert.equal(added.statusCode,201,added.body);const receipt=added.json();assert.equal(receipt.snapshot.records.length,2);assert.notEqual(receipt.snapshot.id,first.snapshot.id);
  const row=receipt.snapshot.records.find((r:FieldLedgerRecord)=>r.id===receipt.recordIds[0]);assert.equal(row.amountMinor,null);assert.equal(row.occurredAt,null);assert.equal(row.confirmation,'recorded');assert.equal(row.attribution,'assigned');
  const original=await app.inject(`/api/sources/${row.sourceIds[0]}`);assert.equal(original.body,'자재 규격을 확인해 주세요.');
  const repeated=await app.inject({method:'POST',url:'/api/import',headers,payload});assert.equal(repeated.statusCode,200,repeated.body);assert.equal(repeated.json().duplicate,true);assert.equal(repeated.json().snapshot.records.length,2);
  const oldCsv=(await app.inject(`/api/snapshots/${first.snapshot.id}.csv`)).body,newCsv=(await app.inject(`/api/snapshots/${receipt.snapshot.id}.csv`)).body;assert(!oldCsv.includes('새 요청.txt'));assert(newCsv.includes('새 요청.txt'));assert(newCsv.includes(receipt.snapshot.id));
  const html=(await app.inject(`/api/snapshots/${receipt.snapshot.id}.html`)).body;assert(html.includes('새 요청.txt'));assert(html.includes(receipt.snapshot.id));assert(!html.includes(fixture.dir));
  await app.close();app=await createDemoServer({dataDir:fixture.privateDir,pollIntervalMs:0});
  const reopened=(await app.inject('/api/ledger?project=p1&attribution=assigned')).json();assert.equal(reopened.snapshot.records.length,2);assert.equal((await app.inject(`/api/snapshots/${first.snapshot.id}.csv`)).body,oldCsv);assert.equal(await readFile(fixture.source,'utf8'),'시험 원문');
 }finally{await app.close();await cleanup(fixture.dir);}
});

test('demo rejects cross-origin writes, arbitrary source paths, changed originals and unsupported JSON',async()=>{
 const fixture=await setup(),app=await createDemoServer({dataDir:fixture.privateDir,pollIntervalMs:0});
 try{
  const context=(await app.inject('/api/ledger')).json(),payload=fileBody('new.txt','입력');
  assert.equal((await app.inject({method:'POST',url:'/api/import',payload})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/import',headers:{origin:'https://unrelated.invalid','x-sigongnote-csrf':context.csrfToken},payload})).statusCode,403);
  assert.equal((await app.inject({url:'/api/ledger',headers:{host:'unrelated.invalid'}})).statusCode,403);
  assert.equal((await app.inject({url:'/api/ledger',headers:{'sec-fetch-site':'cross-site'}})).statusCode,403);
  assert.equal((await app.inject('/api/sources/unregistered')).statusCode,404);
  assert.equal((await app.inject('/api/sources/..%2F..%2Foriginal.txt')).statusCode,404);
  await writeFile(fixture.source,'변경된 원문');assert.equal((await app.inject('/api/sources/s1')).statusCode,409);
  const invalid=await app.inject({method:'POST',url:'/api/import',headers:{'x-sigongnote-csrf':context.csrfToken},payload:fileBody('invalid.json','{"hello":"world"}')});assert.equal(invalid.statusCode,422);assert.equal((await app.inject('/api/ledger')).json().snapshot.records.length,1);
 }finally{await app.close();await cleanup(fixture.dir);}
});

test('demo incoming folder adds source-backed structured changes and frozen PDF is rendered once',async()=>{
 const fixture=await setup();let renders=0;const app=await createDemoServer({dataDir:fixture.privateDir,pollIntervalMs:0,pdfRenderer:async html=>{renders++;return Buffer.from('%PDF-test '+digest(html));}});
 try{
  const store=await new DemoStore(fixture.privateDir).initialize();const incoming=path.join(fixture.privateDir,'incoming','p1');await mkdir(incoming);
  const intakeStarted=Date.now();const change:FieldLedgerBundle={...bundle(),records:[record({id:'r2',type:'변경',request:'규격 변경 접수',change:'시험 규격 A에서 B로 변경 요청',amountMinor:null,receivedAt:null,confirmation:'pending',previousIds:['r1']})]};
  const file=path.join(incoming,'change.json'),body=JSON.stringify(change);await writeFile(file,body);assert.deepEqual(await store.scanIncoming(),{added:1,failed:0});assert.deepEqual(await store.scanIncoming(),{added:0,failed:0});assert.equal(await readFile(file,'utf8'),body);
  // Reopen so the API adopts the durable import state produced by a separate store instance.
  await app.close();const reopened=await createDemoServer({dataDir:fixture.privateDir,pollIntervalMs:0,pdfRenderer:async html=>{renders++;return Buffer.from('%PDF-test '+digest(html));}});
  try{const snapshot=(await reopened.inject('/api/ledger?project=p1')).json().snapshot;assert.equal(snapshot.records.length,2);const row=snapshot.records.find((r:FieldLedgerRecord)=>r.id==='r2');assert.deepEqual(row.previousIds,['r1']);assert.equal(row.sourceIds.length,2);assert.equal(row.confirmation,'pending');assert(Date.parse(row.receivedAt)>=intakeStarted);assert.equal(row.occurredAt,'2026-11-01');assert.equal(row.updatedAt,null);
   const first=await reopened.inject(`/api/snapshots/${snapshot.id}.pdf`),second=await reopened.inject(`/api/snapshots/${snapshot.id}.pdf`);assert.equal(first.statusCode,200,first.body);assert.deepEqual(first.rawPayload,second.rawPayload);assert.equal(renders,1);
  }finally{await reopened.close();}
 }finally{await app.close();await cleanup(fixture.dir);}
});

test('demo empty private folder stays empty and rejects unknown project',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sigongnote-demo-runtime-'));const app=await createDemoServer({dataDir:dir,pollIntervalMs:0});
 try{const first=(await app.inject('/api/ledger')).json();assert.equal(first.snapshot.records.length,0);assert.equal(first.projects.length,0);const result=await app.inject({method:'POST',url:'/api/import',headers:{'x-sigongnote-csrf':first.csrfToken},payload:fileBody('new.txt','new','unregistered')});assert.equal(result.statusCode,404);}
 finally{await app.close();await cleanup(dir);}
});

const datasetHeaders=['업무ID','현장ID','현장명','업무발생일','자료접수일','업무유형','상대업체','품목','수량','금액','요청내용','변경내용','현재상태','확인필요사항','연결된이전기록','원문자료ID'];
const csv=(rows:string[][])=>'\uFEFF'+rows.map(row=>row.map(value=>'"'+value.replaceAll('"','""')+'"').join(',')).join('\r\n')+'\r\n';
const datasetRow=(id:string,amount='1,200')=>[id,'p1','시험 현장','2026-11-04','미확인','변경','시험 업체','"규격 A"','3',amount,'규격을 확인해 주세요.\n"A" 대신 B 요청','A → B 변경 요청','변경 요청 접수','최종 규격 확인','r1','s1;unregistered-reference'];

test('demo imports explicit Korean CSV rows with multiline fields and evidence into snapshot, export and restart',async()=>{
 const fixture=await setup();let app=await createDemoServer({dataDir:fixture.privateDir,pollIntervalMs:0});
 try{
  const token=(await app.inject('/api/ledger')).json().csrfToken,headers={'x-sigongnote-csrf':token};
  const intakeStarted=Date.now();const body=csv([datasetHeaders,datasetRow('csv-row')]);
  const response=await app.inject({method:'POST',url:'/api/import',headers,payload:fileBody('신규 업무.csv',body)});assert.equal(response.statusCode,201,response.body);
  const snapshot=response.json().snapshot,row=snapshot.records.find((value:FieldLedgerRecord)=>value.id==='csv-row');assert(row);assert.equal(row.amountMinor,'1200');assert.equal(row.occurredAt,'2026-11-04');assert(Date.parse(row.receivedAt)>=intakeStarted);assert.equal(row.updatedAt,null);assert.equal(row.confirmation,'recorded');assert.equal(row.status,'변경 요청 접수');assert.equal(row.request,'규격을 확인해 주세요.\n"A" 대신 B 요청');assert.deepEqual(row.previousIds,['r1']);assert(row.sourceIds.includes('s1'));assert(!row.sourceIds.includes('unregistered-reference'));
  const uploaded=snapshot.sources.find((source:{id:string})=>source.id.startsWith('source-'));assert(uploaded.locator.includes('unregistered-reference'));assert.equal((await app.inject(uploaded.url)).body,body);
  const exported=(await app.inject(`/api/snapshots/${snapshot.id}.csv`)).body;assert(exported.includes('csv-row'));assert(exported.includes('"1200"'));assert(exported.includes('""A""'));assert.equal((await app.inject({method:'POST',url:'/api/import',headers,payload:fileBody('신규 업무.csv',body)})).json().duplicate,true);
  const exportedBundle={...bundle(),records:[record({id:'exported-row',request:'=literal request',receivedAt:null,amountMinor:'-5000'})]};
  const exportedInput=fieldLedgerCsv(await createFieldLedgerSnapshot(exportedBundle));const importedExport=await app.inject({method:'POST',url:'/api/import',headers,payload:fileBody('원장 내보내기.csv',exportedInput)});assert.equal(importedExport.statusCode,201,importedExport.body);const exportRow=importedExport.json().snapshot.records.find((value:FieldLedgerRecord)=>value.id==='exported-row');assert.equal(exportRow.request,'=literal request');assert.equal(exportRow.amountMinor,'-5000');assert.equal(exportRow.confirmation,'pending');
  await app.close();app=await createDemoServer({dataDir:fixture.privateDir,pollIntervalMs:0});const reopened=(await app.inject('/api/ledger?project=p1')).json().snapshot;assert.equal(reopened.records.length,3);assert.equal(reopened.records.find((value:FieldLedgerRecord)=>value.id==='csv-row').amountMinor,'1200');assert.equal((await app.inject(`/api/snapshots/${snapshot.id}.csv`)).body,exported);
 }finally{await app.close();await cleanup(fixture.dir);}
});

test('demo rejects malformed recognized CSV atomically and does not overwrite same-ID facts without explicit revision',async()=>{
 const fixture=await setup(),app=await createDemoServer({dataDir:fixture.privateDir,pollIntervalMs:0});
 try{
  const initial=(await app.inject('/api/ledger')).json(),headers={'x-sigongnote-csrf':initial.csrfToken};
  for(const body of [csv([datasetHeaders,datasetRow('valid-row'),datasetRow('bad-row','12,34')]),csv([datasetHeaders])+ '"unfinished']){
   const response=await app.inject({method:'POST',url:'/api/import',headers,payload:fileBody('잘못된 원장.csv',body)});assert.equal(response.statusCode,422,response.body);assert.equal((await app.inject('/api/ledger')).json().snapshot.records.length,1);assert.deepEqual(await readdir(path.join(fixture.privateDir,'imported')),[]);assert.equal((await readdir(fixture.privateDir)).includes('import-state.json'),false);
  }
  const revisedRow=datasetRow('r1');revisedRow[14]='';
  const collision=await app.inject({method:'POST',url:'/api/import',headers,payload:fileBody('중복ID.csv',csv([datasetHeaders,revisedRow]))});assert.equal(collision.statusCode,409,collision.body);assert.equal((await app.inject('/api/ledger')).json().snapshot.records[0].request,'시험 청구 자료');assert.deepEqual(await readdir(path.join(fixture.privateDir,'imported')),[]);
  const revised=await app.inject({method:'POST',url:'/api/import',headers,payload:fileBody('새판.csv',csv([[...datasetHeaders,'기록버전'],[...revisedRow,'2']]))});assert.equal(revised.statusCode,201,revised.body);assert.equal(revised.json().snapshot.records.length,1);assert.equal(revised.json().snapshot.records[0].revision,2);assert.equal(revised.json().snapshot.records[0].receivedAt,'2026-11-02T01:00:00Z');assert.equal(revised.json().snapshot.records[0].updatedAt,null);
  const ordinary=await app.inject({method:'POST',url:'/api/import',headers,payload:fileBody('일반.csv','a,b\n1,2')});assert.equal(ordinary.statusCode,201,ordinary.body);const receipt=ordinary.json().snapshot.records.find((value:FieldLedgerRecord)=>value.origin==='journal');assert(receipt);assert.equal(receipt.amountMinor,null);assert.equal(receipt.request,'자료 접수: 일반.csv');
 }finally{await app.close();await cleanup(fixture.dir);}
});

test('demo refuses private data inside a Git working tree before creating files',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sigongnote-demo-runtime-'));await writeFile(path.join(dir,'.git'),'gitdir: ignored-test-marker');
 try{await assert.rejects(createDemoServer({dataDir:path.join(dir,'customer-data'),pollIntervalMs:0}),/PRIVATE_DIRECTORY_IN_GIT/);assert.deepEqual(await readdir(dir),['.git']);}
 finally{await cleanup(dir);}
});
