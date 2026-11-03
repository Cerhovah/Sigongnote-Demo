import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {LocalAgent,inside} from '../services/local-agent/src/agent.js';
import {CopyProtection} from '../services/local-agent/src/protection.js';
import {LocalPhotos} from '../services/local-agent/src/photos.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
test('local photo -> selected site -> actual PDF -> journal once -> restart and source correction',async()=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),'sigongnote-photo-flow-')),root=path.join(temp,'Documents'),data=path.join(temp,'private');await mkdir(root);await mkdir(data);
 const parse=async()=>({status:'complete' as const,spans:[],issues:[]});const key=new CopyProtection(Buffer.alloc(32,6));let agent=new LocalAgent(data,parse,key);
 try{
  const sourceFile=path.join(root,'시험현장 사진.png');await writeFile(sourceFile,png);await agent.grant(root,'automatic_discovery');await agent.start();
  const site=await agent.journal.work({route:'setup.command',command:JSON.stringify({action:'select',display_name:'시험현장'})},'http://127.0.0.1:5174') as {project_id:string};
  const photos=new LocalPhotos(agent);const list=await photos.work({route:'photos.list',project_id:site.project_id}) as {photos:{id:string}[]};assert.equal(list.photos.length,1);const photoId=list.photos[0]!.id;
  const preview=await photos.work({route:'photos.preview',id:photoId}) as {mime:string;base64:string};assert.equal(preview.mime,'image/jpeg');assert.ok(preview.base64.length>0);
  const save={route:'photos.command',command:JSON.stringify({client_command_id:randomUUID(),project_id:site.project_id,title:'시험 사진대지',photos:[{revision_id:photoId,caption:'실제 렌더 시험',location:'창틀',taken_date:null,rotation:0}]})};
  const group=await photos.work(save) as {id:string};assert.deepEqual(await photos.work(save),group);
  const prepare={route:'sheets.prepare',command:JSON.stringify({project_id:site.project_id,group_id:group.id,layout:4,grayscale:false})};const sheet=await photos.work(prepare) as {photo_sheet:{id:string;state:string}};assert.equal(sheet.photo_sheet.state,'succeeded');assert.deepEqual(await photos.work(prepare),sheet);
  const file=await photos.work({route:'sheets.file',id:sheet.photo_sheet.id}) as {base64:string};assert.equal(Buffer.from(file.base64,'base64').subarray(0,5).toString(),'%PDF-');
  const entry=(await photos.journalEntries())[0]!;assert.equal(entry.id,sheet.photo_sheet.id);assert.equal(entry.project_id,site.project_id);assert.deepEqual(entry.categories,['delivery_work']);assert.equal((await photos.journalEntries()).length,1);
  const output=agent.db.prepare('SELECT file_path FROM local_photo_sheets WHERE id=?').get(entry.id)!;assert.equal((await readFile(String(output.file_path))).subarray(0,5).toString(),'%PDF-');assert.deepEqual(await readFile(sourceFile),png);
  await agent.stop();agent.close();agent=new LocalAgent(data,parse,key);const restored=new LocalPhotos(agent);assert.equal((await restored.journalEntries())[0]?.id,entry.id);
  await writeFile(sourceFile,Buffer.from('changed'));assert.equal((await restored.journalEntries()).length,0);await assert.rejects(restored.work({route:'sheets.file',id:entry.id}),/SOURCE_CHANGED/);
 }finally{await agent.stop();agent.close();assert(inside(os.tmpdir(),temp)&&path.basename(temp).startsWith('sigongnote-photo-flow-'));await rm(temp,{recursive:true,force:true});}
});
