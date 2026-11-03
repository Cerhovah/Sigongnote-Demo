import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureEnvironment,instrumentationResult,requireHostedEmulator,selectedClasses} from '../scripts/run-android-emulator-fixture.mjs';

test('hosted fixture refuses local/self-hosted/non-Linux execution before any mutation',()=>{
 const hosted={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux'};
 assert.doesNotThrow(()=>requireHostedEmulator(hosted,'linux'));
 for(const [env,platform] of [[{},'linux'],[{...hosted,RUNNER_ENVIRONMENT:'self-hosted'},'linux'],[hosted,'win32'],[{...hosted,RUNNER_OS:'Windows'},'linux']])assert.throws(()=>requireHostedEmulator(env,platform),/DISPOSABLE_HOSTED_LINUX_REQUIRED/);
});
test('fixture child cannot inherit paid-provider, remote Supabase or plain-PG test credentials',()=>{
 const env=fixtureEnvironment({PATH:'tool-path',ANDROID_HOME:'sdk',AI_PROVIDER:'claude',AI_DAILY_BUDGET_KRW:'10000',ANTHROPIC_API_KEY:'secret',ANTHROPIC_AUTH_TOKEN:'secret',OPENAI_API_KEY:'secret',SEMANTIC_API_KEY:'secret',SEMANTIC_PROVIDER:'openai',CLAUDE_CODE_OAUTH_TOKEN:'secret',CLOVA_SPEECH_KEY:'secret',SHORT_STT_API_KEY:'secret',SUPABASE_ACCESS_TOKEN:'secret',SUPABASE_URL:'https://remote.invalid',DATABASE_URL:'remote',E2E_MIGRATION_DATABASE_URL:'remote',SIGONGNOTE_E2E_DB:'1'});
 assert.equal(env.PATH,'tool-path');assert.equal(env.ANDROID_HOME,'sdk');assert.equal(env.AI_PROVIDER,'fixture');assert.equal(env.AI_DAILY_BUDGET_KRW,'0');assert.equal(env.SIGONGNOTE_E2E_DB,'0');
 assert.equal(env.CLAUDE_AGENT_ENABLED,'false');assert.equal(env.SHORT_STT_ENABLED,'false');assert.equal(env.LONG_STT_ENABLED,'false');
 assert.equal(Object.values(env).includes('secret'),false);assert.equal(Object.values(env).includes('remote'),false);assert.equal(env.SUPABASE_URL,undefined);
});
const output=codes=>codes.map(code=>`INSTRUMENTATION_STATUS: numtests=${codes.length}\nINSTRUMENTATION_STATUS_CODE: ${code}\n`).join('');
test('instrumentation requires actual complete passing cases; shell exit zero is insufficient',()=>{
 assert.deepEqual(instrumentationResult(output([0,0])+'OK (2 tests)\nINSTRUMENTATION_CODE: -1\n',0),{status:'PASS',tests:2,expected:2,passed:2,failed:0,skipped:0,failure_lines:[]});
 assert.equal(instrumentationResult('OK (0 tests)\nINSTRUMENTATION_CODE: -1\n',0).status,'FAIL');
 assert.equal(instrumentationResult(output([0,-2])+'FAILURES!!!\nINSTRUMENTATION_CODE: -1\n',0).status,'FAIL');
 assert.equal(instrumentationResult(output([0,-3])+'OK (2 tests)\nINSTRUMENTATION_CODE: -1\n',0).skipped,1);
 assert.equal(instrumentationResult(output([0,-3])+'OK (2 tests)\nINSTRUMENTATION_CODE: -1\n',0).status,'FAIL');
 assert.equal(instrumentationResult(output([0])+'OK (1 test)\n',0).status,'FAIL');
 assert.equal(instrumentationResult(output([0])+'OK (1 test)\nINSTRUMENTATION_CODE: -1\n',1).status,'FAIL');
 const privateFailure=instrumentationResult(output([-2])+'at WorkScreenDeviceTest.kt:123\nprivate-session-value\nINSTRUMENTATION_CODE: -1\n',0);
 assert.deepEqual(privateFailure.failure_lines,[123]);assert.equal(JSON.stringify(privateFailure).includes('private-session-value'),false);
 const diagnosed=instrumentationResult(output([-2])+'SN_DIAG:agenda.read:READ_FAILED SN_DIAG:agenda.read:READ_FAILED SN_DIAG:private-source:READ_FAILED SN_DIAG:journal.tasks:PRIVATE_TOKEN SN_DIAG:today:UNKNOWN_ALERT_SUFFIX private-session-value\nINSTRUMENTATION_CODE: -1\n',0);
 assert.deepEqual(diagnosed.diagnostics,[{route:'agenda.read',code:'READ_FAILED'}]);assert.equal(JSON.stringify(diagnosed).includes('private-session-value'),false);assert.equal(JSON.stringify(diagnosed).includes('private-source'),false);assert.equal(JSON.stringify(diagnosed).includes('PRIVATE_TOKEN'),false);
});
test('class selection preserves complete update two-phase test and rejects shell text/empty classes',()=>{
 assert.ok(selectedClasses('').includes('com.sigongnote.app.UpdateContinuityDeviceTest'));
 assert.deepEqual(selectedClasses('com.sigongnote.app.WorkLedgerDeviceTest,com.sigongnote.app.WorkLedgerDeviceTest'),['com.sigongnote.app.WorkLedgerDeviceTest']);
 for(const value of ['com.sigongnote.app.WorkLedgerDeviceTest;echo token','com.sigongnote.app.WorkLedgerDeviceTest,','com.sigongnote.app.UpdateContinuityDeviceTest#packageReplacementPreservesVaultKeyAndPendingQueue'])assert.throws(()=>selectedClasses(value));
});
