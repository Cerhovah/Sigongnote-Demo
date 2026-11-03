import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {registerCloudWeb} from '../services/api/src/cloud-web.js';
const user='20ba6191-6991-44f3-9486-3c39f800d862',tenant='70ba6191-6991-44f3-9486-3c39f800d862';
const site='https://fixture.example';
test('published download tag, visible installer version and package defaults stay aligned',async()=>{
 const [page,server,pack]=await Promise.all(['../apps/web/src/install-app.tsx','../services/api/src/cloud-web.ts','../scripts/package-cloud-clients.ps1'].map(p=>readFile(new URL(p,import.meta.url),'utf8')));
 assert.ok(page&&server&&pack);
 const version=/AndroidVersionName='([^']+)'/.exec(pack)?.[1];assert.ok(version);assert.ok(page.includes(`Android ${version} ·`));assert.ok(server.includes(`v${version}/Sigongnote-Android.apk`));
 const windows=/Windows ([^<]+)</.exec(page)?.[1];assert.ok(windows);assert.ok(server.includes(`v${windows}/Sigongnote-Setup.exe`));assert.ok(server.includes(`v${windows}/SHA256SUMS.txt`));assert.ok(page.includes('href="/download/windows-checksums"'));
 assert.match(pack,/AndroidVersionCode=23/);
});
test('cloud web PKCE cookie bridge preserves API membership and hides tokens from browser',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sigongnote-web-')),app=Fastify();let exchanges=0,workCalls=0;
 await writeFile(join(root,'index.html'),'<!doctype html><title>합성 업무</title>');
 app.get('/v1/me',async request=>{assert.equal(request.headers.authorization,'Bearer synthetic-access');return {user_id:user,memberships:[{tenant_id:tenant,tenant_name:'합성 회사',role:'owner'}]};});
 app.get('/v1/work/context',async(request,reply)=>{workCalls++;assert.equal(request.headers.authorization,'Bearer synthetic-access');if(request.headers['x-tenant-id']!==tenant)return reply.code(403).send({error:{code:'FORBIDDEN'}});return {tenant_id:tenant,user_id:user,company:'합성 회사'};});
 await registerCloudWeb(app,{authOrigin:'https://auth.example',publishableKey:'fixture-public',publicOrigin:site,providers:['custom:naver'],sessionSecret:Buffer.alloc(32,7).toString('base64'),webRoot:root,transport:async(input,init)=>{
   const url=String(input);if(url.includes('grant_type=pkce')){exchanges++;const body=JSON.parse(String(init?.body));assert.equal(body.auth_code,'synthetic-code');assert.equal(body.code_verifier.length,43);return Response.json({access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600,user:{id:user}});}if(url.includes('/logout'))return new Response(null,{status:204});throw new Error('Unexpected auth request');
 }});
 try{
  const index=await app.inject('/');assert.equal(index.statusCode,200);assert.match(String(index.headers['content-security-policy']),/frame-ancestors 'none'/);
  assert.deepEqual((await app.inject('/connection.json')).json().providers,['custom:naver']);
  for(const path of ['/?demo=1','/?work=fixture','/index.html?work=preview'])assert.equal((await app.inject(path)).headers.location,'/');
  assert.equal((await app.inject('/install')).statusCode,200);assert.equal((await app.inject('/activity')).headers.location,'/#/activity');
  for(const [platform,target] of Object.entries({android:'v0.3.0-rc.13/Sigongnote-Android.apk',windows:'v0.3.0-rc.13/Sigongnote-Setup.exe',checksums:'v0.3.0-rc.13/SHA256SUMS.txt','windows-checksums':'v0.3.0-rc.13/SHA256SUMS.txt'})){const download=await app.inject('/download/'+platform);assert.equal(download.statusCode,302);assert.equal(download.headers.location,'https://github.com/Cerhovah/Sigongnote-downloads/releases/download/'+target);assert.equal(download.headers['cache-control'],'no-store');}
  assert.equal((await app.inject('/download/unknown')).statusCode,404);
  assert.equal((await app.inject('/manifest.webmanifest')).json().start_url,'/');
  const unauth=await app.inject('/web/session');assert.equal(unauth.statusCode,401);
  const start=await app.inject('/web/auth/start?provider=custom%3Anaver');assert.equal(start.statusCode,302);
  const authorize=new URL(String(start.headers.location)),redirect=new URL(authorize.searchParams.get('redirect_to')!);assert.equal(redirect.origin,site);assert.equal(authorize.searchParams.get('code_challenge_method'),'s256');
  const flow=String(start.headers['set-cookie']).split(';')[0]!;
  assert.match(String(start.headers['set-cookie']),/HttpOnly; Secure; SameSite=Lax/);
  const wrong=await app.inject({url:'/web/auth/callback?state=wrong&code=synthetic-code',headers:{cookie:flow}});assert.equal(String(wrong.headers.location),'/?login=retry');assert.equal(exchanges,0);
  const completed=await app.inject({url:`/web/auth/callback?state=${redirect.searchParams.get('state')}&code=synthetic-code`,headers:{cookie:flow}});assert.equal(exchanges,1);assert.equal(completed.headers.location,'/');
  const cookies=completed.headers['set-cookie'] as string[];const session=cookies.find(c=>c.startsWith('sigongnote_web='))!.split(';')[0]!;assert(!session.includes('synthetic-access'));assert(!session.includes('synthetic-refresh'));
  const profile=await app.inject({url:'/web/session',headers:{cookie:session}});assert.equal(profile.json().user_id,user);assert(!profile.body.includes('synthetic-access'));
  const denied=await app.inject({method:'POST',url:'/web/work',headers:{cookie:session,origin:'https://other.example'},payload:{tenantId:tenant,request:{route:'context'}}});assert.equal(denied.statusCode,403);assert.equal(workCalls,0);
  const work=await app.inject({method:'POST',url:'/web/work',headers:{cookie:session,origin:site},payload:{tenantId:tenant,request:{route:'context'}}});assert.equal(work.statusCode,200);assert.equal(work.json().company,'합성 회사');
  const stranger=await app.inject({method:'POST',url:'/web/work',headers:{cookie:session,origin:site},payload:{tenantId:user,request:{route:'context'}}});assert.equal(stranger.statusCode,403);
  const injection=await app.inject({method:'POST',url:'/web/work',headers:{cookie:session,origin:site},payload:{tenantId:tenant,request:{route:'context',path:'https://other.example'}}});assert.equal(injection.statusCode,400);
  const corrupt=await app.inject({url:'/web/session',headers:{cookie:session+'x'}});assert.equal(corrupt.statusCode,401);
  const logout=await app.inject({method:'POST',url:'/web/logout',headers:{cookie:session,origin:site},payload:{}});assert.equal(logout.statusCode,200);assert.match(String(logout.headers['set-cookie']),/Max-Age=0/);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});

