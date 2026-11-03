import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,unlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
test('D19 source fingerprint records tracked deletion and new source, excluding private draft',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sigongnote-fingerprint-'));
 const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
 const fingerprint=()=>JSON.parse(execFileSync(process.execPath,[resolve('scripts/verification-source.mjs')],{cwd:root,encoding:'utf8'}));
 try{
  git('init','-q');await mkdir(join(root,'apps'));await writeFile(join(root,'apps/source.ts'),'export const n=1;');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');
  const original=fingerprint();assert.equal(original.working_tree_dirty,false);
  await unlink(join(root,'apps/source.ts'));const deleted=fingerprint();assert.notEqual(deleted.source_sha256,original.source_sha256);assert.equal(deleted.working_tree_dirty,true);
  await writeFile(join(root,'apps/new.ts'),'export const n=2;');const added=fingerprint();assert.notEqual(added.source_sha256,deleted.source_sha256);
  await writeFile(join(root,'private-draft.md'),'synthetic private draft');assert.equal(fingerprint().source_sha256,added.source_sha256);
 }finally{await rm(root,{recursive:true,force:true});}
});
