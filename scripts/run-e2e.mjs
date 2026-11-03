#!/usr/bin/env node
// Runs the DB-backed suite against the isolated E2E PostgreSQL prepared by scripts/e2e-db.mjs.
//   node scripts/run-e2e.mjs                 # core E2E (context restoration, replayed fixture) + DB-backed agent/journal/AI/SMS tests
//   node scripts/run-e2e.mjs --live          # same, but the context-restoration E2E calls the real Claude Agent SDK (needs a credential)
//   node scripts/run-e2e.mjs --record        # refresh fixtures/claude/context-restore.json from a live run
//   node scripts/run-e2e.mjs --all           # every DB-backed test file in tests/
// SIGONGNOTE_E2E_DB=1 is set for the child so scripts/db-gate.mjs validates the plain-PostgreSQL environment.
import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {E2E_ENV_FILE} from './e2e-db.mjs';
import {databaseTestCatalog} from './e2e-test-catalog.mjs';

const args=new Set(process.argv.slice(2));
if(!existsSync(E2E_ENV_FILE)&&!process.env.E2E_API_DATABASE_URL){console.error('E2E database not prepared: run node scripts/e2e-db.mjs first');process.exit(2);}
const core=['tests/e2e/context-restore.e2e.test.ts','tests/agent-runs.test.ts','tests/agent-continuation.test.ts','tests/journal-actions.test.ts','tests/work-journal.test.ts','tests/product-ai.test.ts','tests/sms-triage.test.ts','tests/local-cloud-sync.test.ts','tests/local-document-draft.test.ts','tests/semantic-queue.test.ts','tests/production-api.test.ts'];
const {plain:all,supabase:skipped}=databaseTestCatalog();
const files=args.has('--all')?[...new Set([...core,...all])]:core;
const actualLive=args.has('--live')||args.has('--record')||process.env.CLAUDE_E2E_LIVE==='1'||process.env.CLAUDE_E2E_RECORD==='1';
const receipt={started_at:new Date().toISOString(),database:'isolated_postgresql',mode:actualLive?'real_claude':'recorded_claude_fixture',files,suite:'RUNNING',tenant_oracle:'NOT_RUN',live_model:actualLive?'REQUESTED':'NOT_RUN',not_run:skipped.map(item=>({...item,status:'NOT_RUN'}))};
const save=()=>{mkdirSync('.work/e2e',{recursive:true});writeFileSync('.work/e2e/test-scope.json',JSON.stringify(receipt,null,2)+'\n');};
save();
console.log(`isolated PostgreSQL: ${files.length} files; model mode: ${receipt.mode}; live model: ${receipt.live_model}`);
if(args.has('--all'))for(const item of skipped)console.log(`NOT_RUN ${item.file}: ${item.reason}`);
const summarize=()=>{save();if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,`\n### Isolated PostgreSQL verification\n\n- Suite: ${receipt.suite}; tenant oracle: ${receipt.tenant_oracle}.\n- Model mode: ${receipt.mode}; actual live model: ${receipt.live_model}.\n- Selected test files: ${files.length}.\n\n${receipt.not_run.map(r=>`- NOT_RUN: \`${r.file}\` — ${r.reason}.`).join('\n')}\n`);};
const env={...process.env,SIGONGNOTE_E2E_DB:'1',...(args.has('--live')?{CLAUDE_E2E_LIVE:'1'}:{}),...(args.has('--record')?{CLAUDE_E2E_RECORD:'1'}:{})};
const result=spawnSync(process.execPath,['--import','tsx','--test','--test-concurrency=1',...files],{stdio:'inherit',env});
receipt.suite=result.status===0?'PASS':'FAIL';if(actualLive)receipt.live_model=result.status===0?'PASS':'FAIL';
if((result.status??1)!==0){summarize();process.exit(result.status??1);}
// Tenant RLS/FK oracle (supabase/tests/tenant_boundary.sql) on the same isolated database; it rolls itself back.
const tenant=spawnSync(process.execPath,['scripts/test-tenant.mjs'],{stdio:'inherit',env});
receipt.tenant_oracle=tenant.status===0?'PASS':'FAIL';summarize();
process.exit(tenant.status??1);
