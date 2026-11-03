import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {prepareRelease} from './release-control.mjs';
import {checkImageRuntime} from './check-image-runtime.mjs';
import {assertPrivateRegistry} from './registry-privacy.mjs';

export const IMAGE_REPOSITORY='ghcr.io/cerhovah/sigongnote';
export function assertImageManifest(m){
 if(m?.schema!==1||!['source_sha','previous_sha'].every(k=>/^[a-f0-9]{40}$/.test(m[k]??''))||!['archive_sha256','recipe_sha256'].every(k=>/^[a-f0-9]{64}$/.test(m[k]??''))||!/^sha256:[a-f0-9]{64}$/.test(m.image_id??'')||m.runtime_verified!==true||m.platform!=='linux/amd64'||!new RegExp('^'+IMAGE_REPOSITORY.replaceAll('.','\\.')+'@sha256:[a-f0-9]{64}$').test(m.image??''))throw Error('RELEASE_IMAGE_MANIFEST');
 return m;
}
/** Docker login belongs to the caller's credential store; no credentials in arguments or artifacts. */
export async function publishRelease(sha,previous,publish=false){
 if(publish)await assertPrivateRegistry(process.env.GH_TOKEN,true);
 const plan=await prepareRelease(sha,previous),folder=resolve(plan.archive_directory);
 const tag=IMAGE_REPOSITORY+':'+sha+'-'+plan.archive_sha256.slice(0,12);
 const docker=args=>execFileSync('docker',args,{windowsHide:true,stdio:['ignore','inherit','inherit'],timeout:30*60*1000});
 docker(['build','--platform','linux/amd64','--label','org.opencontainers.image.source=https://github.com/Cerhovah/Sigongnote','--label','org.opencontainers.image.revision='+sha,'--build-arg','SIGONGNOTE_SOURCE_SHA='+sha,'--build-arg','SIGONGNOTE_ARCHIVE_SHA256='+plan.archive_sha256,'-t',tag,folder]);
 const checked=checkImageRuntime(tag);
 if(checked.release.source_sha!==sha||checked.release.archive_sha256!==plan.archive_sha256)throw Error('RELEASE_RUNTIME_MISMATCH');
 let image=null;
 if(publish){
  docker(['push',tag]);
  await assertPrivateRegistry(process.env.GH_TOKEN);
  const digests=JSON.parse(execFileSync('docker',['image','inspect',tag,'--format','{{json .RepoDigests}}'],{encoding:'utf8',windowsHide:true}));
  image=digests.find(d=>d.startsWith(IMAGE_REPOSITORY+'@sha256:'));
  if(!image)throw Error('RELEASE_DIGEST_MISSING');
  docker(['pull','--platform','linux/amd64',image]);
  if(checkImageRuntime(image).image_id!==checked.image_id)throw Error('RELEASE_REGISTRY_MISMATCH');
 }
 const manifest={schema:1,source_sha:sha,previous_sha:previous,archive_sha256:plan.archive_sha256,recipe_sha256:plan.recipe_sha256,image_id:checked.image_id,image,platform:'linux/amd64',runtime_verified:true,published:publish,deployed:false,created_at:new Date().toISOString()};
 if(publish)assertImageManifest(manifest);
 await writeFile(resolve(folder,'image.json'),JSON.stringify(manifest,null,2),{flag:'wx'});
 if(process.env.GITHUB_OUTPUT)await writeFile(process.env.GITHUB_OUTPUT,'manifest='+resolve(folder,'image.json')+'\n',{flag:'a'});
 return {manifest_path:resolve(folder,'image.json'),...manifest};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [sha,previous,flag,...extra]=process.argv.slice(2);
 if(extra.length||flag&&flag!=='--publish')throw Error('RELEASE_ARGUMENTS');
 publishRelease(sha,previous,flag==='--publish').then(r=>console.log(JSON.stringify(r)),()=>{console.error('RELEASE_BUILD_OR_PUBLISH_FAILED');process.exitCode=1;});
}
