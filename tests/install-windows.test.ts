import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,symlink} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve,sep} from 'node:path';import {createHash} from 'node:crypto';import {spawnSync} from 'node:child_process';
import {finiteInstallerDiagnostic} from '../scripts/run-unit.mjs';

const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
// Avoid injecting the parent PS7 module search path into the Setup runtime; PS5 rebuilds its own defaults.
const windowsPowerShellEnvironment=()=>Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toLowerCase()!=='psmodulepath'));
// Setup launches Windows PowerShell; manifest generation remains a PowerShell 7 build step.
const runCommand=(file:string,args:string[],localAppData:string)=>{const installer=file==='install-windows-client.ps1';return spawnSync(installer?'powershell.exe':'pwsh',['-NoProfile',...(installer?['-NonInteractive','-ExecutionPolicy','Bypass']:[]),'-File',resolve('scripts',file),...args],{encoding:'utf8',windowsHide:true,timeout:30000,env:{...(installer?windowsPowerShellEnvironment():process.env),LOCALAPPDATA:localAppData}});};
async function installationFixture(label:string){
 const root=await mkdtemp(join(tmpdir(),'sigongnote-install-path-')),pack=join(root,label,'package'),install=join(root,label,'apps'),local=join(root,'profile'),state=join(local,'Sigongnote');
 await mkdir(pack,{recursive:true});await mkdir(install,{recursive:true});await mkdir(state,{recursive:true});
 await writeFile(join(pack,'Sigongnote.Windows.exe'),'synthetic executable never run');await writeFile(join(pack,'libstdc++-6.dll'),'synthetic dependency never run');await writeFile(join(state,'account-marker'),'synthetic protected account and queue');
 const run=(file:string,args:string[])=>runCommand(file,args,local);
 const manifest=run('write-install-manifest.ps1',['-Directory',pack,'-Version','test1']);assert.equal(manifest.status,0,JSON.stringify(finiteInstallerDiagnostic('MANIFEST_FIRST',manifest)));
 const sha=digest(await readFile(join(pack,'install-manifest.json'))),marker=digest(await readFile(join(state,'account-marker')));
 const invoke=(packagePath=pack,installPath=install,hash=sha)=>run('install-windows-client.ps1',['-PackageDirectory',packagePath,'-ExpectedManifestSha256',hash,'-InstallRoot',installPath,'-NoShortcut']);
 return {root,pack,install,local,state,sha,marker,invoke,async unchanged(){assert.equal(digest(await readFile(join(state,'account-marker'))),marker);},async close(){await rm(root,{recursive:true,force:true});}};
}
function shortPaths(first:string,second:string){
 const script=`Add-Type -TypeDefinition 'using System;using System.Text;using System.Runtime.InteropServices;public static class InstallAliasProbe { [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] public static extern uint GetShortPathName(string p,StringBuilder b,uint n); }';function Short([string]$p){$b=[Text.StringBuilder]::new(32768);$n=[InstallAliasProbe]::GetShortPathName($p,$b,32768);if($n -gt 0){$b.ToString()}else{$null}};@{first=(Short $env:SIGONGNOTE_ALIAS_FIRST);second=(Short $env:SIGONGNOTE_ALIAS_SECOND)}|ConvertTo-Json -Compress`;
 const r=spawnSync('pwsh',['-NoProfile','-Command',script],{encoding:'utf8',windowsHide:true,timeout:10000,env:{...process.env,SIGONGNOTE_ALIAS_FIRST:first,SIGONGNOTE_ALIAS_SECOND:second}});
 assert.equal(r.status,0,'SHORT_ALIAS_PROBE_FAILED');const value=JSON.parse(r.stdout) as {first:string|null;second:string|null};
 assert.ok(value.first&&value.second&&value.first.includes('~'),'SHORT_ALIAS_REQUIRED');return {first:value.first,second:value.second};
}

