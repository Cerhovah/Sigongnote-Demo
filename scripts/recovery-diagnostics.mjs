// Publish only fixed recovery stages and classifications, never exception messages or tool output.
import {constants,openSync,closeSync,lstatSync,fstatSync,readSync} from 'node:fs';
export const recoveryDiagnosticPrefix='SIGONGNOTE_RECOVERY_DIAGNOSTIC ';
const stages=new Set(['LOCAL_GATE','READ_LOCAL_CONFIG','SCHEMA_DUMP','CREATE_DATABASE','RESTORE_SCHEMA',
 'SEED_MIGRATIONS','SEED_IDENTITY','SEED_CORE','SEED_STORAGE','SEED_LEARNING','SEED_IMPROVEMENT',
 'SEED_DELIVERY','SEED_STRATEGY','RECOVERY_DRILL','CLEANUP_STORAGE','CLEANUP_CONNECTION',
 'CLEANUP_DATABASE','CLEANUP_ADMIN','UNKNOWN_STAGE']);
const sqlstates=new Set(['08000','08001','08003','08004','08006','08007','08P01','22001','22003','22007',
 '22008','22023','22P02','23502','23503','23505','23514','23P01','25001','25P02','28000','28P01',
 '2BP01','3D000','3F000','40001','40P01','42501','42601','42701','42703','42704','42710','42804',
 '42883','42P01','42P04','42P06','42P07','42P13','53000','53100','53200','53300','53400','55000',
 '55P03','57014','57P01','57P02','57P03','58000','58030','P0001','P0002','P0003','XX000','XX001','XX002']);
const codes=new Set(['RECOVERY_TOOL_FAILED','RECOVERY_TOOL_UNAVAILABLE','LOCAL_REQUIRED','LOCAL_DB_REQUIRED',
 'LOCAL_PROJECT_REQUIRED','SYNTHETIC_STORAGE_FAILED','INVALID_RECOVERY_SOURCE','RECOVERY_SNAPSHOT_FAILED',
 'RECOVERY_OBJECT_MISSING','RECOVERY_OBJECT_TOO_LARGE','RECOVERY_OBJECT_CHANGED','RECOVERY_SOURCE_REFERENCES_INVALID',
 'RECOVERY_ORIGINALS_MISSING','RECOVERY_DUMP_CHANGED','RECOVERY_ROWS_DIFFER','RECOVERY_RESTORED_OBJECT_CHANGED',
 'RECOVERY_TENANT_LEAK','RECOVERY_POSITIVE_FIXTURE_MISSING','RECOVERY_DELETED_LEARNING_CONTENT',
 'RECOVERY_OWNER_VISIBILITY_DIFFERS','RECOVERY_OWNER_POSITIVE_MISSING','RECOVERY_TARGET_SCOPE',
 'RECOVERY_IMAGE_REQUIRED','RECOVERY_CONTAINER_ID','RECOVERY_CLUSTER_NOT_READY','RECOVERY_ISOLATED_ROWS_DIFFER',
 'RECOVERY_ROLE_PRIVILEGE','RECOVERY_EFFECT_FENCE','RECOVERY_CLEANUP_SCOPE','ENOENT','EACCES','EPERM','ENOSPC',
 'WINDOWS_KEY_PROTECTION_REQUIRED','LOCAL_KEY_PROTECTION_FAILED','INVALID_LOCAL_KEY','COPY_CORRUPT',
 'SYNTHETIC_RECOVERY_PROTECTION_FORBIDDEN','POSTGRES_ERROR','RECOVERY_ERROR']);

