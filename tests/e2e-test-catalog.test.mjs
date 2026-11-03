import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {rootTestCatalog,selectUnitTests} from '../scripts/e2e-test-catalog.mjs';
import {summarizeUnitResult,collectUnitFailures,finiteInstallerDiagnostic} from '../scripts/run-unit.mjs';
import {supabaseFixtureEnvironment} from '../scripts/supabase-fixture-scope.mjs';

test('every root test is selected exactly once and nested fixtures stay in their real execution lane',()=>{
 const catalog=rootTestCatalog(),root=readdirSync('tests').filter(name=>/\.test\.(?:tsx?|mjs)$/.test(name)).map(name=>'tests/'+name).sort();
 const selected=[...catalog.unit,...catalog.plain,...catalog.supabase.map(item=>item.file)];
 assert.deepEqual([...selected].sort(),root);assert.equal(new Set(selected).size,root.length);
 for(const file of ['deliveries','improvement-api','photo-groups','photo-sheets'])assert.ok(catalog.plain.includes(`tests/${file}.test.ts`));
 assert.ok(catalog.plain.includes('tests/cloud-migration.test.ts'));assert.ok(!catalog.unit.includes('tests/cloud-migration.test.ts'));
 for(const file of ['tests/android-auth-refresh.test.ts','tests/capture-sources.test.ts','tests/local-env-integration.test.mjs','tests/recovery.test.ts'])assert.ok(catalog.supabase.some(item=>item.file===file));
 assert.ok(catalog.unit.includes('tests/local-env.test.mjs'));assert.ok(catalog.unit.includes('tests/e2e-test-catalog.test.mjs'));
 const listed=spawnSync(process.execPath,['scripts/run-unit.mjs','--list'],{encoding:'utf8'});assert.equal(listed.status,0);assert.deepEqual(JSON.parse(listed.stdout).files,selectUnitTests(catalog).files);
 const workflow=readFileSync('.github/workflows/e2e.yml','utf8');assert.match(workflow,/run: node scripts\/run-unit\.mjs/);assert.doesNotMatch(workflow,/tests\/claude-runtime\.test\.ts tests\/local-agent/);
});

