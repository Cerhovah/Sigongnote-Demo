import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDemoServer} from './server.js';

const values=new Map<string,string>();for(let i=2;i<process.argv.length;i+=2){const name=process.argv[i],value=process.argv[i+1];if(!name?.startsWith('--')||!value)throw new Error('Usage: --data-dir <private folder> [--port 8770] [--static-dir <build folder>]');values.set(name,value);}
const dataDir=values.get('--data-dir')??process.env.SIGONGNOTE_DEMO_DATA_DIR;if(!dataDir)throw new Error('SIGONGNOTE_DEMO_DATA_DIR or --data-dir is required. Customer files stay outside the public repository.');
const port=Number(values.get('--port')??8770);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid port');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const app=await createDemoServer({dataDir,port,staticDir:values.get('--static-dir')??path.join(root,'apps/web/dist-demo')});
await app.listen({host:'127.0.0.1',port});console.log(`Sigongnote demo: http://127.0.0.1:${port}/`);
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{void app.close().then(()=>process.exit(0));});
