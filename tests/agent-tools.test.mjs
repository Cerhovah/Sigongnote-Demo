import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {allocateRun,parseOptions,reserveReview,summarizeEvents} from '../scripts/claude-headless.mjs';

test('same session invocations never overwrite logs',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sigongnote-run-test-'));
 const a=allocateRun(dir,'review','session'),b=allocateRun(dir,'review','session');
 assert.notEqual(a,b);fs.writeFileSync(path.join(dir,a,'proof'),'first');assert.equal(fs.readFileSync(path.join(dir,a,'proof'),'utf8'),'first');
 fs.unlinkSync(path.join(dir,a,'proof'));fs.rmdirSync(path.join(dir,a));fs.rmdirSync(path.join(dir,b));fs.rmdirSync(path.join(dir,'.work','claude-runs'));fs.rmdirSync(path.join(dir,'.work'));fs.rmdirSync(dir);
});
test('missing result, failed model, and model mismatch are never success',()=>{
 assert.equal(summarizeEvents([],'expected',0).status,'BLOCKED');
 assert.equal(summarizeEvents([{type:'result',is_error:false,modelUsage:{other:{}}}],'expected',0).status,'BLOCKED');
 assert.equal(summarizeEvents([{type:'result',is_error:true,modelUsage:{expected:{}}}],'expected',0).status,'BLOCKED');
 assert.equal(summarizeEvents([{type:'system',subtype:'init',model:'expected'},{type:'result',is_error:false,modelUsage:{other:{}}}],'expected',0).status,'BLOCKED');
 const s=summarizeEvents([{type:'assistant',message:{model:'expected',content:[{type:'tool_use',name:'Read'}]}},{type:'result',is_error:false,permission_denials:[{tool_name:'Bash',tool_use_id:'denied'}]}],'expected',0);
 assert.equal(s.status,'RESPONSE_RECEIVED');assert.equal(s.tools.Read,1);assert.equal(s.permissionDenials.length,1);
});
test('one base cannot reserve a second independent review',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sigongnote-review-test-'));
 reserveReview(dir,'base','first');assert.throws(()=>reserveReview(dir,'base','second'),/first/);
 fs.unlinkSync(path.join(dir,'.work','claude-runs','reviews','base.json'));fs.rmdirSync(path.join(dir,'.work','claude-runs','reviews'));fs.rmdirSync(path.join(dir,'.work','claude-runs'));fs.rmdirSync(path.join(dir,'.work'));fs.rmdirSync(dir);
});
test('runner rejects permission bypass and incomplete options',()=>{
 assert.throws(()=>parseOptions(['--permission-mode','acceptEdits']),/Unknown option/);
 assert.throws(()=>parseOptions(['--request']),/needs a value/);
 assert.deepEqual(parseOptions(['--probe']),{allow:[],probe:true});
});
test('capture refuses external or live URLs before browser startup',()=>{
 for(const args of [['--url','https://example.com'],['--url','http://127.0.0.1:5190','--query','']]){
  const r=spawnSync(process.execPath,['scripts/ui-shots.mjs',...args],{encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,/Only loopback|Only work=preview/);
 }
});
