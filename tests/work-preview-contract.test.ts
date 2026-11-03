import assert from 'node:assert/strict';
import {test} from 'node:test';
import {previewWorkClient} from '../apps/web/src/work-preview-client.js';

test('preview record creates a readable draft and preserves task and setup state',async()=>{
 const c=previewWorkClient({delayMs:0,firstUse:true});
 const context=await c.request<any>({route:'context'});assert.equal(context.setup.completed,false);
 const project=context.projects[0].id;
 const rows=await c.request<any>({route:'journal.list',project_id:project});
 assert.equal(rows.items[0].reading_state,'readable');assert.equal(rows.items[0].organization_version,1);
 const draft=await c.request<any>({route:'journal.command',command:JSON.stringify({action:'draft',project_id:project,id:rows.items[0].id,type:'estimate',expected_version:1})});
 assert.ok(draft.id);const body=await c.request<any>({route:'documents.read',id:draft.id});assert.equal(body.document.project.id,project);
 await c.request({route:'journal.command',command:JSON.stringify({action:'task',done:true})});assert.equal((await c.request<any>({route:'journal.tasks'})).items[0].done,true);
 await c.request({route:'setup.command',command:JSON.stringify({action:'select',project_id:project})});await c.request({route:'setup.command',command:JSON.stringify({action:'complete'})});assert.equal((await c.request<any>({route:'setup.read'})).completed,true);
});
test('unsupported preview effects reject rather than pretend success',async()=>{
 const c=previewWorkClient({delayMs:0});assert.equal((await c.request<any>({route:'archive.status'})).enabled,false);await assert.rejects(c.request({route:'setup.capture'} as any),/Unsupported preview route/);await assert.rejects(c.request({route:'archive.command'} as any),/Unsupported preview route/);
});
