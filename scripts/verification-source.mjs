import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

// Identify the actual tested source, including new source files but excluding private drafts and build output.
const names=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const files=[...new Set(names)].filter(p=>/^(apps|services|packages|scripts|supabase|tests|fixtures|docs|\.githooks)\//.test(p)||/^(package(?:-lock)?\.json|biome\.json|tsconfig\.json|AGENTS\.md|README\.md)$/.test(p)).sort();
const hash=createHash('sha256');
for(const file of files){
 hash.update(file);hash.update('\0');
 let bytes;try{bytes=readFileSync(file);}catch(error){if(error.code!=='ENOENT')throw error;hash.update('deleted\0');continue;}
 hash.update('present\0');hash.update(createHash('sha256').update(bytes).digest());
}
console.log(JSON.stringify({head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),source_sha256:hash.digest('hex'),source_files:files.length,working_tree_dirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).length>0}));
