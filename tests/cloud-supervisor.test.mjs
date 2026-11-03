import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {superviseChild} from '../scripts/cloud-supervisor.mjs';
test('N30 owned fixture child kill restarts once, invalidates readiness first, abort cannot restart',{timeout:15000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'sigongnote-supervisor-')),file=join(root,'fixture.mjs'),controller=new AbortController();let starts=0,exits=0;
 await writeFile(file,"import {writeFileSync} from 'node:fs';writeFileSync(process.env.MARKER,'ready');setInterval(()=>{},1000);");
 try{await superviseChild({file,env:{...process.env,MARKER:join(root,'ready')},signal:controller.signal,backoffMs:10,graceMs:100,stdio:'ignore',onStart(child){starts++;setTimeout(()=>{if(starts===1)child.kill('SIGKILL');else controller.abort();},200);},onExit(){exits++;assert.equal(starts,exits);}});assert.equal(starts,2);assert.equal(exits,2);assert.equal(await readFile(join(root,'ready'),'utf8'),'ready');}finally{controller.abort();await rm(root,{recursive:true,force:true});}
});
