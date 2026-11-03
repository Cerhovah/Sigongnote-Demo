import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {workerHealth,startWorkerHeartbeat} from '../services/api/src/worker-health.js';
import {setTimeout as delay} from 'node:timers/promises';

test('cloud worker readiness rejects stale/missing/future heartbeats and distinguishes task retries',()=>{
  const dir=mkdtempSync(join(tmpdir(),'sigongnote-worker-health-')),file=join(dir,'status.json');
  const env={CLOUD_WORKER_ENABLED:'true',WORKER_HEARTBEAT_FILE:file};
  const now=Date.now();
  try{
    assert.equal(workerHealth(env,now).ready,false);
    for(const [age,state,ready] of [[1,'ready',true],[91000,'ready',false],[-1000,'ready',false],[1,'retry_wait',true],[1,'working',true],[1,'dependency_wait',false],[1,'invalid',false]] as const){
      writeFileSync(file,JSON.stringify({service:'sigongnote-worker',state,checkedAt:new Date(now-age).toISOString()}));
      assert.equal(workerHealth(env,now).ready,ready);
    }
    writeFileSync(file,'not-json');assert.equal(workerHealth(env,now).ready,false);
    assert.equal(workerHealth({},now).enabled,false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('an unfinished parser call continues publishing a live working heartbeat',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'sigongnote-worker-active-')),file=join(dir,'status.json');
  const heartbeat=startWorkerHeartbeat(file,10);
  try{
    heartbeat.setState('working');
    // Simulate a parser that has not returned while its previous health time goes stale.
    writeFileSync(file,JSON.stringify({service:'sigongnote-worker',state:'working',checkedAt:new Date(Date.now()-100000).toISOString()}));
    assert.equal(workerHealth({CLOUD_WORKER_ENABLED:'true',WORKER_HEARTBEAT_FILE:file}).ready,false);
    await delay(35);
    assert.equal(workerHealth({CLOUD_WORKER_ENABLED:'true',WORKER_HEARTBEAT_FILE:file}).ready,true);
    assert.equal(JSON.parse(readFileSync(file,'utf8')).state,'working');
  }finally{heartbeat.stop();rmSync(dir,{recursive:true,force:true});}
});
test('N30 a healthy peer cannot hide a failed loop and shutdown immediately stops readiness',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sigongnote-worker-loops-')),file=join(dir,'status.json');const heartbeat=startWorkerHeartbeat(file),env={CLOUD_WORKER_ENABLED:'true',WORKER_HEARTBEAT_FILE:file};
 try{heartbeat.setTaskState('parse','dependency_wait');heartbeat.setTaskState('photo','ready');assert.equal(workerHealth(env).ready,false);heartbeat.setTaskState('photo','working');assert.equal(workerHealth(env).ready,false);heartbeat.setTaskState('parse','ready');assert.equal(workerHealth(env).ready,true);heartbeat.stop();assert.equal(workerHealth(env).ready,false);}finally{heartbeat.stop();rmSync(dir,{recursive:true,force:true});}
});
test('N30 serial first task is ready after schema validation; dependency recovery stays unready until success',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sigongnote-worker-serial-')),file=join(dir,'status.json'),heartbeat=startWorkerHeartbeat(file),env={CLOUD_WORKER_ENABLED:'true',WORKER_HEARTBEAT_FILE:file};
 try{for(const task of ['parse','photo','audio','semantic','business','render'])heartbeat.setTaskState(task,'ready');heartbeat.setTaskState('parse','working');assert.equal(workerHealth(env).ready,true);
  heartbeat.setTaskState('parse','dependency_wait');heartbeat.setTaskState('parse','working');assert.equal(workerHealth(env).ready,false);heartbeat.setTaskState('parse','ready');assert.equal(workerHealth(env).ready,true);
 }finally{heartbeat.stop();rmSync(dir,{recursive:true,force:true});}
});