export function attachRecoveryDiagnostic(error,stage){
 const value=error&&typeof error==='object'?error:{};
 const sqlstate=sqlstates.has(value.code)?value.code:null;
 const code=sqlstate?'POSTGRES_ERROR':codes.has(value.message)&&value.message!=='POSTGRES_ERROR'?value.message:codes.has(value.code)&&value.code!=='POSTGRES_ERROR'?value.code:'RECOVERY_ERROR';
 const diagnostic={stage:stages.has(stage)?stage:'UNKNOWN_STAGE',code,sqlstate};
 // Preserve the same rejection object, message and original SQLSTATE for existing callers.
 if(error&&typeof error==='object')try{Object.defineProperty(error,'recovery_diagnostic',{value:diagnostic,enumerable:false,configurable:true});}catch{/* Frozen exceptions still have a finite side diagnostic. */}
 return diagnostic;
}
function valid(value){
 return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===3&&
  ['stage','code','sqlstate'].every(key=>Object.hasOwn(value,key))&&stages.has(value.stage)&&codes.has(value.code)&&
  (value.code==='POSTGRES_ERROR'?sqlstates.has(value.sqlstate):value.sqlstate===null);
}
export function recoveryDiagnosticLine(value){
 if(!valid(value))throw Error('INVALID_RECOVERY_DIAGNOSTIC');
 return recoveryDiagnosticPrefix+JSON.stringify({stage:value.stage,code:value.code,sqlstate:value.sqlstate});
}
/** These are observed recovery errors, including expected rejections; they are not automatically the root cause. */
export function collectRecoveryDiagnostics(...channels){
 const found=new Map();
 for(const text of channels){if(typeof text!=='string')continue;
  for(const match of text.matchAll(/^\s*(?:#\s*)?SIGONGNOTE_RECOVERY_DIAGNOSTIC (\{[^\r\n]{1,512}\})\r?$/gm)){
   let value;try{value=JSON.parse(match[1]);}catch{continue;}if(!valid(value))continue;
   const diagnostic={stage:value.stage,code:value.code,sqlstate:value.sqlstate};found.set(JSON.stringify(diagnostic),diagnostic);
   if(found.size>=32)return [...found.values()];
  }
 }
 return [...found.values()];
}

/** Known English pg_dump/pg_restore error families only. No captured text leaves this function. */
export function classifyRecoveryToolError(text){
 if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>65536)return [];
 const found=new Set();
 for(const line of text.split(/\r?\n/)){
  const header=/^(?:pg_(?:dump|restore):\s+error:\s+|(?:ERROR|FATAL):\s+)(.+)$/i.exec(line.trim());
  if(!header)continue;
  const message=header[1].replace(/^(?:could not execute query|query failed):\s+(?:ERROR|FATAL):\s+/i,'');
  const type=/^(?:permission denied\b|must be (?:owner|superuser)\b|only superusers (?:can|may)\b)/i.test(message)?'PERMISSION_DENIED':
   /^role\b.+\bdoes not exist\s*$/i.test(message)?'ROLE_MISSING':
   /^(?:extension\b.+\bis not available\b|could not open extension control file\b)/i.test(message)?'EXTENSION_UNAVAILABLE':
   /^unrecognized configuration parameter\b/i.test(message)?'CONFIG_UNSUPPORTED':
   /^(?:unsupported version\b.+\bin file header\b|archive is too short\b|did not find magic string in file header\b|aborting because of server version mismatch\b|input file appears to be a text format dump\b)/i.test(message)?'ARCHIVE_VERSION':
   /^can only create extension in database\b/i.test(message)?'CRON_DATABASE_ONLY':
   /^(?:relation|schema|type|function|operator|extension|table|index|constraint)\b.+\balready exists\b/i.test(message)?'OBJECT_EXISTS':null;
  if(type)found.add(type);
 }
 return [...found];
}
/** A fixed-path caller may read at most 64 KiB from the current child window; never return the body. */
export function readCurrentRecoveryToolDiagnostic(file,childStartedMs,childEndedMs){
 const result=status=>({status,types:[]});
 if(!Number.isFinite(childStartedMs)||!Number.isFinite(childEndedMs)||childStartedMs>childEndedMs)return result('INVALID_WINDOW');
 let fd,buffer;
 try{
  const before=lstatSync(file);
  if(before.isSymbolicLink()||!before.isFile())return result('NOT_REGULAR');
  if(before.size>65536)return result('TOO_LARGE');
  if(before.mtimeMs<childStartedMs||before.mtimeMs>childEndedMs)return result('NOT_CURRENT');
  if(before.size===0)return result('EMPTY');
  fd=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
  const opened=fstatSync(fd);if(!opened.isFile()||!same(before,opened))return result('CHANGED');
  buffer=Buffer.alloc(65537);const size=readSync(fd,buffer,0,buffer.length,0),after=fstatSync(fd),latest=lstatSync(file);
  if(size>65536)return result('TOO_LARGE');
  if(size!==opened.size||latest.isSymbolicLink()||!latest.isFile()||!same(opened,after)||!same(after,latest))return result('CHANGED');
  const types=classifyRecoveryToolError(buffer.subarray(0,size).toString('utf8'));
  return {status:types.length?'CLASSIFIED':'UNCLASSIFIED',types};
 }catch{return result('READ_UNAVAILABLE');}
 finally{buffer?.fill(0);if(fd!==undefined)try{closeSync(fd);}catch{/* No path or tool output may escape a diagnostic read. */}}
}
