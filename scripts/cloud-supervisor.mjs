import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
/** Owns only its spawned child. Abort never targets a saved PID or another server. */
export async function superviseChild({file,env,signal,onExit=()=>{},onStart=()=>{},backoffMs=1000,graceMs=25000,stdio='inherit'}){
 let failures=0;
 while(!signal.aborted){
  const started=Date.now();
  const child=spawn(process.execPath,[file],{env,windowsHide:true,stdio});
  let killTimer;
  const stop=()=>{child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),graceMs).unref();};
  signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
  onStart(child);
  try{await new Promise(resolve=>{child.once('exit',resolve);child.once('error',resolve);});}
  finally{signal.removeEventListener('abort',stop);clearTimeout(killTimer);onExit();}
  if(signal.aborted)return;
  failures=Date.now()-started>60000?0:failures+1;
  await delay(Math.min(30000,backoffMs*2**Math.min(failures,5)),undefined,{signal}).catch(()=>{});
 }
}
