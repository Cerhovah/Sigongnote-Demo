/** H08 operator tool: private evidence files only, preview by default. No client can self-approve. */
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import postgres from 'postgres';
import {SmsActivationEvidence,smsActivation} from '../services/api/src/sms-activation.js';
import {parseStrictLocalEnv} from './local-env-values.mjs';
export async function changeSmsActivation(db:postgres.Sql,input:unknown,revoke=false,apply=false){
 const evidence=SmsActivationEvidence.parse(input);
 return db.begin(async tx=>{
  const [source]=await tx`select s.*,d.platform,d.active device_active from app.capture_sources s join app.devices d on d.tenant_id=s.tenant_id and d.id=s.device_id where s.tenant_id=${evidence.tenant_id}::uuid and s.id=${evidence.source_id}::uuid for update of s`;
  if(!source)throw Error('SMS_SOURCE_NOT_FOUND');
  // accepted_by is the independently identified reviewer in the evidence; DB operator credentials authorize this tool.
  if(revoke){if(!source.sms_activation||JSON.stringify(SmsActivationEvidence.parse(source.sms_activation))!==JSON.stringify(evidence))throw Error('SMS_EVIDENCE_CHANGED');
  }else if(!source.active||!source.device_active||!source.server_upload_consent||!smsActivation({...source,sms_activation:evidence}).ready)throw Error('SMS_EVIDENCE_SCOPE_INVALID');
  const next=revoke?{...evidence,revoked_at:new Date().toISOString()}:evidence;
  if(apply)await tx`update app.capture_sources set sms_activation=${tx.json(next)},version=version+1,updated_at=now() where tenant_id=${evidence.tenant_id}::uuid and id=${evidence.source_id}::uuid`;
  return {action:revoke?'revoke':'accept',applied:apply};
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const args=process.argv.slice(2),value=(flag:string)=>args[args.indexOf(flag)+1];
  if(!['accept','revoke'].includes(args[0]??'')||!args.includes('--evidence'))throw Error('Usage: accept|revoke --evidence private.json [--policy-file private --installer-file private] [--env-file private.env] [--apply]');
  const evidence=SmsActivationEvidence.parse(JSON.parse(await readFile(value('--evidence')!,'utf8')));
  if(args[0]==='accept')for(const [flag,key] of [['--policy-file','policy_evidence_sha256'],['--installer-file','installer_evidence_sha256']] as const){if(!args.includes(flag)||createHash('sha256').update(await readFile(value(flag)!)).digest('hex')!==evidence[key])throw Error('SMS_EVIDENCE_HASH_MISMATCH');}
  const env=parseStrictLocalEnv(await readFile(args.includes('--env-file')?value('--env-file')!:'services/api/.env','utf8'));
  const db=postgres(env.MIGRATION_DATABASE_URL!,{max:1,onnotice:()=>{}});try{console.log(JSON.stringify(await changeSmsActivation(db,evidence,args[0]==='revoke',args.includes('--apply'))));}finally{await db.end();}
 }catch{console.error('SMS activation not changed. Check private evidence, source scope, validity, and operator DB access.');process.exitCode=1;}
}
