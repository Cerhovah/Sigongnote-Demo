import {pathToFileURL} from 'node:url';
/** Check before sending private code and again after publishing. Never change visibility or delete a package. */
export async function assertPrivateRegistry(token,allowMissing=false,transport=fetch){
 if(!token)throw Error('REGISTRY_CONNECTION_REQUIRED');
 const response=await transport('https://api.github.com/users/cerhovah/packages/container/sigongnote',{redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}});
 if(response.status===404&&allowMissing)return {new_package:true};
 if(!response.ok||(await response.json()).visibility!=='private')throw Error('REGISTRY_PRIVATE_REQUIRED');
 return {private:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [action,...rest]=process.argv.slice(2);if(rest.length||!['before','after'].includes(action))throw Error('REGISTRY_ARGUMENTS');
 assertPrivateRegistry(process.env.GH_TOKEN,action==='before').then(r=>console.log(JSON.stringify(r)),()=>{console.error('REGISTRY_PRIVATE_UNVERIFIED');process.exitCode=1;});
}
