import {existsSync,readdirSync,readFileSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,relative,resolve} from 'node:path';

// One catalog owns both the plain-PostgreSQL exclusions and the real local-Supabase CI selection.
export const SUPABASE_ONLY=new Map([
 ['tests/android-auth-refresh.test.ts','real Supabase Auth refresh rotation'],
 ['tests/capture-sources.test.ts','real Supabase Auth, Storage and capture-source revocation'],
 ['tests/local-env-integration.test.mjs','live local Supabase environment mismatch gate'],
 ['tests/recovery.test.ts','disposable-VM synthetic database and Storage restore'],
 ['tests/auth-devices.test.ts','real Supabase Auth session and device revocation'],
 ['tests/business-form-cycle.test.ts','document render worker and Storage'],
 ['tests/capture-durability.test.ts','Supabase Storage originals and reclamation'],
 ['tests/cloud-provision.test.ts','local Vault schema'],
 ['tests/document-compose-api.test.ts','actual parser and document Storage'],
 ['tests/document-draft-api.test.ts','document render worker and Storage'],
 ['tests/evidence-chunks.test.ts','Supabase Storage and evidence worker'],
 ['tests/evidence-migration.test.ts','Docker PostgreSQL recovery tooling'],
 ['tests/field-e2e.test.ts','device-local field metadata provenance is verified in the dedicated Supabase lane'],
 ['tests/first-site-setup.test.ts','real Supabase Auth/Storage services'],
 ['tests/ingestions.test.ts','private Supabase Storage upload'],
 ['tests/jobs.test.ts','Supabase Storage-backed jobs'],
 ['tests/long-audio.test.ts','Supabase Storage and actual local audio decoder'],
 ['tests/message-integration.test.ts','Supabase Storage and actual local message parser'],
 ['tests/parse-worker.test.ts','Supabase Storage and actual local Python parser'],
 ['tests/pdf-continuation.test.ts','Supabase Storage and actual local PDF parser'],
 ['tests/product-ai-migration.test.ts','Docker PostgreSQL recovery tooling'],
 ['tests/work-decisions-api.test.ts','Supabase Storage and actual local worker'],
]);
export const UNIT_PLATFORMS=new Map([['tests/install-windows.test.ts',['win32']]]);

const rootTest=/\.test\.(?:tsx?|mjs)$/;
const databaseMarker=/verifyLocalDevelopmentDb|processingFixture|isolatedProcessingDatabase/;
const sourceImport=/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.[^"']+)["']/g;

// Only tests/ helpers participate. Production imports never turn an in-memory API unit
// into a DB test, and neither credentials nor application environments are read here.
export function rootTestCatalog({root=process.cwd(),supabaseOnly=SUPABASE_ONLY,unitPlatforms=UNIT_PLATFORMS}={}){
 const testsRoot=resolve(root,'tests'),files=readdirSync(testsRoot).filter(n=>rootTest.test(n)).sort().map(n=>'tests/'+n);
 const source=new Map(),dependencies=new Map();
 const load=file=>{if(!source.has(file))source.set(file,readFileSync(resolve(root,file),'utf8'));return source.get(file);};
 const helpers=file=>{
  if(dependencies.has(file))return dependencies.get(file);
  const result=[];
  for(const match of load(file).matchAll(sourceImport)){
   const candidate=resolve(root,dirname(file),match[1]);
   const within=relative(testsRoot,candidate);if(within.startsWith('..')||isAbsolute(within))continue;
   const candidates=/\.js$/.test(candidate)?[candidate.slice(0,-3)+'.ts',candidate.slice(0,-3)+'.tsx',candidate.slice(0,-3)+'.mjs',candidate]:[candidate,candidate+'.ts',candidate+'.tsx',candidate+'.mjs'];
   const found=candidates.find(path=>existsSync(path));if(!found)throw new Error(`Missing test dependency: ${file}`);
   const actual=relative(testsRoot,realpathSync(found));if(actual.startsWith('..')||isAbsolute(actual))throw new Error(`Test dependency leaves tests directory: ${file}`);
   result.push('tests/'+actual.replaceAll('\\','/'));
  }
  dependencies.set(file,result);return result;
 };
 const closure=file=>{const seen=new Set();const visit=current=>{if(seen.has(current))return;seen.add(current);for(const helper of helpers(current))visit(helper);};visit(file);return [...seen];};
 for(const file of supabaseOnly.keys())if(!files.includes(file))throw new Error(`Supabase test catalog is stale: ${file}`);
 for(const file of unitPlatforms.keys())if(!files.includes(file))throw new Error(`Platform test catalog is stale: ${file}`);
 const entries=files.map(file=>{
  const sources=closure(file);
  const reason=supabaseOnly.get(file)??(sources.some(name=>/@supabase\/supabase-js/.test(load(name)))?'Supabase Auth/Storage client':null);
  const lane=reason?'supabase':sources.some(name=>databaseMarker.test(load(name)))?'plain':'unit';
  if(unitPlatforms.has(file)&&lane!=='unit')throw new Error(`Platform test must remain in the unit lane: ${file}`);
  return {file,lane,...(reason?{reason}:{}),...(unitPlatforms.has(file)?{platforms:unitPlatforms.get(file)}:{}),dependencies:sources.filter(name=>name!==file)};
 });
 const unit=entries.filter(item=>item.lane==='unit').map(item=>item.file),plain=entries.filter(item=>item.lane==='plain').map(item=>item.file),supabase=entries.filter(item=>item.lane==='supabase').map(({file,reason})=>({file,reason}));
 if(new Set([...unit,...plain,...supabase.map(item=>item.file)]).size!==files.length)throw new Error('Test lanes are not a complete disjoint partition');
 return {all:files,unit,plain,supabase,entries};
}

export function selectUnitTests(catalog,{platform=process.platform,platformOnly=false}={}){
 const unit=catalog.entries.filter(item=>item.lane==='unit');
 const not_run=unit.filter(item=>item.platforms&&!item.platforms.includes(platform)).map(item=>({file:item.file,status:'NOT_RUN',reason:'PLATFORM_NOT_SUPPORTED',required_platforms:item.platforms,current_platform:platform}));
 const files=unit.filter(item=>(!platformOnly||item.platforms)&&(!item.platforms||item.platforms.includes(platform))).map(item=>item.file);
 return {files,not_run,platform,mode:platformOnly?'platform_only':'all_compatible',outside_scope_count:platformOnly?unit.filter(item=>!item.platforms).length:0};
}

export function databaseTestCatalog(){
 const catalog=rootTestCatalog();
 return {...catalog,all:catalog.entries.filter(item=>item.lane!=='unit').map(item=>item.file)};
}