for(const host of ['powershell.exe','pwsh'])test('I canonical installer roots are preserved in '+host,{skip:process.platform!=='win32'},()=>{
 const script=`$ErrorActionPreference='Stop';$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($env:SIGONGNOTE_INSTALL_SCRIPT,[ref]$tokens,[ref]$errors);if($errors.Count){throw 'INSTALL_SCRIPT_PARSE_FAILED'};$definition=$ast.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-CanonicalInstallPath'},$true);if(!$definition){throw 'INSTALL_PATH_FUNCTION_MISSING'};Invoke-Expression $definition.Extent.Text;$root=[IO.Path]::GetPathRoot($env:SIGONGNOTE_PATH_PROBE);$canonical=Get-CanonicalInstallPath $env:SIGONGNOTE_PATH_PROBE;[pscustomobject]@{root_preserved=((Get-CanonicalInstallPath $root) -eq $root);repeated_root_preserved=((Get-CanonicalInstallPath ($root+[IO.Path]::DirectorySeparatorChar)) -eq $root);trailing_normalized=((Get-CanonicalInstallPath ($env:SIGONGNOTE_PATH_PROBE+[IO.Path]::DirectorySeparatorChar)) -eq $canonical);runtime_major=$PSVersionTable.PSVersion.Major}|ConvertTo-Json -Compress`;
 const result=spawnSync(host,['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:10000,env:{...process.env,SIGONGNOTE_INSTALL_SCRIPT:resolve('scripts/install-windows-client.ps1'),SIGONGNOTE_PATH_PROBE:tmpdir()}});
 assert.equal(result.status,0,'INSTALL_PATH_RUNTIME_PROBE_FAILED');const report=JSON.parse(result.stdout);assert.equal(report.root_preserved,true);assert.equal(report.repeated_root_preserved,true);assert.equal(report.trailing_normalized,true);if(host==='powershell.exe')assert.equal(report.runtime_major,5);
});
test('D19 side-by-side installer checks trusted hashes, preserves prior versions and rejects traversal',{skip:process.platform!=='win32'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'sigongnote-install-')),pack=join(root,'package'),install=join(root,'apps');await mkdir(pack);await writeFile(join(pack,'Sigongnote.Windows.exe'),'synthetic executable, never run');
 await writeFile(join(pack,'libstdc++-6.dll'),'synthetic parser dependency, never run');
 const run=(file:string,args:string[])=>runCommand(file,args,join(root,'profile'));
 try{
  for(const version of ['test1','test2']){
   const manifestResult=run('write-install-manifest.ps1',['-Directory',pack,'-Version',version]);
   assert.equal(manifestResult.status,0,JSON.stringify(finiteInstallerDiagnostic(version==='test1'?'MANIFEST_FIRST':'MANIFEST_SECOND',manifestResult)));
   const sha=createHash('sha256').update(await readFile(join(pack,'install-manifest.json'))).digest('hex');
   const args=['-PackageDirectory',pack,'-ExpectedManifestSha256',sha,'-InstallRoot',install,'-NoShortcut'];
   // Simulate process death during copy: an incomplete staging directory must not block retry.
   const abandoned=join(install,version+'-'+sha.slice(0,12)+'.staging-interrupted');await mkdir(abandoned,{recursive:true});await writeFile(join(abandoned,'Sigongnote.Windows.exe'),'partial');
   const result=run('install-windows-client.ps1',args);assert.equal(result.status,0,JSON.stringify(finiteInstallerDiagnostic(version==='test1'?'INSTALL_FIRST':'INSTALL_SECOND',result)));assert.equal(JSON.parse(result.stdout).accountAndQueue,'preserved');
   const retry=run('install-windows-client.ps1',args);assert.equal(retry.status,0,JSON.stringify(finiteInstallerDiagnostic(version==='test1'?'RETRY_FIRST':'RETRY_SECOND',retry)));
   assert.equal(await readFile(join(abandoned,'Sigongnote.Windows.exe'),'utf8'),'partial','interrupted staging is preserved');
  }
  assert.equal((await readdir(install)).length,4);
  await writeFile(join(pack,'Sigongnote.Windows.exe'),'changed');
  const manifest=JSON.parse(await readFile(join(pack,'install-manifest.json'),'utf8'));manifest.version='test3';manifest.files[0].path='../escape.exe';await writeFile(join(pack,'install-manifest.json'),JSON.stringify(manifest));
  const sha=createHash('sha256').update(await readFile(join(pack,'install-manifest.json'))).digest('hex');const refused=run('install-windows-client.ps1',['-PackageDirectory',pack,'-ExpectedManifestSha256',sha,'-InstallRoot',install,'-NoShortcut']);const diagnostic=JSON.stringify(finiteInstallerDiagnostic('REJECT_TRAVERSAL',refused));assert.notEqual(refused.status,null,diagnostic);assert.notEqual(refused.status,0,diagnostic);assert.equal((await readdir(install)).length,4);
 }finally{await rm(root,{recursive:true,force:true});}
});

