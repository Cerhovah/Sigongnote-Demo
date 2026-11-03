/** Only the selected synthetic restore on a disposable hosted VM may opt in to a restore. */
export function supabaseFixtureEnvironment(base,file){
 const env={...base};delete env.SIGONGNOTE_RECOVERY_TEST;delete env.SIGONGNOTE_RECOVERY_DISPOSABLE_VM;
 if(file!=='tests/recovery.test.ts')return env;
 if(env.GITHUB_ACTIONS!=='true'||env.RUNNER_ENVIRONMENT!=='github-hosted'||env.RUNNER_OS!=='Linux'||env.SIGONGNOTE_E2E_DB!=='0')throw new Error('RECOVERY_REQUIRES_DISPOSABLE_GITHUB_VM');
 return {...env,SIGONGNOTE_RECOVERY_TEST:'1',SIGONGNOTE_RECOVERY_DISPOSABLE_VM:'1'};
}
