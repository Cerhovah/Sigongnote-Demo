import assert from 'node:assert/strict';
import {test} from 'node:test';
import {resolve} from 'node:path';
import {MESSAGE_MIME,readMessageBundle,parseMessageBundle} from '../services/api/src/message-bundle.js';
import {parseBytes} from '../services/api/src/parse-worker.js';
import {syntheticMessage} from '../scripts/work-preview-message.js';
import {captureCapability,sourceAllowsMime} from '../services/api/src/capture-scope.js';
test('D18 message MIME requires an SMS or explicit manual import source',()=>{
 for(const kind of [null,'folder','photos','call_recording'])assert.equal(sourceAllowsMime(kind,null,MESSAGE_MIME),false);
 for(const kind of ['sms','manual_share'])assert.equal(sourceAllowsMime(kind,null,MESSAGE_MIME),true);
 assert.equal(sourceAllowsMime('sms',null,'text/plain'),false);
 assert.equal(sourceAllowsMime('sms',null,'image/png'),false);
});
const python={python:resolve('services/document-worker/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),pythonRoot:resolve('services/document-worker')};
test('D18 body and attachment locators remain bound; missing attachments cannot be complete',async()=>{
 const bytes=syntheticMessage();const out=await parseMessageBundle(bytes,async()=>({status:'complete',spans:[{text:'합성 첨부 인식',locator:'image:0'}],excerptTruncated:false,issues:[]}));
 assert.equal(out.status,'partial');assert.ok(out.spans.some(s=>s.locator==='message:part:1:image:0'));assert.ok(out.issues.includes('message_attachments_missing'));
 assert.ok(out.spans.some(s=>s.text==='작업: 주방 보수'));
 const actual=await parseBytes(bytes,MESSAGE_MIME,python,AbortSignal.timeout(30000));assert.equal(actual.status,'partial');assert.equal(actual.sourceHash,out.sourceHash);
});
test('D18 malformed image, duplicate parts, excessive body and binary envelope are rejected',()=>{
 const v=readMessageBundle(syntheticMessage());const encode=(v:unknown)=>Buffer.from(JSON.stringify(v));
 assert.throws(()=>readMessageBundle(encode({...v,parts:[{...v.parts[0],bytes_base64:Buffer.from('<script>').toString('base64')}]})));
 assert.throws(()=>readMessageBundle(encode({...v,parts:[v.parts[0],v.parts[0]]})));
 assert.throws(()=>readMessageBundle(encode({...v,body:'x'.repeat(65537)})));
 assert.throws(()=>readMessageBundle(Buffer.from([255])));
 assert.equal(captureCapability('sms','android'),'policy_gated');
 assert.equal(captureCapability('sms','windows'),'policy_gated');
});
test('D18 transient image failure retries; corrupt image is partial; span limits explicitly report truncation',async()=>{
 const v=readMessageBundle(syntheticMessage());v.missing_parts=0;
 await assert.rejects(parseMessageBundle(Buffer.from(JSON.stringify(v)),async()=>{throw new Error('PARSER_UNAVAILABLE')}));
 await assert.rejects(parseMessageBundle(Buffer.from(JSON.stringify(v)),async()=>({status:'partial',spans:[],excerptTruncated:false,issues:['OCR_ENGINE_UNAVAILABLE']})));
 const out=await parseMessageBundle(Buffer.from(JSON.stringify(v)),async()=>({status:'corrupt',spans:[],excerptTruncated:false,issues:['image_decode_failed']}));
 assert.equal(out.status,'partial');assert.ok(out.spans.length>0);assert.deepEqual(out.issues,['message_image_corrupt']);
 const long=await parseMessageBundle(Buffer.from(JSON.stringify({...v,body:'a\n'.repeat(2000),parts:[]})),async()=>{throw new Error('unused')});
 assert.equal(long.spans.length,1000);assert.equal(long.excerptTruncated,true);assert.equal(long.status,'partial');
});
