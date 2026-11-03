import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deployRelease,inspectTarget,SERVICE_ID,SERVICE_ORIGIN,renderClient} from '../scripts/render-release.mjs';
import {assertImageManifest,IMAGE_REPOSITORY} from '../scripts/publish-release.mjs';
import {assertPrivateRegistry} from '../scripts/registry-privacy.mjs';
const previous={schema:1,source_sha:'a'.repeat(40),previous_sha:'b'.repeat(40),archive_sha256:'c'.repeat(64),recipe_sha256:'d'.repeat(64),image_id:'sha256:'+'e'.repeat(64),image:IMAGE_REPOSITORY+'@sha256:'+'f'.repeat(64),platform:'linux/amd64',runtime_verified:true};
const next={...previous,previous_sha:previous.source_sha,source_sha:'b'.repeat(40),image:IMAGE_REPOSITORY+'@sha256:'+'1'.repeat(64)};
const service=()=>({id:SERVICE_ID,name:'sigongnote-api',type:'web_service',suspended:'not_suspended',ownerId:'owner-synthetic',imagePath:previous.image,registryCredential:{id:'credential-synthetic'},autoDeployTrigger:'off',serviceDetails:{url:SERVICE_ORIGIN.slice(0,-1),plan:'1c-2g',region:'singapore',healthCheckPath:'/health/ready'}});
function harness({nextStatus='live',failVerification=false,unknownSubmit=false}={}){
 const calls=[],records=[];let number=0;const images={};
 const request=async(path,method='GET',body)=>{calls.push({path,method,body});if(path.includes('/deploys?'))return [];if(method==='POST'){if(unknownSubmit)throw Error('unavailable');const id='dep-'+(++number);images[id]=body.imageUrl;return {id};}if(path.includes('/deploys/')){const id=path.split('/').at(-1);return {id,status:id==='dep-1'?nextStatus:'live',image:{ref:images[id],sha:images[id].split('@')[1]}};}return service();};
 const verify=async(_origin,sha)=>{if(failVerification&&sha===next.source_sha)throw Error('not ready');return {ready:true};};
 return {calls,records,options:{request,verify,wait:async()=>{},record:async r=>{records.push(r);},attempts:1}};
}
test('N31c accepts only fixed images and existing paid service, no source/settings mutation on failed preflight',async()=>{
 assert.equal(assertImageManifest(previous),previous);
 for(const patch of [{image:IMAGE_REPOSITORY+':latest'},{runtime_verified:false},{platform:'linux/arm64'},{recipe_sha256:null}])assert.throws(()=>assertImageManifest({...previous,...patch}));
 for(const patch of [{serviceDetails:{...service().serviceDetails,plan:'0.5c-512mb'}},{imagePath:undefined},{name:'different'},{autoDeployTrigger:'commit'},{serviceDetails:{...service().serviceDetails,healthCheckPath:'/health/live'}}])await assert.rejects(()=>inspectTarget(async()=>({...service(),...patch})));
 const h=harness();await assert.rejects(()=>deployRelease(previous,previous,h.options));assert.equal(h.calls.length,0);
});
test('N31c metadata pointer failure preserves verified live image, and skipped build ancestors do not block deployment',async()=>{
 const h=harness(),request=h.options.request;
 h.options.request=async(path,method,body)=>{if(method==='PATCH')throw Error('settings unavailable');return request(path,method,body);};
 await assert.rejects(()=>deployRelease({...next,previous_sha:'0'.repeat(40)},previous,h.options),/POINTER_UPDATE_FAILED/);
 assert.equal(h.calls.filter(c=>c.method==='POST').length,1);assert.equal(h.records.at(-1).phase,'pointer_update_failed');assert.ok(h.records.some(r=>r.phase==='verified'));assert.equal(h.records.some(r=>r.phase.startsWith('rollback')),false);
});
test('N31c deploy verifies Render digest and API/worker before updating source; preserves environment and plan',async()=>{
 const h=harness();assert.equal((await deployRelease(next,previous,h.options)).phase,'verified');
 assert.deepEqual(h.calls.find(c=>c.method==='POST').body,{imageUrl:next.image});
 const patch=h.calls.find(c=>c.method==='PATCH').body;assert.deepEqual(Object.keys(patch).sort(),['autoDeployTrigger','image']);assert.equal(patch.image.imagePath,next.image);assert.equal(h.records.at(-1).user_acceptance,false);
});
test('N31c failed readiness returns to previous digest and verifies rollback without database down',async()=>{
 const h=harness({failVerification:true});await assert.rejects(()=>deployRelease(next,previous,h.options),/FAILED_ROLLED_BACK/);
 assert.deepEqual(h.calls.filter(c=>c.method==='POST').map(c=>c.body.imageUrl),[next.image,previous.image]);assert.equal(h.records.at(-1).phase,'rolled_back');
});
test('N31c ambiguous submission and still-running deploy never automatically retry or race rollback',async()=>{
 for(const config of [{unknownSubmit:true},{nextStatus:'update_in_progress'}]){const h=harness(config);await assert.rejects(()=>deployRelease(next,previous,h.options),/UNKNOWN|UNRESOLVED/);assert.equal(h.calls.filter(c=>c.method==='POST').length,1);assert.equal(h.calls.some(c=>c.method==='PATCH'),false);}
});
test('N31c Render transport pins host and hides provider body and credential on failure',async()=>{
 const call=renderClient('synthetic-token',async(url,options)=>{assert.equal(new URL(url).origin,'https://api.render.com');assert.equal(options.redirect,'error');return new Response('private provider text',{status:401});});
 await assert.rejects(()=>call('/services/'+SERVICE_ID),e=>e.message==='RENDER_REQUEST_FAILED');
});
test('N31c private code is never published to an already public or inaccessible registry package',async()=>{
 assert.equal((await assertPrivateRegistry('synthetic',true,async()=>new Response(null,{status:404}))).new_package,true);
 await assert.rejects(()=>assertPrivateRegistry('synthetic',false,async()=>new Response(null,{status:404})));
 for(const visibility of ['public','internal'])await assert.rejects(()=>assertPrivateRegistry('synthetic',true,async()=>Response.json({visibility})));
 await assert.rejects(()=>assertPrivateRegistry('synthetic',true,async()=>new Response(null,{status:403})));
 assert.equal((await assertPrivateRegistry('synthetic',false,async()=>Response.json({visibility:'private'}))).private,true);
});
