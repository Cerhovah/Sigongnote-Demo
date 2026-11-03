#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {appendFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {rootTestCatalog,selectUnitTests} from './e2e-test-catalog.mjs';

const processCodes=new Set(['ERR_ASSERTION','ENOENT','EACCES','ETIMEDOUT','CHILD_EXIT_NONZERO']);
const stages=new Set(['MANIFEST_FIRST','MANIFEST_SECOND','INSTALL_FIRST','INSTALL_SECOND','RETRY_FIRST','RETRY_SECOND','REJECT_TRAVERSAL']);
const powershellCodes=new Set(['POWERSHELL_SCRIPT_BLOCKED','POWERSHELL_ACCESS_DENIED','POWERSHELL_COMMAND_NOT_FOUND']);

/** Return only finite command diagnostics. Paths, raw stdout/stderr and exception messages never leave the child. */
export function finiteInstallerDiagnostic(stage,result){
 if(!stages.has(stage))throw new Error('UNKNOWN_DIAGNOSTIC_STAGE');
 const code=result.error?.code,stderr=result.stderr??'';
 const powershell_error=/PSSecurityException|running scripts is disabled|not digitally signed|AuthorizationManager check failed/i.test(stderr)?'POWERSHELL_SCRIPT_BLOCKED'
  :/UnauthorizedAccessException|access (?:to .*?)?is denied|access to the path .* denied/i.test(stderr)?'POWERSHELL_ACCESS_DENIED'
  :/CommandNotFoundException|is not recognized as (?:a name|the name)/i.test(stderr)?'POWERSHELL_COMMAND_NOT_FOUND':null;
 return {stage,exit_code:Number.isInteger(result.status)?result.status:null,
  process_code:processCodes.has(code)?code:Number.isInteger(result.status)&&result.status!==0?'CHILD_EXIT_NONZERO':null,powershell_error};
}

/** Match only selected test files, numeric line anchors, and allowlisted diagnostic values before discarding TAP. */
export function collectUnitFailures(output,files){
 const normalized=output.replace(/\\+/g,'/'),failures=[];
 for(const block of normalized.split(/(?=^\s*not ok \d)/m).filter(text=>/^\s*not ok \d/.test(text))){
  for(const file of files){
   const escaped=file.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
   if(!new RegExp(`(?:^|[/\\s'"])${escaped}(?=[:\\s'"]|$)`,'m').test(block))continue;
   const lines=[...new Set([...block.matchAll(new RegExp(`${escaped}:(\\d+):\\d+`,'g'))].map(match=>Number(match[1])))];
   const values=(pattern,allowed)=>[...new Set([...block.matchAll(pattern)].map(match=>match[1]).filter(value=>allowed.has(value)))];
   const error_codes=values(/(?:\bcode:\s*['"]|"process_code"\s*:\s*")([A-Z_]+)['"]/g,processCodes);
   const command_stages=values(/"stage"\s*:\s*"([A-Z_]+)"/g,stages);
   const powershell_errors=values(/"powershell_error"\s*:\s*"([A-Z_]+)"/g,powershellCodes);
   const exit_codes=[...new Set([...block.matchAll(/"exit_code"\s*:\s*(-?\d{1,10})(?=[,}\s])/g)].map(match=>Number(match[1])).filter(value=>Number.isInteger(value)&&value>=-2147483648&&value<=4294967295))];
   failures.push({file,lines,error_codes,command_stages,exit_codes,powershell_errors});
  }
 }
 return failures;
}

export function summarizeUnitResult(result){
 const counts={};for(const name of ['tests','pass','fail','cancelled','skipped','todo']){
  const value=[...(result.stdout??'').matchAll(new RegExp(`^# ${name} (\\d+)\\r?$`,'gm'))].at(-1)?.[1];
  if(value!==undefined)counts[name]=Number(value);
 }
 const status=result.status===0&&counts.tests>0&&counts.pass===counts.tests&&counts.fail===0&&counts.cancelled===0&&counts.skipped===0&&counts.todo===0?'PASS':'FAIL';
 return {status,counts,...(status==='FAIL'?{failure_code:result.error?.code==='ETIMEDOUT'?'TIMEOUT':result.status===0?'TESTS_NOT_FULLY_EXECUTED':'TEST_PROCESS_FAILED'}:{})};
}

export function main(args=process.argv.slice(2)){
 if(args.some(arg=>!['--list','--platform-only'].includes(arg))||new Set(args).size!==args.length){console.error('Usage: node scripts/run-unit.mjs [--list] [--platform-only]');return 2;}
 const catalog=rootTestCatalog(),selection=selectUnitTests(catalog,{platformOnly:args.includes('--platform-only')}),files=selection.files;
 if(args.includes('--list')){console.log(JSON.stringify({lane:'unit',count:files.length,...selection},null,2));return 0;}
 const receipt={started_at:new Date().toISOString(),lane:'unit',...selection,status:'RUNNING',excluded:{plain:catalog.plain,supabase:catalog.supabase.map(item=>item.file)},actual_model:'NOT_RUN'};
 const receiptPath=selection.mode==='platform_only'?'.work/e2e/unit-platform-test-scope.json':'.work/e2e/unit-test-scope.json';
 const save=()=>{mkdirSync('.work/e2e',{recursive:true});writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n');};
 save();
 if(!files.length){receipt.status='FAIL';receipt.failure_code='NO_COMPATIBLE_TESTS';save();console.error('FAIL: no compatible unit tests selected');return 1;}
 const result=spawnSync(process.execPath,['--import','tsx','--test','--test-concurrency=1','--test-timeout=120000','--test-reporter=tap',...files],{encoding:'utf8',timeout:12*60_000,maxBuffer:32*1024*1024,env:process.env});
 Object.assign(receipt,summarizeUnitResult(result));
 if(receipt.status==='FAIL'){
  receipt.failures=collectUnitFailures(result.stdout??'',files);
 }
 save();
 console.log(`${receipt.status}: unit files ${files.length}, tests ${receipt.counts.tests??0}, passed ${receipt.counts.pass??0}, failed ${receipt.counts.fail??0}, skipped ${receipt.counts.skipped??0}, platform NOT_RUN ${receipt.not_run.length}; raw child output was not published`);
 if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,`\n### Complete unit test catalog (${receipt.platform}, ${receipt.mode})\n\n${receipt.status}: ${files.length} selected files; ${receipt.counts.pass??0} passed, ${receipt.counts.fail??0} failed, ${receipt.counts.skipped??0} skipped. Every root test file belongs to exactly one unit/PostgreSQL/Supabase lane.\n${receipt.not_run.map(item=>`- NOT_RUN: ${item.file} (${item.reason}; requires ${item.required_platforms.join(', ')})`).join('\n')}\n`);
 return receipt.status==='PASS'?0:1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=main();