test('catalog follows only test helpers, handles cycles, includes explicit mjs integration and rejects missing selection',()=>{
 const root=mkdtempSync(join(tmpdir(),'sigongnote-catalog-'));mkdirSync(join(root,'tests'));mkdirSync(join(root,'services'));
 const put=(file,content)=>writeFileSync(join(root,file),content);
 const statement=(file)=>['im','port'].join('')+` '${file}';`;
 try{
  put('tests/ordinary.test.ts',statement('../services/production.js'));
  put('services/production.js',['verify','LocalDevelopmentDb'].join(''));
  put('tests/nested.test.ts',statement('./outer.js'));put('tests/outer.ts',statement('./inner.js'));
  put('tests/inner.ts',statement('./outer.js')+['processing','Fixture'].join(''));
  put('tests/auth.test.mjs','');put('tests/ordinary.test.tsx','');
  const explicit=new Map([['tests/auth.test.mjs','actual Auth']]);const catalog=rootTestCatalog({root,supabaseOnly:explicit,unitPlatforms:new Map()});
  assert.deepEqual(catalog.plain,['tests/nested.test.ts']);assert.deepEqual(catalog.unit,['tests/ordinary.test.ts','tests/ordinary.test.tsx']);assert.deepEqual(catalog.supabase,[{file:'tests/auth.test.mjs',reason:'actual Auth'}]);
  assert.throws(()=>rootTestCatalog({root,supabaseOnly:new Map([['tests/missing.test.ts','missing']]),unitPlatforms:new Map()}),/catalog is stale/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('Windows-only unit remains one catalog entry, is explicit NOT_RUN on Linux, and runs in its Windows job',()=>{
 const catalog=rootTestCatalog(),file='tests/install-windows.test.ts';
 const linux=selectUnitTests(catalog,{platform:'linux'}),windows=selectUnitTests(catalog,{platform:'win32',platformOnly:true});
 assert.ok(catalog.unit.includes(file));assert.ok(!linux.files.includes(file));assert.deepEqual(linux.not_run,[{file,status:'NOT_RUN',reason:'PLATFORM_NOT_SUPPORTED',required_platforms:['win32'],current_platform:'linux'}]);
 assert.deepEqual(windows.files,[file]);assert.deepEqual(windows.not_run,[]);assert.equal(windows.outside_scope_count,catalog.unit.length-1);
 const directory=mkdtempSync(join(tmpdir(),'sigongnote-platform-skip-'));
 try{
  const fixture=join(directory,'off-platform.test.mjs');writeFileSync(fixture,"import {test} from 'node:test';test('off-platform guard',{skip:true},()=>{});\n");
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const skipped=spawnSync(process.execPath,['--test','--test-reporter=tap',fixture],{encoding:'utf8',env});assert.equal(skipped.status,0);
  const summary=summarizeUnitResult(skipped);assert.equal(summary.counts.skipped,1);assert.equal(summary.status,'FAIL','a real Node SKIP result cannot be counted as success');
 }finally{rmSync(directory,{recursive:true,force:true});}
 const workflow=readFileSync('.github/workflows/device.yml','utf8');assert.match(workflow,/run: node scripts\/run-unit\.mjs --platform-only/);assert.match(workflow,/path: \.work\/e2e\/unit-platform-test-scope\.json/);
});

test('unit runner never calls a skipped, missing, timed-out or failing execution a pass',()=>{
 const stdout='# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
 assert.equal(summarizeUnitResult({status:0,stdout}).status,'PASS');
 for(const result of [{status:1,stdout},{status:0,stdout:''},{status:0,stdout:stdout.replace('# pass 2','# pass 1').replace('# skipped 0','# skipped 1')},{status:null,stdout,error:{code:'ETIMEDOUT'}}])assert.equal(summarizeUnitResult(result).status,'FAIL');
});

test('finite failure diagnostics keep Windows/POSIX anchors and command classes without source, credentials or raw stderr',()=>{
 const file='tests/install-windows.test.ts';
 const diagnostic=finiteInstallerDiagnostic('MANIFEST_FIRST',{status:1,stderr:'PSSecurityException: private command output'});
 assert.deepEqual(diagnostic,{stage:'MANIFEST_FIRST',exit_code:1,process_code:'CHILD_EXIT_NONZERO',powershell_error:'POWERSHELL_SCRIPT_BLOCKED'});
 const windows=String.raw`not ok 1 - installer
  location: 'D:\\agent\\workspace\\tests\\install-windows.test.ts:3:1'
  error: '${JSON.stringify(diagnostic)}'
  code: 'ERR_ASSERTION'
  actual: 'opaque source body'
  expected: 'opaque private path'
  stack: 'D:\agent\workspace\tests\install-windows.test.ts:12:3'
not ok 2 - outside selection
  location: 'D:\agent\workspace\tests\unselected.test.ts:99:1'
  code: 'UNAPPROVED_ERROR'
`;
 const collected=collectUnitFailures(windows,[file]);assert.equal(collected.length,1);assert.deepEqual(collected[0].lines,[3,12]);assert.deepEqual(collected[0].error_codes.sort(),['CHILD_EXIT_NONZERO','ERR_ASSERTION']);assert.deepEqual(collected[0].command_stages,['MANIFEST_FIRST']);assert.deepEqual(collected[0].exit_codes,[1]);assert.deepEqual(collected[0].powershell_errors,['POWERSHELL_SCRIPT_BLOCKED']);
 assert.deepEqual(collectUnitFailures(windows.replace(/\\+/g,'/'),[file]),collected);assert.doesNotMatch(JSON.stringify(collected),/opaque|private|agent|workspace|UNAPPROVED|unselected/);
 for(const code of ['ENOENT','EACCES','ETIMEDOUT'])assert.equal(finiteInstallerDiagnostic('INSTALL_FIRST',{status:null,error:{code},stderr:'opaque command output'}).process_code,code);
 assert.equal(finiteInstallerDiagnostic('INSTALL_FIRST',{status:1,stderr:'CommandNotFoundException: opaque command output'}).powershell_error,'POWERSHELL_COMMAND_NOT_FOUND');
 assert.equal(finiteInstallerDiagnostic('INSTALL_FIRST',{status:1,stderr:'UnauthorizedAccessException: opaque command output'}).powershell_error,'POWERSHELL_ACCESS_DENIED');
 assert.throws(()=>finiteInstallerDiagnostic('UNAPPROVED_STAGE',{status:1,stderr:'private'}),/UNKNOWN_DIAGNOSTIC_STAGE/);
});

test('migration refuses a foreign database before the DB readiness gate or any SQL can run',()=>{
 const directory=mkdtempSync(join(tmpdir(),'sigongnote-db-refusal-'));mkdirSync(join(directory,'services','api'),{recursive:true});
 try{
  writeFileSync(join(directory,'services','api','.env'),'MIGRATION_DATABASE_URL=postgresql://synthetic@remote.invalid/test\nDATABASE_URL=postgresql://synthetic@127.0.0.1/test\nWORKER_DATABASE_URL=postgresql://synthetic@127.0.0.1/test\n');
  const env={...process.env,SIGONGNOTE_E2E_DB:'1'};delete env.NODE_TEST_CONTEXT;
  const refused=spawnSync(process.execPath,['--import',import.meta.resolve('tsx'),'--test','--test-reporter=tap',resolve('tests/cloud-migration.test.ts')],{encoding:'utf8',cwd:directory,env,timeout:10000});
  assert.equal(refused.status,1);assert.match(refused.stdout,/Local database endpoints required before any connection/);assert.doesNotMatch(refused.stdout,/ECONNREFUSED|ENOTFOUND|Local Supabase is not running/);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('synthetic restore opt-in is file-scoped and cannot activate on a developer or self-hosted computer',()=>{
 const base={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux',SIGONGNOTE_E2E_DB:'0',SIGONGNOTE_RECOVERY_TEST:'1',SIGONGNOTE_RECOVERY_DISPOSABLE_VM:'1'};
 const ordinary=supabaseFixtureEnvironment(base,'tests/another.test.ts');assert.equal(ordinary.SIGONGNOTE_RECOVERY_TEST,undefined);assert.equal(ordinary.SIGONGNOTE_RECOVERY_DISPOSABLE_VM,undefined);
 const recovery=supabaseFixtureEnvironment(base,'tests/recovery.test.ts');assert.equal(recovery.SIGONGNOTE_RECOVERY_TEST,'1');assert.equal(recovery.SIGONGNOTE_RECOVERY_DISPOSABLE_VM,'1');
 for(const changes of [{GITHUB_ACTIONS:'false'},{RUNNER_ENVIRONMENT:'self-hosted'},{RUNNER_OS:'Windows'},{SIGONGNOTE_E2E_DB:'1'}])assert.throws(()=>supabaseFixtureEnvironment({...base,...changes},'tests/recovery.test.ts'),/RECOVERY_REQUIRES_DISPOSABLE/);
 const rejected=spawnSync(process.execPath,['scripts/run-supabase-e2e.mjs','--run'],{encoding:'utf8',env:{...process.env,GITHUB_ACTIONS:'false',RUNNER_ENVIRONMENT:'self-hosted',RUNNER_OS:'Windows'}});assert.equal(rejected.status,2);assert.match(rejected.stderr,/requires a disposable GitHub-hosted Linux VM/);
});

test('actual Node assertion TAP preserves finite installer diagnostics before raw output is discarded',()=>{
 const directory=mkdtempSync(join(tmpdir(),'sigongnote-finite-tap-')),name='finite-installer-child.test.mjs',fixture=join(directory,name);
 try{
  const message=JSON.stringify({stage:'INSTALL_FIRST',exit_code:17,process_code:'CHILD_EXIT_NONZERO',powershell_error:'POWERSHELL_SCRIPT_BLOCKED'});
  writeFileSync(fixture,"import {test} from 'node:test';import assert from 'node:assert/strict';\n"+`test('intentional finite diagnostic',()=>assert.equal(1,0,${JSON.stringify(message)}));\n`);
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const result=spawnSync(process.execPath,['--test','--test-reporter=tap',fixture],{encoding:'utf8',env,timeout:10000,maxBuffer:1024*1024});
  assert.equal(result.status,1);
  const failures=collectUnitFailures(result.stdout??'',[name]);assert.equal(failures.length,1);
  const failure=failures[0];assert.equal(failure.file,name);assert.ok(failure.lines.length>0&&failure.lines.every(line=>Number.isInteger(line)&&line>0));
  assert.deepEqual(failure.error_codes.sort(),['CHILD_EXIT_NONZERO','ERR_ASSERTION']);assert.deepEqual(failure.command_stages,['INSTALL_FIRST']);assert.deepEqual(failure.exit_codes,[17]);assert.deepEqual(failure.powershell_errors,['POWERSHELL_SCRIPT_BLOCKED']);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
