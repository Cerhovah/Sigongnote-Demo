import {readFileSync} from 'node:fs';
export function releaseIdentity(file:URL=new URL('./release.json',import.meta.url)){
 try{const r=JSON.parse(readFileSync(file,'utf8'));if(r.schema!==1||!/^[a-f0-9]{40}$/.test(r.source_sha)||!/^[a-f0-9]{64}$/.test(r.migration_hash)||!Array.isArray(r.migrations)||!r.migrations.length||!r.migrations.every((m:unknown)=>typeof m==='string'&&/^\d{14}$/.test(m))||typeof r.source_dirty!=='boolean')throw Error('INVALID_RELEASE');
  return {status:r.source_dirty?'modified':'identified',source_sha:r.source_sha as string,archive_sha256:typeof r.archive_sha256==='string'&&/^[a-f0-9]{64}$/.test(r.archive_sha256)?r.archive_sha256:null,migration_hash:r.migration_hash as string,migrations:r.migrations as string[],source_dirty:r.source_dirty as boolean};
 }catch{return {status:'unverified',source_sha:null,archive_sha256:null,migration_hash:null,migrations:[] as string[],source_dirty:null};}
}
