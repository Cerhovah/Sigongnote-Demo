import assert from 'node:assert/strict';
import test from 'node:test';
import {buildReadiness} from '../services/api/src/readiness.js';
const now=new Date('2026-10-03T03:00:00Z');
const source={id:'10000000-0000-4000-8000-000000000001',kind:'folder',active:true,device_active:true,server_upload_consent:true,reported_permission:'granted',permission:'not_requested',capability:'passive',last_successful_scan_at:now,permission_checked_at:now,last_error_code:null,pending_count:0};
test('N01 missing provider does not disable a permitted source or claim full coverage',()=>{
 const r=buildReadiness([source],{},now,{enabled:true,ready:true,state:'working'});
 assert.equal(r.capabilities.find(c=>c.id==='semantic')?.state,'needs_setup');
 assert.equal(r.capabilities.find(c=>c.source_id===source.id)?.state,'ready');
 assert.equal(r.coverage.full_content,'not_verified');assert.equal(r.limits.budget_enforced,false);
});
test('N01 revoked permissions request reconnection only for the affected source',()=>{
 const r=buildReadiness([{...source,reported_permission:'revoked'},{...source,id:'20000000-0000-4000-8000-000000000002'}],{},now);
 assert.equal(r.capabilities.find(c=>c.source_id===source.id)?.action,'restore_permission');
 assert.equal(r.capabilities.at(-1)?.state,'ready');
 for(const patch of [{reported_permission:'denied'},{reported_permission:'role_missing'}])assert.equal(buildReadiness([{...source,...patch}],{},now).capabilities.at(-1)?.state,'needs_reconnect');
 assert.equal(buildReadiness([{...source,active:false}],{},now).capabilities.at(-1)?.state,'needs_setup');
 assert.equal(buildReadiness([{...source,device_active:false}],{},now).capabilities.at(-1)?.action,'none');
});
test('N01 stale worker and device reports are distinguished from missing provider settings',()=>{
 const r=buildReadiness([{...source,permission_checked_at:'2026-10-01T00:00:00Z'}],{SEMANTIC_API_KEY:'private-not-for-output',SEMANTIC_MODEL:'model'},now,{enabled:true,ready:false,state:'stale'});
 assert.equal(r.capabilities[0]?.state,'unverified');assert.equal(r.capabilities.find(c=>c.id==='semantic')?.state,'needs_setup');assert.match(r.capabilities.find(c=>c.id==='semantic')?.reason??'',/가격표/);
 assert.equal(r.capabilities.at(-1)?.state,'unverified');assert.ok(!JSON.stringify(r).includes('private-not-for-output'));
 assert.equal(buildReadiness([],{},now,{enabled:false,ready:true,state:'disabled'}).capabilities[0]?.state,'unverified');
 assert.equal(r.formats.find(f=>f.label==='CAD')?.status,'excluded');
});
test('N01 empty sources, pending work, setup and restored permission have separate outcomes',()=>{
 assert.equal(buildReadiness([],{},now).capabilities.at(-1)?.action,'connect_folder');
 assert.equal(buildReadiness([{...source,pending_count:1}],{},now).capabilities.at(-1)?.state,'waiting');
 assert.equal(buildReadiness([{...source,server_upload_consent:false}],{},now).capabilities.at(-1)?.state,'needs_setup');
 assert.equal(buildReadiness([{...source,last_error_code:'PERMISSION_LOST'}],{},now).capabilities.at(-1)?.action,'restore_permission');
 assert.equal(buildReadiness([{...source,last_error_code:null,reported_permission:'granted'}],{},now).capabilities.at(-1)?.state,'ready');
});
test('N30 invalid semantic rollout flag is disabled rather than asking to repair its price',()=>{
 const report=buildReadiness([],{SEMANTIC_ENABLED:'0',SEMANTIC_API_KEY:'synthetic',SEMANTIC_MODEL:'synthetic'},now);
 const capability=report.capabilities.find(c=>c.id==='semantic');assert.equal(capability?.state,'needs_setup');assert.equal(capability?.evidence,'not_verified');assert.doesNotMatch(capability?.reason??'',/가격표/);
});
