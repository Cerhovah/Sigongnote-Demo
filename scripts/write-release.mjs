import {readFileSync,readdirSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export function assertReleaseArchive(archive,sourceSha,expected){
 const archiveHash=createHash('sha256').update(archive).digest('hex');
 if(!/^[a-f0-9]{64}$/.test(expected??'')||archiveHash!==expected||archive.subarray(0,17).toString()!=='pax_global_header'||!archive.subarray(512,1024).toString().includes(` comment=${sourceSha}\n`))throw Error('RELEASE_ARCHIVE_MISMATCH');
 return archiveHash;
}
export function writeRelease(supplied,expected){
const sourceSha=supplied??execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(!/^[a-f0-9]{40}$/.test(sourceSha))throw Error('RELEASE_SHA_REQUIRED');
let dirty=true;let archiveHash=null;
if(existsSync('.git')){
 if(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()!==sourceSha)throw Error('RELEASE_SHA_MISMATCH');
 dirty=execFileSync('git',['status','--porcelain','--','services','apps/web','packages','scripts','trade-packs','supabase/migrations','package.json','package-lock.json','tsconfig.json'],{encoding:'utf8'}).trim().length>0;
}else{
 // Docker's source stage extracts this same archive; a bare caller-supplied SHA
 // is never enough to identify a build without Git metadata.
 archiveHash=assertReleaseArchive(readFileSync('/tmp/sigongnote-source.tar'),sourceSha,expected);
 dirty=false;
}
const migrations=readdirSync('supabase/migrations').filter(p=>/^\d+_.+\.sql$/.test(p)).sort();
const digest=createHash('sha256');for(const name of migrations){digest.update(name);digest.update(readFileSync('supabase/migrations/'+name));}
writeFileSync('services/api/dist/release.json',JSON.stringify({schema:1,source_sha:sourceSha,source_dirty:dirty,archive_sha256:archiveHash,migrations:migrations.map(n=>n.split('_')[0]),migration_hash:digest.digest('hex'),built_at:new Date().toISOString()}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)writeRelease(process.argv[2],process.argv[3]);
