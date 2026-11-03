import type {SpawnSyncReturns} from 'node:child_process';

export type InstallerDiagnosticStage='MANIFEST_FIRST'|'MANIFEST_SECOND'|'INSTALL_FIRST'|'INSTALL_SECOND'|'RETRY_FIRST'|'RETRY_SECOND'|'REJECT_TRAVERSAL';
export type InstallerProcessCode='ERR_ASSERTION'|'ENOENT'|'EACCES'|'ETIMEDOUT'|'CHILD_EXIT_NONZERO';
export type InstallerPowerShellError='POWERSHELL_SCRIPT_BLOCKED'|'POWERSHELL_ACCESS_DENIED'|'POWERSHELL_COMMAND_NOT_FOUND';
export type InstallerDiagnostic={stage:InstallerDiagnosticStage;exit_code:number|null;process_code:InstallerProcessCode|null;powershell_error:InstallerPowerShellError|null};

export function finiteInstallerDiagnostic(stage:InstallerDiagnosticStage,result:Pick<SpawnSyncReturns<string>,'status'|'stderr'|'error'>):InstallerDiagnostic;
