import {test} from 'node:test';
import assert from 'node:assert/strict';
import {catchUp} from '../apps/web/src/work-sync.js';
import type {WorkClient,WorkRequest} from '../apps/web/src/work-client.js';
test('D17 interrupted catchup replays until applied, then resumes saved cursor',async()=>{
 const calls:WorkRequest[]=[];let saved:string|undefined,offline=true,failApply=true;
 const client:WorkClient={kind:'fixture',dispose(){},async request<T>(r:WorkRequest){calls.push(r);if(offline)throw new Error('offline');return {changes:[{id:'synthetic',kind:'document',tombstone:false,sequence:'1'}],next_cursor:'scoped:1',has_more:false} as T;}};
 const apply=async()=>{if(failApply)throw new Error('interrupted');},save=(v:string)=>{saved=v;};
 await assert.rejects(catchUp(client,saved,apply,save));assert.equal(saved,undefined);offline=false;
 await assert.rejects(catchUp(client,saved,apply,save));assert.equal(saved,undefined);failApply=false;
 await catchUp(client,saved,apply,save);assert.equal(saved,'scoped:1');await catchUp(client,saved,apply,save);
 assert.deepEqual(calls.at(-1),{route:'sync.changes',sync_version:2,cursor:'scoped:1'});
});