for(const variant of ['CANONICAL','SPACES','SHORT_ALIASES','LONG_PACKAGE_SHORT_INSTALL','TRAILING_SEPARATORS','FORWARD_SLASHES'])test('I normalized installer path '+variant,{skip:process.platform!=='win32'},async()=>{
 const f=await installationFixture(variant==='SPACES'?'path with spaces':'path');
 try{
  let pack=f.pack,install=f.install;
  if(variant==='SHORT_ALIASES'||variant==='LONG_PACKAGE_SHORT_INSTALL'){const aliases=shortPaths(pack,install);if(variant==='SHORT_ALIASES')pack=aliases.first;install=aliases.second;}
  if(variant==='TRAILING_SEPARATORS'){pack+=sep;install+=sep;}
  if(variant==='FORWARD_SLASHES'){pack=pack.replaceAll('\\','/');install=install.replaceAll('\\','/');}
  const result=f.invoke(pack,install);assert.equal(result.status,0,JSON.stringify(finiteInstallerDiagnostic('INSTALL_FIRST',result)));const report=JSON.parse(result.stdout);assert.equal(report.accountAndQueue,'preserved');assert.equal(report.launched,false);await f.unchanged();
 }finally{await f.close();}
});

for(const variant of ['STATE_CANONICAL','STATE_SHORT_ALIAS','STATE_SHORT_ALIAS_CHILD','TAMPERED_PACKAGE','REPARSE_PACKAGE'])test('I installer preserves protected data and rejects '+variant,{skip:process.platform!=='win32'},async()=>{
 const f=await installationFixture('path');
 try{
  let target=f.install,hash=f.sha,expected='Install directory must be separate from account and queue data';
  if(variant==='STATE_CANONICAL')target=f.state;
  if(variant==='STATE_SHORT_ALIAS')target=shortPaths(f.state,f.state).first;
  if(variant==='STATE_SHORT_ALIAS_CHILD'){const nested=join(f.state,'child install');await mkdir(nested);target=shortPaths(nested,nested).first;}
  if(variant==='TAMPERED_PACKAGE'){await writeFile(join(f.pack,'Sigongnote.Windows.exe'),'changed synthetic executable');expected='Package file is incomplete or changed';}
  if(variant==='REPARSE_PACKAGE'){
   const outside=join(f.root,'outside');await mkdir(outside);await writeFile(join(outside,'external.dll'),'synthetic linked dependency');await symlink(outside,join(f.pack,'linked'),'junction');
   const file=join(f.pack,'install-manifest.json'),manifest=JSON.parse(await readFile(file,'utf8'));manifest.files.push({path:'linked/external.dll',sha256:digest(await readFile(join(outside,'external.dll')))});await writeFile(file,JSON.stringify(manifest));hash=digest(await readFile(file));expected='Linked paths cannot be installed';
  }
  const result=f.invoke(f.pack,target,hash);assert.equal(result.status,1,JSON.stringify(finiteInstallerDiagnostic('INSTALL_FIRST',result)));assert.ok(result.stderr.includes(expected),'EXPECTED_INSTALL_GUARD_NOT_REACHED');await f.unchanged();
 }finally{await f.close();}
});
