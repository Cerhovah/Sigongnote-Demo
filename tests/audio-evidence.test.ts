import assert from 'node:assert/strict';
import {test} from 'node:test';
import {audioEvidence,AudioNotAccepted,AudioResultInvalid} from '../services/api/src/long-audio.js';
import {openAiLongStt} from '../services/api/src/long-stt-openai.js';
import {selectSemanticWindow} from '../services/api/src/semantic-layout.js';

test('N22 overlap keeps absolute time and scoped speakers, deduplicates only simultaneous duplicate speech',()=>{
 const chunk={sha256:'a'.repeat(64),bytes:100,status:'completed' as const};
 const rows=audioEvidence({phase:'complete',decoderVersion:'mono16k-overlap-v2',chunks:[
  {...chunk,index:0,startMs:0,endMs:600000,segments:[{start:599100,end:599900,text:'아직 인수하지 않았어요',speaker:{label:'A'}}]},
  {...chunk,index:1,startMs:599000,endMs:1200000,segments:[{start:100,end:900,text:'아직 인수하지 않았어요',speaker:{label:'A'}},{start:1100,end:1900,text:'내일 도착하면 확인해요',speaker:{label:'A'}},{start:4000,end:4800,text:'아직 인수하지 않았어요'}]},
 ]});
 assert.equal(rows.length,3);assert.equal(rows[1]?.locator,'audio:600100-600900:3001');assert.notEqual(rows[0]?.position.speaker,rows[1]?.position.speaker);
 const c=(ordinal:number,text:string)=>({ordinal,text,locator:`audio:${ordinal*1000}-${ordinal*1000+500}:${ordinal}`,content_hash:'a'.repeat(64)});
 const window=selectSemanticWindow([c(1000,'아니요, 내일 확인할게요')],[c(0,'첫 문장'),c(998,'자재가 왔나요'),c(999,'오늘 전부 인수했나요')]);
 assert.deepEqual(window.context.map(x=>x.ordinal),[998,999]);assert.equal(window.chunks.filter(x=>!x.contextOnly).length,1);
});

test('N22 timed OpenAI wire is explicit, bounded, and has no invented speaker identity',async()=>{
 const env={LONG_STT_ENABLED:'true',LONG_STT_PROVIDER:'openai',LONG_STT_MODEL:'whisper-1',LONG_STT_API_KEY:'synthetic-test-only',LONG_STT_PRICE_JSON:JSON.stringify({version:'test',model:'whisper-1',krw_per_minute:30,valid_until:'2099-01-01T00:00:00Z'})};
 assert.equal(openAiLongStt({...env,LONG_STT_PROVIDER:'clova'}),undefined);assert.equal(openAiLongStt({...env,LONG_STT_MODEL:'unknown'}),undefined);
 const provider=openAiLongStt(env,async(url,init)=>{assert.equal(url,'https://api.openai.com/v1/audio/transcriptions');assert.equal(init?.redirect,'error');const form=init?.body as FormData;assert.equal(form.get('model'),'whisper-1');assert.equal(form.get('response_format'),'verbose_json');assert.equal(form.get('timestamp_granularities[]'),'segment');return new Response(JSON.stringify({segments:[{start:.1,end:.9,text:' 수량 미확인 '}]}),{headers:{'x-request-id':'synthetic-receipt'}});})!;
 const result=await provider.submit(new Uint8Array([1]),AbortSignal.timeout(1000));assert.notEqual(typeof result,'string');if(typeof result==='string')throw Error();assert.deepEqual(result.segments,[{start:100,end:900,text:'수량 미확인'}]);assert.match(result.receipt,/^[a-f0-9]{64}$/);
 await assert.rejects(openAiLongStt(env,async()=>new Response('',{status:429}))!.submit(new Uint8Array(),AbortSignal.timeout(1000)),AudioNotAccepted);
 await assert.rejects(openAiLongStt(env,async()=>new Response('',{status:503}))!.submit(new Uint8Array(),AbortSignal.timeout(1000)),/OUTCOME_UNKNOWN/);
 await assert.rejects(openAiLongStt(env,async()=>new Response('{"segments":"bad"}'))!.submit(new Uint8Array(),AbortSignal.timeout(1000)),AudioResultInvalid);
});
