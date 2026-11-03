import assert from 'node:assert/strict';
import {test} from 'node:test';
import {processingFixture} from './processing-fixture.js';
import {createApp} from '../services/api/src/app.js';
test('N26 context reports only this actor sources and preserves unknown coverage and company isolation',async()=>{
 const db=await processingFixture();let app:ReturnType<typeof createApp>|undefined;
 try{
  const own=await db.createFixture(),other=await db.createFixture();
  await db.admin`update app.capture_sources set reported_permission='revoked',permission_checked_at=now(),last_successful_scan_at=now() where tenant_id=${own.tenant}::uuid`;
  app=createApp({db:db.api,verifyToken:async()=>({userId:own.user,sessionId:own.session})});
  const headers={authorization:'Bearer synthetic','x-tenant-id':own.tenant};
  const result=await app.inject({url:'/v1/work/context',headers});assert.equal(result.statusCode,200,result.body);
  assert.equal(result.headers['cache-control'],'no-store');
  const report=result.json().readiness;assert.equal(report.coverage.source_count,1);assert.equal(report.coverage.full_content,'not_verified');
  assert.equal(report.capabilities.find((c:{source_id:string})=>c.source_id===own.source).state,'needs_reconnect');
  assert.ok(!result.body.includes(other.source));
  assert.equal((await app.inject({url:'/v1/work/context',headers:{...headers,'x-tenant-id':other.tenant}})).statusCode,404);
  await db.admin`insert into app.memberships(tenant_id,user_id,role) values(${own.tenant}::uuid,${other.user}::uuid,'owner')`;
  await db.admin`update app.memberships set role='operator' where tenant_id=${own.tenant}::uuid and user_id=${own.user}::uuid`;
  assert.equal((await app.inject({url:'/v1/work/context',headers})).statusCode,200);
  await db.admin`update app.memberships set role='viewer' where tenant_id=${own.tenant}::uuid and user_id=${own.user}::uuid`;
  assert.equal((await app.inject({url:'/v1/work/context',headers})).statusCode,404);
 }finally{await app?.close();await db.cleanup();}
});
