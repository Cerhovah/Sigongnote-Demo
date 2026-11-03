import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {processingFixture} from './processing-fixture.js';
import {createApp} from '../services/api/src/app.js';

test('journal shows receipts without a work context, distinguishes empty partial parsing, filters dates and fences tenant/withdrawal',async()=>{
 const db=await processingFixture(),f=await db.createFixture('합성 문자: 내일 납품 수량을 확인해 주세요.'),other=await db.createFixture('합성 타회사');
 const app=createApp({db:db.api,capturePolicy:db.config.policy,verifyToken:async()=>({userId:f.user,sessionId:f.session})});
 const get=(suffix='',tenant=f.tenant)=>app.inject({method:'GET',url:'/v1/work/journal'+suffix,headers:{authorization:'Bearer fixture','x-tenant-id':tenant}});
 try{
  let r=await get();assert.equal(r.statusCode,200,r.body);let item=r.json().items[0];
  assert.equal(item.id,f.revision);assert.equal(item.context_id,null);assert.match(item.excerpt,/납품 수량/);assert.equal(item.reading_state,'readable');assert.equal(r.json().date_basis,'received_at');
  assert.equal((await get('?q=2000-01-01')).json().items.length,0);assert.equal((await get('?q=invalid')).statusCode,400);
  assert.equal((await get('',other.tenant)).statusCode,404);
  const site=randomUUID();await db.admin`insert into app.projects(tenant_id,id,display_name) values(${f.tenant}::uuid,${site}::uuid,'합성 일지 현장')`;
  await db.admin`update app.evidence_organizations set state='linked',project_id=${site}::uuid,categories=${['agreement','delivery_work']}::text[],version=version+1 where tenant_id=${f.tenant}::uuid and revision_id=${f.revision}::uuid`;
  assert.equal((await get('?project_id='+site+'&category=agreement')).json().items.length,1);
  assert.equal((await get('?project_id='+site+'&category=billing_payment')).json().items.length,0);
  await db.admin`update app.parse_results set output=jsonb_set(jsonb_set(output,'{status}','"partial"'),'{spans}','[]') where tenant_id=${f.tenant}::uuid and revision_id=${f.revision}::uuid`;
  item=(await get()).json().items[0];assert.equal(item.reading_state,'unreadable');assert.equal(item.excerpt,'');assert.equal(item.readable_spans,0);
  await db.admin`update app.capture_sources set server_upload_consent=false where tenant_id=${f.tenant}::uuid and id=${f.source}::uuid`;
  assert.equal((await get()).json().items.length,0);
 }finally{await app.close();await db.cleanup();}
});
