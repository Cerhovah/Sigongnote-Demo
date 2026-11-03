import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {registerLiveWork,liveOrigin,localApiBase} from '../scripts/live-work-routes.js';

test('local API port override preserves loopback and rejects an arbitrary upstream',()=>{
 assert.equal(localApiBase('33001'),'http://127.0.0.1:33001');
 for(const value of ['0','65536','http://other.example','3001/path','1.5','NaN'])assert.throws(()=>localApiBase(value),/LOCAL_API_PORT_INVALID/);
});

const tenant='6fe7e8b1-fc2a-49b3-971e-35c132983fd4',user='745581b1-48a9-4493-9127-3b2a1c7c1738';
const headers={host:new URL(liveOrigin).host,origin:liveOrigin};
test('local work gateway isolates tenant, requires same-origin explicit open, and locks revoked cookies',async()=>{
 const app=Fastify();let calls=0;const root=await mkdtemp(join(tmpdir(),'sigongnote-live-gate-'));await writeFile(join(root,'index.html'),'<!doctype html><title>internal test</title>');
 await registerLiveWork(app,{tenantId:tenant,call:async(path,method)=>{calls++;assert.equal(method,'GET');return Response.json(path==='/v1/me'?{user_id:user,memberships:[{tenant_id:tenant},{tenant_id:user}]}:{ok:true});}},root,'test');
 try{
  assert.equal((await app.inject('/connection.json')).statusCode,403);
  assert.equal((await app.inject({url:'/connection.json',headers})).json().mode,'local-live');
  assert.equal((await app.inject({url:'/web/session',headers})).statusCode,401);
  const navigation={host:headers.host,'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'};
  assert.equal((await app.inject({url:'/',headers:navigation})).statusCode,200);
  assert.equal((await app.inject({url:'/web/session',headers:navigation})).statusCode,403);
  assert.equal((await app.inject({url:'/connection.json',headers:navigation})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/web/local/open',headers:navigation,payload:{}})).statusCode,403);
  for(const extra of [{origin:'https://other.example'},{host:'rebound.example:5189'},{'sec-fetch-site':'cross-site'}])assert.equal((await app.inject({method:'POST',url:'/web/local/open',headers:{...headers,...extra},payload:{}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/web/local/open',headers:{host:headers.host},payload:{}})).statusCode,403);
  const opened=await app.inject({method:'POST',url:'/web/local/open',headers,payload:{}});
  const cookie=String(opened.headers['set-cookie']).split(';')[0]!;
  assert.match(String(opened.headers['set-cookie']),/HttpOnly; SameSite=Strict/);
  assert.deepEqual(opened.json(),{opened:true});assert.equal(calls,0);
  const profile=await app.inject({url:'/web/session',headers:{...headers,cookie}});
  assert.deepEqual(profile.json().memberships,[{tenant_id:tenant}]);
  const request=(tenantId:string,body:unknown)=>app.inject({method:'POST',url:'/web/work',headers:{...headers,cookie},payload:{tenantId,request:body}});
  assert.equal((await request(user,{route:'context'})).statusCode,403);
  assert.equal((await request(tenant,{route:'context',path:'https://other.example'})).statusCode,400);
  assert.equal((await request(tenant,{route:'context'})).statusCode,200);assert.equal(calls,2);
  assert.equal((await app.inject({method:'POST',url:'/web/work',headers:{...headers,cookie,'content-type':'application/json'},payload:'{'})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/web/work',headers:{...headers,cookie},payload:{padding:'x'.repeat(1100001)}})).statusCode,413);
  await app.inject({method:'POST',url:'/web/logout',headers:{...headers,cookie},payload:{}});
  assert.equal((await request(tenant,{route:'context'})).statusCode,401);assert.equal(calls,2);
 }finally{await app.close();await unlink(join(root,'index.html'));await rmdir(root);}
});

test('local gateway keeps upstream error status and removes internal exception details',async()=>{
 const app=Fastify();let fail=false;
 await registerLiveWork(app,{tenantId:tenant,call:async()=>{if(fail)throw Error('private-secret');return Response.json({error:{code:'FORBIDDEN'}},{status:403});}},'.','test');
 try{
  const opened=await app.inject({method:'POST',url:'/web/local/open',headers,payload:{}}),cookie=String(opened.headers['set-cookie']).split(';')[0]!;
  assert.equal((await app.inject({url:'/web/session',headers:{...headers,cookie}})).statusCode,503);
  const call=()=>app.inject({method:'POST',url:'/web/work',headers:{...headers,cookie},payload:{tenantId:tenant,request:{route:'context'}}});
  assert.equal((await call()).statusCode,403);fail=true;
  const failed=await call();assert.equal(failed.statusCode,503);assert(!failed.body.includes('private-secret'));
 }finally{await app.close();}
});
