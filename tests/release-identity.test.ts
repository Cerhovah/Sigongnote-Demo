import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import postgres from 'postgres';
import {releaseIdentity} from '../services/api/src/release.js';
import {createProductionApp} from '../services/api/src/production-app.js';
import {loadLocalApiConfig} from '../services/api/src/config.js';
import {verifyLocalDevelopmentDb} from '../scripts/db-gate.mjs';

test('N31a production readiness rejects missing, malformed and dirty releases with live DB',async()=>{
 assert.equal((await verifyLocalDevelopmentDb()).status,'READY');
 const folder=await mkdtemp(join(tmpdir(),'sigongnote-release-identity-')),file=pathToFileURL(join(folder,'release.json'));
 const db=postgres(loadLocalApiConfig().databaseUrl,{max:1,connection:{statement_timeout:15000}});
 const app=createProductionApp({db,verifyToken:async()=>null},file),previous=process.env.APP_ENV;
 const valid={schema:1,source_sha:'a'.repeat(40),archive_sha256:'b'.repeat(64),migration_hash:'c'.repeat(64),migrations:['20260928041730'],source_dirty:false};
 try{
  process.env.APP_ENV='production';
  const check=async(status:string,http:number)=>{assert.equal(releaseIdentity(file).status,status);const response=await app.inject('/health/ready');assert.equal(response.statusCode,http);assert.equal(response.json().database,'ready');const identity=await app.inject('/health/release');assert.equal(identity.json().status,status);assert.equal(identity.headers['cache-control'],'no-store');assert.equal((await app.inject('/health/live')).statusCode,200);};
  await check('unverified',503);
  for(const content of ['{',JSON.stringify({...valid,schema:2}),JSON.stringify({...valid,migrations:[]}),JSON.stringify({...valid,migrations:[1]}),JSON.stringify({...valid,source_sha:'HEAD'}),JSON.stringify({...valid,migration_hash:'bad'}),JSON.stringify({...valid,source_dirty:'false'})]){await writeFile(file,content);await check('unverified',503);}
  await writeFile(file,JSON.stringify({...valid,source_dirty:true}));await check('modified',503);
  await writeFile(file,JSON.stringify(valid));await check('identified',200);assert.equal(releaseIdentity(file).archive_sha256,valid.archive_sha256);
  // Local clean builds have no archive proof; deployment verification separately requires it.
  await writeFile(file,JSON.stringify({...valid,archive_sha256:'invalid'}));assert.equal(releaseIdentity(file).archive_sha256,null);await check('identified',503);
 }finally{if(previous===undefined)delete process.env.APP_ENV;else process.env.APP_ENV=previous;await app.close();await db.end();await rm(folder,{recursive:true,force:true});}
});
