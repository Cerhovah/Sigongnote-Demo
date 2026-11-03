export type RecoveryDiagnostic={stage:string;code:string;sqlstate:string|null};
export const recoveryDiagnosticPrefix:'SIGONGNOTE_RECOVERY_DIAGNOSTIC ';
export function attachRecoveryDiagnostic(error:unknown,stage:unknown):RecoveryDiagnostic;
export function recoveryDiagnosticLine(value:unknown):string;
export function collectRecoveryDiagnostics(...channels:unknown[]):RecoveryDiagnostic[];

export type RecoveryToolErrorType='PERMISSION_DENIED'|'ROLE_MISSING'|'EXTENSION_UNAVAILABLE'|'CONFIG_UNSUPPORTED'|'ARCHIVE_VERSION'|'CRON_DATABASE_ONLY'|'OBJECT_EXISTS';
export type RecoveryToolDiagnostic={status:'CLASSIFIED'|'UNCLASSIFIED'|'INVALID_WINDOW'|'NOT_REGULAR'|'TOO_LARGE'|'NOT_CURRENT'|'EMPTY'|'CHANGED'|'READ_UNAVAILABLE';types:RecoveryToolErrorType[]};
export function classifyRecoveryToolError(text:unknown):RecoveryToolErrorType[];
export function readCurrentRecoveryToolDiagnostic(file:string,childStartedMs:number,childEndedMs:number):RecoveryToolDiagnostic;
