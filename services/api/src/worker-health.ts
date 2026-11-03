import {readFileSync,writeFileSync,renameSync} from 'node:fs';

/** A long parser call has its own timeout; keep publishing process liveness while it works. */
export function startWorkerHeartbeat(file:string|undefined,intervalMs=10000){
  let state='starting';
  const tasks:Record<string,string>={};let stopping=false;
  const aggregate=()=>['dependency_wait','starting','working','retry_wait','ready'].find(s=>Object.values(tasks).includes(s))??state;
  const publish=()=>{if(!file)return;const temporary=`${file}.${process.pid}`;writeFileSync(temporary,JSON.stringify({service:'sigongnote-worker',state:stopping?'stopped':aggregate(),tasks,checkedAt:new Date().toISOString()}),{mode:0o600});renameSync(temporary,file);};
  const timer=setInterval(publish,intervalMs).unref();
  return {setState(next:string){state=next;publish();},setTaskState(task:string,next:string){if(tasks[task]!=='dependency_wait'||next!=='working')tasks[task]=next;publish();},stop(){stopping=true;publish();clearInterval(timer);}};
}

export function workerHealth(env:NodeJS.ProcessEnv=process.env,now=Date.now()){
  if(env.CLOUD_WORKER_ENABLED!=='true')return {enabled:false,state:'disabled',ready:true};
  try{
    const value:unknown=JSON.parse(readFileSync(env.WORKER_HEARTBEAT_FILE??'/tmp/sigongnote-worker-health.json','utf8'));
    if(!value||typeof value!=='object'||!('service'in value)||value.service!=='sigongnote-worker'||!('checkedAt'in value)||typeof value.checkedAt!=='string'||!('state'in value))throw new Error('INVALID_HEARTBEAT');
    const age=now-Date.parse(value.checkedAt),recent=Number.isFinite(age)&&age>=0&&age<90000;
    const active=recent&&['ready','working','retry_wait'].includes(String(value.state));
    return {enabled:true,state:recent?value.state:'stale',ready:active};
  }catch{return {enabled:true,state:'starting_or_unavailable',ready:false};}
}
