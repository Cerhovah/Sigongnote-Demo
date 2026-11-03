import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
/** Private pipes only. Tool failures never include dump contents or credentials in public output. */
export async function recoveryCommand(args:string[],input?:Uint8Array):Promise<Buffer>{
 return new Promise((ok,no)=>{const p=spawn('docker',args,{windowsHide:true,stdio:['pipe','pipe','pipe']});const chunks:Buffer[]=[];let size=0;const errors:Buffer[]=[];const timer=setTimeout(()=>p.kill(),120000);p.stdout.on('data',(b:Buffer)=>{size+=b.length;if(size>512*1024*1024)p.kill();else chunks.push(b);});p.stderr.on('data',(b:Buffer)=>{if(errors.reduce((n,v)=>n+v.length,0)<65536)errors.push(b);});p.on('error',()=>{clearTimeout(timer);no(Error('RECOVERY_TOOL_UNAVAILABLE'));});p.on('close',code=>{clearTimeout(timer);if(code===0)ok(Buffer.concat(chunks));else void writeFile('.work/recovery-tool-error.log',Buffer.concat(errors),{mode:0o600}).finally(()=>no(Error('RECOVERY_TOOL_FAILED')));});p.stdin.on('error',()=>{});p.stdin.end(input);});
}
