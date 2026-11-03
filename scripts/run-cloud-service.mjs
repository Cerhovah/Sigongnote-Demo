// One existing paid container hosts the authenticated web/API and persistent worker.
// Secrets stay in private environment/files. Neither child error objects nor env are logged.
import {writeFileSync,rmSync} from 'node:fs';
import {cloudChildEnvironment} from './cloud-child-env.mjs';
import {superviseChild} from './cloud-supervisor.mjs';
const enabled=process.env.CLOUD_WORKER_ENABLED==='true';
const controller=new AbortController();
if(enabled){
  if(!process.env.WORKER_DATABASE_URL||!process.env.CAPTURE_POLICY_JSON||!process.env.DATABASE_SSL_CA_PEM){
    console.error('Cloud worker configuration missing');process.exit(1);
  }
  process.env.DATABASE_CA_FILE='/tmp/sigongnote-db-ca.pem';
  writeFileSync(process.env.DATABASE_CA_FILE,process.env.DATABASE_SSL_CA_PEM,{mode:0o600});
  if(process.env.WORKER_HEARTBEAT_FILE)rmSync(process.env.WORKER_HEARTBEAT_FILE,{force:true});
}
async function supervise(name,file){
  await superviseChild({file,env:cloudChildEnvironment(name),signal:controller.signal,onExit(){
    if(name==='Worker'&&process.env.WORKER_HEARTBEAT_FILE)rmSync(process.env.WORKER_HEARTBEAT_FILE,{force:true});
    if(!controller.signal.aborted)console.error(`${name} stopped; restarting`);
  }});
}
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{
  controller.abort();
});
await Promise.all([supervise('API','services/api/dist/production.js'),...(enabled?[supervise('Worker','services/api/dist/worker-main.js')]:[])]);
