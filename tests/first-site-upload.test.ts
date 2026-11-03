import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {selectedUploads,setupFileIssue,setupUploader} from '../apps/web/src/work-setup-upload.js';
import type {WorkClient,WorkRequest} from '../apps/web/src/work-client.js';
import {WorkFailure} from '../apps/web/src/work-client.js';
import type {CapturePolicy} from '@sigongnote/contracts';
const multiPolicy:CapturePolicy={id:'anthropic-work-records-v1',purpose:'work_records',provider:'anthropic',processing_location:'US',storage_location:'KR',retention:'until_user_deletes',external_processing:true,processors:[{purpose:'long_stt',provider:'openai',processing_location:'US transcription',storage_location:'provider transient',retention:'delete after transcription'}]};

test('web selected upload retries lost acknowledgement without reupload, skips unsupported originals and isolates audio consent',async()=>{
 const calls:{action:string;key:string;body:Record<string,unknown>}[]=[],project=randomUUID();let completeAttempts=0,puts=0;
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:WorkRequest){assert.equal(r.route,'setup.capture');const call=JSON.parse('command' in r?r.command:'{}');calls.push(call);
  if(call.action==='device')return {id:randomUUID()} as T;
  if(call.action==='source')return {id:randomUUID(),generation:1} as T;
  if(call.action==='prepare')return {ingestion_id:randomUUID(),upload_url:'https://fixture.supabase.co/storage/v1/object/upload/sign/bucket/object?token=fixture'} as T;
  if(call.action==='complete'&&completeAttempts++===0)throw Error('Lost completion response');return {} as T;}};
 const previous=globalThis.fetch;globalThis.fetch=async()=>{puts++;return new Response('{}',{status:200});};
 try{
  const files=selectedUploads([new File(['text'],'자료.txt'),new File(['audio'],'녹음.m4a'),new File(['cad'],'원본.dwg')]);
  const upload=setupUploader(client,project,multiPolicy,true);
  await upload(files,new AbortController().signal,()=>{});assert.equal(files[0]!.done,undefined);assert.equal(files[1]!.done,true);assert.equal(puts,2);
  await upload(files,new AbortController().signal,()=>{});assert.equal(files[0]!.done,true);assert.equal(puts,2);
  const firstCompletes=calls.filter(c=>c.action==='complete');assert.equal(firstCompletes[0]!.key,firstCompletes[2]!.key);
  assert.deepEqual(calls.filter(c=>c.action==='source').map(c=>c.body.kind),['manual_share','call_recording']);
  assert.ok(calls.filter(c=>c.action==='binding').every(c=>c.body.project_id===project));
  assert.ok(calls.filter(c=>c.action==='source').every(c=>c.body.external_ai_consent===true));
  for(const source of calls.filter(c=>c.action==='source'))assert.deepEqual(source.body.processing_policy,multiPolicy,'both text and audio registrations carry the entire policy the user saw, including the named long-STT processor');
  assert.equal(setupFileIssue(files[2]!.file),'지원하지 않는 형식');assert.equal(setupFileIssue({name:'큰.pdf',size:209715201}),'200 MiB 초과');
  assert.equal(JSON.stringify(calls).includes('자료.txt'),false,'local names stay out of protocol payloads');
 }finally{globalThis.fetch=previous;}
});

test('expired web upload abandons old intent before renewing; terminal refusals do not loop',async()=>{
 const calls:{action:string;key:string;id?:string;body:Record<string,unknown>}[]=[];let puts=0,refuse=false;
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:WorkRequest){const c=JSON.parse('command' in r?r.command:'{}');calls.push(c);
  if(c.action==='device'||c.action==='source')return {id:randomUUID(),generation:1} as T;
  if(c.action==='prepare')return {ingestion_id:randomUUID(),upload_url:'https://fixture.supabase.co/storage/v1/object/upload/sign/bucket/object?token=fixture'} as T;
  if(c.action==='complete'&&refuse)throw new WorkFailure('SOURCE_EXPIRED');return {} as T;}};
 const previous=globalThis.fetch;globalThis.fetch=async()=>new Response('{}',{status:++puts===1?403:200});
 try{
  const files=selectedUploads([new File(['text'],'자료.txt')]),firstId=files[0]!.id;
  const upload=setupUploader(client,randomUUID(),{id:'local-fixture-v1',purpose:'work_records',provider:'local_fixture',processing_location:'development_computer',storage_location:'development_computer',retention:'until_user_deletes',external_processing:false},false);
  await upload(files,new AbortController().signal,()=>{});assert.equal(files[0]!.restart,true);
  await upload(files,new AbortController().signal,()=>{});assert.equal(files[0]!.done,true);assert.notEqual(files[0]!.id,firstId);
  const renewal=calls.filter(c=>['prepare','abandon'].includes(c.action));assert.deepEqual(renewal.map(c=>c.action),['prepare','abandon','prepare']);assert.notEqual(renewal[0]!.key,renewal[2]!.key);
  refuse=true;const rejected=selectedUploads([new File(['next'],'다른 자료.txt')]);await upload(rejected,new AbortController().signal,()=>{});assert.equal(rejected[0]!.terminal,true);
  const count=calls.length;await upload(rejected,new AbortController().signal,()=>{});assert.equal(calls.length,count,'confirmed source refusal requires a fresh consent selection');
 }finally{globalThis.fetch=previous;}
});
