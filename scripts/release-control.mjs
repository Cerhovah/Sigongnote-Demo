import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {resolve,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
const shaPattern=/^[a-f0-9]{40}$/;
export async function prepareRelease(sha,previous,cwd=process.cwd(),output=resolve('.work/releases',randomUUID())){
 if(!shaPattern.test(sha)||!shaPattern.test(previous))throw Error('PINNED_RELEASE_REQUIRED');
 const git=args=>execFileSync('git',args,{cwd,encoding:'utf8',maxBuffer:1024*1024});
 for(const ref of [sha,previous])if(git(['rev-parse',ref+'^{commit}']).trim()!==ref)throw Error('RELEASE_COMMIT_REQUIRED');
 // Explicit runtime paths exclude private work, user documents and the reference-prohibited archive.
 const paths=['package.json','package-lock.json','tsconfig.json','apps/web','packages','services/api','services/document-worker','trade-packs','supabase/migrations',
 'scripts/db-gate.mjs','scripts/db-gate.d.mts','scripts/local-env-values.mjs','scripts/local-env-values.d.mts','scripts/write-release.mjs','scripts/run-cloud-service.mjs','scripts/cloud-child-env.mjs','scripts/cloud-supervisor.mjs','scripts/check-short-stt-runtime.mjs'];
 const tracked=git(['ls-tree','-r','--name-only',sha,'--',...paths]).trim().split('\n');
 if(['scripts/write-release.mjs','services/api/Dockerfile','scripts/check-short-stt-runtime.mjs'].some(path=>!tracked.includes(path)))throw Error('RELEASE_RUNTIME_MISSING');
 if(tracked.some(p=>/(^|\/)\.env($|\.)/.test(p)&&!p.endsWith('.example')||/\.(p12|jks|keystore|protected)$/.test(p)))throw Error('RELEASE_PRIVATE_FILE');
 await mkdir(output,{recursive:true});const tar=resolve(output,'source.tar');
 // git archive reads the pinned tree, never uncommitted or untracked user content.
 const bytes=execFileSync('git',['archive','--format=tar',sha,'--',...paths],{cwd,maxBuffer:256*1024*1024});await writeFile(tar,bytes,{flag:'wx',mode:0o600});
 const plan={schema:1,archive_directory:relative(cwd,output),source_sha:sha,previous_sha:previous,archive_sha256:createHash('sha256').update(bytes).digest('hex'),runtime_paths:paths,
 build_arguments:{SIGONGNOTE_SOURCE_SHA:sha,SIGONGNOTE_ARCHIVE_SHA256:createHash('sha256').update(bytes).digest('hex')},previous_image_digest:null,rollback_target_verified:false,rollout:{semantic:false,short_stt:false,long_stt:false,fax:false,sms:'existing_policy_gate'},
 gates:['H09 operating transition and recovery custody','H02 real authentication','H04/H05 speech','H07 fax','H08 SMS'],
 steps:['Resolve and record previous immutable image digest before operating transition; SHA alone is not a runnable rollback target','Build this prepared Dockerfile/source.tar directory with both recorded arguments; record resulting immutable image digest','Expand/backfill/replay-check schema in isolated database before any operating change; apply and record with Supabase db push or a migration tool preserving the original timestamp in name','Keep provider gates disabled until their approved live checks; verify worker and company access','After approved deployment, verify /health/release SHA/archive hash and /health/ready together','On failure restore the previous recorded image digest; keep database, originals, queues and unknown attempts; never destructive down'],deployment_executed:false};
 const recipe=git(['show',sha+':services/api/Dockerfile']);plan.recipe_sha256=createHash('sha256').update(recipe).digest('hex');
 await writeFile(resolve(output,'Dockerfile'),recipe,{flag:'wx',mode:0o600});
 await writeFile(resolve(output,'plan.json'),JSON.stringify(plan,null,2),{flag:'wx',mode:0o600});return plan;
}
export async function verifyRelease(origin,sha,archiveHash,transport=fetch){
 if(!shaPattern.test(sha)||!/^[a-f0-9]{64}$/.test(archiveHash??''))throw Error('PINNED_RELEASE_REQUIRED');const u=new URL(origin);
 if(u.username||u.password||u.search||u.hash||u.pathname!=='/'||!(u.protocol==='https:'||u.protocol==='http:'&&['127.0.0.1','localhost'].includes(u.hostname)))throw Error('RELEASE_ORIGIN');
 const [identity,ready]=await Promise.all(['/health/release','/health/ready'].map(path=>transport(new URL(path,u),{redirect:'error',signal:AbortSignal.timeout(10000)})));
 if(!identity.ok||!ready.ok)throw Error('RELEASE_NOT_READY');const r=await identity.json(),h=await ready.json();
 if(h.migrations===undefined)throw Error('RELEASE_READINESS_CONTRACT_OLD');
 if(r.status!=='identified'||r.source_sha!==sha||r.archive_sha256!==archiveHash||r.source_dirty!==false||h.release?.source_sha!==sha||h.release?.archive_sha256!==archiveHash||h.release?.source_dirty!==false||h.service!=='sigongnote-api'||h.database!=='ready'||h.migrations!=='ready'||h.worker?.enabled!==true||h.worker?.ready!==true)throw Error('RELEASE_MISMATCH');
 return {source_sha:sha,archive_sha256:archiveHash,ready:true,observed_at:new Date().toISOString(),user_acceptance:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [action,a,b,c]=process.argv.slice(2);
 (action==='prepare'?prepareRelease(a,b):action==='verify'?verifyRelease(a,b,c):Promise.reject(Error('RELEASE_ARGUMENTS'))).then(r=>console.log(JSON.stringify(r)),e=>{console.error(/^[A-Z_]+$/.test(e.message)?e.message:'RELEASE_UNVERIFIED');process.exitCode=1;});
}