test('cloud cookie refresh survives temporary outage, concurrent requests and page reload',async()=>{
 const app=Fastify();let refreshes=0,temporaryFailure=true;
 app.get('/v1/me',async request=>{assert.equal(request.headers.authorization,'Bearer renewed-access');return {user_id:user,memberships:[]};});
 await registerCloudWeb(app,{authOrigin:'https://auth.example',publishableKey:'fixture-public',publicOrigin:site,providers:['google'],sessionSecret:Buffer.alloc(32,8).toString('base64'),webRoot:tmpdir(),transport:async(input)=>{
  if(String(input).includes('grant_type=refresh_token')){refreshes++;if(temporaryFailure)return new Response(null,{status:503});await new Promise(r=>setTimeout(r,20));return Response.json({access_token:'renewed-access',refresh_token:'renewed-refresh',expires_in:3600,user:{id:user}});}
  return Response.json({access_token:'old-access',refresh_token:'old-refresh',expires_in:60,user:{id:user}});
 }});
 try{
  const start=await app.inject('/web/auth/start?provider=google'),state=new URL(new URL(String(start.headers.location)).searchParams.get('redirect_to')!).searchParams.get('state');
  const done=await app.inject({url:`/web/auth/callback?state=${state}&code=synthetic-code`,headers:{cookie:String(start.headers['set-cookie']).split(';')[0]!}});
  const oldCookie=(done.headers['set-cookie'] as string[]).find(c=>c.startsWith('sigongnote_web='))!.split(';')[0]!;
  const outage=await app.inject({url:'/web/session',headers:{cookie:oldCookie}});assert.equal(outage.statusCode,503);assert.equal(outage.headers['set-cookie'],undefined);temporaryFailure=false;
  const responses=await Promise.all([1,2,3].map(()=>app.inject({url:'/web/session',headers:{cookie:oldCookie}})));
  assert(responses.every(r=>r.statusCode===200));assert.equal(refreshes,2);
  const newCookie=String(responses[0]!.headers['set-cookie']).split(';')[0]!;
  assert.notEqual(oldCookie,newCookie);
  const reloaded=await app.inject({url:'/web/session',headers:{cookie:newCookie}});assert.equal(reloaded.statusCode,200);assert.equal(refreshes,2);
 }finally{await app.close();}
});
