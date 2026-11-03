import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {assertImageManifest,IMAGE_REPOSITORY} from './publish-release.mjs';
import {verifyRelease} from './release-control.mjs';

export const SERVICE_ID='srv-datokp6k1f9s7393dgeg';
export const SERVICE_ORIGIN='https://sigongnote-api.onrender.com/';
const prefix='/services/'+SERVICE_ID;
export function renderClient(key,transport=fetch){
 if(!key||/\s/.test(key))throw Error('RENDER_CONNECTION_REQUIRED');
 return async(path,method='GET',body)=>{
  const response=await transport('https://api.render.com/v1'+path,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  if(!response.ok)throw Error('RENDER_REQUEST_FAILED');return response.json();
 };
}
/** Existing image-backed service only. Initial private-registry binding is a separate H09 connection. */
export async function inspectTarget(request){
 const service=await request(prefix);
 if(service.id!==SERVICE_ID||service.name!=='sigongnote-api'||service.type!=='web_service'||service.suspended!=='not_suspended'||service.serviceDetails?.url!==SERVICE_ORIGIN.slice(0,-1)||service.serviceDetails?.plan!=='1c-2g'||service.serviceDetails?.region!=='singapore')throw Error('RENDER_EXISTING_SERVICE_REQUIRED');
 if(!service.imagePath?.startsWith(IMAGE_REPOSITORY+'@sha256:')||!service.registryCredential?.id)throw Error('RENDER_PRIVATE_IMAGE_CONNECTION_REQUIRED');
 if(service.autoDeployTrigger!=='off'&&service.autoDeploy!=='no')throw Error('RENDER_AUTODEPLOY_MUST_BE_OFF');
 if(service.serviceDetails.healthCheckPath!=='/health/ready')throw Error('RENDER_READINESS_PATH_REQUIRED');
 return service;
}
export async function deployRelease(next,previous,{request,verify=verifyRelease,wait=sleep,record=async()=>{},attempts=90}={}){
 assertImageManifest(next);assertImageManifest(previous);
 // Build ancestry is informational. Bind rollback to the actual current healthy image below.
 if(next.image===previous.image)throw Error('RELEASE_PREVIOUS_MISMATCH');
 const service=await inspectTarget(request);
 // Require the actual current healthy version, not merely a build labelled "rollback".
 if(service.imagePath!==previous.image)throw Error('RELEASE_CURRENT_IMAGE_MISMATCH');
 await verify(SERVICE_ORIGIN,previous.source_sha,previous.archive_sha256);
 const active=await request(prefix+'/deploys?limit=20');
 if(!Array.isArray(active)||active.some(row=>!['live','build_failed','update_failed','pre_deploy_failed','canceled','deactivated'].includes(row.deploy?.status)))throw Error('RENDER_OTHER_DEPLOY_ACTIVE');
 const waitFor=async(id,image)=>{
  if(!/^dep-[a-z0-9]+$/.test(id??''))throw Error('RENDER_DEPLOY_ID');
  for(let i=0;i<attempts;i++){
   const d=await request(prefix+'/deploys/'+id);
   if(d.status==='live'){
    if(d.image?.ref!==image||d.image?.sha?.replace(/^sha256:/,'')!==image.split('@sha256:')[1])throw Error('RENDER_DEPLOY_IMAGE_MISMATCH');
    return d;
   }
   if(['build_failed','update_failed','pre_deploy_failed','canceled','deactivated'].includes(d.status))throw Error('RENDER_DEPLOY_FAILED');
   await wait(10000);
  }throw Error('RENDER_DEPLOY_TIMEOUT');
 };
 await record({phase:'prepared',next,previous});
 // A POST with an unknown response is never blindly retried. Inspect Render before another command.
 let deployment;
 try{deployment=await request(prefix+'/deploys','POST',{imageUrl:next.image});}
 catch{await record({phase:'submission_unknown',automatic_retry:false});throw Error('RENDER_SUBMISSION_UNKNOWN');}
 await record({phase:'submitted',deploy_id:deployment.id});
 try{
  await waitFor(deployment.id,next.image);
  await verify(SERVICE_ORIGIN,next.source_sha,next.archive_sha256);
 }catch{
  // Do not queue rollback behind a still-running/unknown deploy: a late new image could win.
  const current=await request(prefix+'/deploys/'+deployment.id);
  if(!['live','build_failed','update_failed','pre_deploy_failed','canceled','deactivated'].includes(current.status)){await record({phase:'needs_attention',automatic_retry:false});throw Error('RENDER_DEPLOY_UNRESOLVED');}
  await record({phase:'rollback_starting',image:previous.image});
  const rollback=await request(prefix+'/deploys','POST',{imageUrl:previous.image});
  await record({phase:'rollback_submitted',deploy_id:rollback.id});
  await waitFor(rollback.id,previous.image);await verify(SERVICE_ORIGIN,previous.source_sha,previous.archive_sha256);
  await request(prefix,'PATCH',{image:{ownerId:service.ownerId,registryCredentialId:service.registryCredential.id,imagePath:previous.image},autoDeployTrigger:'off'});
  await record({phase:'rolled_back',deploy_id:rollback.id,image:previous.image});throw Error('RENDER_RELEASE_FAILED_ROLLED_BACK');
 }
 const report={phase:'verified',deploy_id:deployment.id,image:next.image,source_sha:next.source_sha,user_acceptance:false};await record(report);
 // A settings write failing after a healthy deployment must never roll back working software.
 try{await request(prefix,'PATCH',{image:{ownerId:service.ownerId,registryCredentialId:service.registryCredential.id,imagePath:next.image},autoDeployTrigger:'off'});}
 catch{await record({phase:'pointer_update_failed',deploy_id:deployment.id,automatic_retry:false,live_image_verified:true});throw Error('RENDER_POINTER_UPDATE_FAILED');}
 await record({...report,phase:'pointer_updated'});return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 (async()=>{
  const [action,a,b,...rest]=process.argv.slice(2);if(rest.length)throw Error('RENDER_ARGUMENTS');
  const request=renderClient(process.env.RENDER_API_KEY);
  if(action==='inspect'&&!a){await inspectTarget(request);return {existing_service:true,image_connection:true};}
  if(action!=='deploy'||!a||!b)throw Error('RENDER_ARGUMENTS');
  const next=JSON.parse(await readFile(a,'utf8')),previous=JSON.parse(await readFile(b,'utf8'));
  const folder=resolve('.work/render-releases',randomUUID());await mkdir(folder,{recursive:true});let index=0;
  const record=r=>writeFile(resolve(folder,String(index++)+'.json'),JSON.stringify(r,null,2),{flag:'wx',mode:0o600});
  try{return await deployRelease(next,previous,{request,record});}catch(error){await record({phase:'command_failed',reason:/^[A-Z_]+$/.test(error.message)?error.message:'RENDER_RELEASE_UNVERIFIED',automatic_retry:false});throw error;}
 })().then(r=>console.log(JSON.stringify(r)),e=>{console.error(/^[A-Z_]+$/.test(e.message)?e.message:'RENDER_RELEASE_UNVERIFIED');process.exitCode=1;});
}
