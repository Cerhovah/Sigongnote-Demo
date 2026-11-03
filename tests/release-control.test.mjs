import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,dirname,resolve} from 'node:path';import {execFileSync} from 'node:child_process';
import {prepareRelease,verifyRelease} from '../scripts/release-control.mjs';
import {assertReleaseArchive} from '../scripts/write-release.mjs';
test('N30 release context reads only pinned runtime tree and keeps dirty/user/private files out',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sigongnote-release-'));const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']});
 try{git(['init']);git(['config','user.name','Synthetic']);git(['config','user.email','synthetic@example.invalid']);
  const paths=['package.json','package-lock.json','tsconfig.json','apps/web/index.html','packages/contracts/index.ts','services/api/Dockerfile','services/document-worker/pyproject.toml','trade-packs/index.json','supabase/migrations/20990101000000_test.sql','scripts/db-gate.mjs','scripts/db-gate.d.mts','scripts/local-env-values.mjs','scripts/local-env-values.d.mts','scripts/write-release.mjs','scripts/run-cloud-service.mjs','scripts/cloud-child-env.mjs','scripts/cloud-supervisor.mjs'];
  paths.push('scripts/check-short-stt-runtime.mjs');
  for(const path of paths){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),path==='scripts/check-short-stt-runtime.mjs'?'PINNED_SHORT_STT_RUNTIME':'PINNED_SOURCE');}git(['add','.']);git(['commit','-m','synthetic']);const sha=git(['rev-parse','HEAD']).trim();
  await writeFile(join(root,'scripts/write-release.mjs'),'UNCOMMITTED_MARKER');await writeFile(join(root,'user-note.txt'),'PRIVATE_USER_MARKER');await writeFile(join(root,'services/api/.env'),'UNTRACKED_SECRET_MARKER');
  const folder=join(root,'output'),plan=await prepareRelease(sha,sha,root,folder);assert.equal(plan.source_sha,sha);assert.equal(plan.deployment_executed,false);assert.equal(plan.rollout.fax,false);const bytes=await readFile(join(folder,'source.tar')),tar=bytes.toString();assert.match(tar,/PINNED_SOURCE/);assert.doesNotMatch(tar,/UNCOMMITTED_MARKER|PRIVATE_USER_MARKER|UNTRACKED_SECRET_MARKER/);await assert.rejects(()=>prepareRelease(sha,sha,root,folder),/EEXIST/);
  assert.ok(plan.runtime_paths.includes('scripts/check-short-stt-runtime.mjs'));assert.match(tar,/scripts\/check-short-stt-runtime\.mjs/);assert.match(tar,/PINNED_SHORT_STT_RUNTIME/);
  assert.equal(await readFile(join(folder,'Dockerfile'),'utf8'),'PINNED_SOURCE');assert.equal(plan.build_arguments.SIGONGNOTE_ARCHIVE_SHA256,plan.archive_sha256);assert.equal(plan.rollback_target_verified,false);
  assert.equal(assertReleaseArchive(bytes,sha,plan.archive_sha256),plan.archive_sha256);assert.throws(()=>assertReleaseArchive(bytes,'0'.repeat(40),plan.archive_sha256),/ARCHIVE_MISMATCH/);const changed=Buffer.from(bytes);changed[1200]^=1;assert.throws(()=>assertReleaseArchive(changed,sha,plan.archive_sha256),/ARCHIVE_MISMATCH/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('N30 ready endpoint alone cannot confirm deployment; SHA, archive, clean build and worker are required',async()=>{
 const sha='a'.repeat(40),hash='c'.repeat(64);let source=sha,worker=true,dirty=false,archive=hash,migrations='ready';const transport=async url=>Response.json(String(url).endsWith('/health/release')?{status:'identified',source_sha:source,archive_sha256:archive,source_dirty:dirty}:{service:'sigongnote-api',database:'ready',migrations,worker:{enabled:true,ready:worker},release:{source_sha:source,archive_sha256:archive,source_dirty:dirty}});
 const verify=()=>verifyRelease('https://example.invalid/',sha,hash,transport);
 assert.equal((await verify()).user_acceptance,false);migrations=undefined;await assert.rejects(verify,/READINESS_CONTRACT_OLD/);migrations='unverified';await assert.rejects(verify,/MISMATCH/);migrations='ready';source='b'.repeat(40);await assert.rejects(verify,/MISMATCH/);source=sha;worker=false;await assert.rejects(verify,/MISMATCH/);worker=true;dirty=true;await assert.rejects(verify,/MISMATCH/);dirty=false;archive='d'.repeat(64);await assert.rejects(verify,/MISMATCH/);await assert.rejects(()=>verifyRelease('http://example.invalid/',sha,hash,transport),/ORIGIN/);
});
test('N30 manually supplied SHA does not label a dirty checkout clean',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sigongnote-release-dirty-')),writer=resolve('scripts/write-release.mjs');const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']});
 try{git(['init']);git(['config','user.name','Synthetic']);git(['config','user.email','synthetic@example.invalid']);await mkdir(join(root,'services/api/dist'),{recursive:true});await mkdir(join(root,'supabase/migrations'),{recursive:true});await writeFile(join(root,'.gitignore'),'services/api/dist/');await writeFile(join(root,'supabase/migrations/20990101000000_test.sql'),'select 1');git(['add','.']);git(['commit','-m','synthetic']);const sha=git(['rev-parse','HEAD']).trim();
  const run=()=>execFileSync(process.execPath,[writer,sha],{cwd:root,stdio:['ignore','pipe','pipe']});run();assert.equal(JSON.parse(await readFile(join(root,'services/api/dist/release.json'),'utf8')).source_dirty,false);
  await writeFile(join(root,'services/api/untracked.ts'),'synthetic');run();assert.equal(JSON.parse(await readFile(join(root,'services/api/dist/release.json'),'utf8')).source_dirty,true);
 }finally{await rm(root,{recursive:true,force:true});}
});
