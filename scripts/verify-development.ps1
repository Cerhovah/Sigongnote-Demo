param([switch]$Full)
$ErrorActionPreference='Stop'
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$reportRoot=Join-Path $repo '.work/verification'
$runId=[DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssZ')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8)
$reportDir=Join-Path $reportRoot $runId
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
$rows=[Collections.Generic.List[object]]::new()
function Check([string]$name,[scriptblock]$action){
 $started=[DateTimeOffset]::UtcNow
 $passed=$false
 try{ & $action *> (Join-Path $reportDir "$name.log");$passed=($LASTEXITCODE -eq 0) }catch{ $_ | Out-String | Add-Content -LiteralPath (Join-Path $reportDir "$name.log") }
 $rows.Add([pscustomobject]@{name=$name;passed=$passed;seconds=[math]::Round(([DateTimeOffset]::UtcNow-$started).TotalSeconds,1)})
}
Push-Location $repo
try {
 $sourceBefore=(& node scripts/verification-source.mjs | ConvertFrom-Json)
 if($LASTEXITCODE -ne 0){throw 'Cannot identify verification source'}
 Check 'build' {npm.cmd run build};Check 'typecheck' {npm.cmd run typecheck}
 Check 'contracts' {npm.cmd run contracts:check};Check 'native-contracts' {npm.cmd run contracts:native}
 Check 'spec' {node scripts/check-spec.mjs}
 Check 'pilot-metrics' {node --test tests/pilot.test.mjs}
 if($Full){
  Check 'typescript-tests' {npm.cmd test};Check 'lint' {npm.cmd run lint}
  Check 'python-tests' {& services/document-worker/.venv/Scripts/python.exe -m pytest services/document-worker/tests -q}
  Check 'windows-tests' {dotnet test apps/windows/tests/Sigongnote.Windows.Tests.csproj --no-restore --verbosity quiet}
  Check 'android-tests-build' {& ./scripts/check-android.ps1}
  Check 'recovery-fixture-tests' {
   $previous=$env:SIGONGNOTE_RECOVERY_TEST
   try{$env:SIGONGNOTE_RECOVERY_TEST='1';node --import tsx --test tests/recovery.test.ts;if($LASTEXITCODE -ne 0){throw 'Recovery fixture tests failed'}}finally{$env:SIGONGNOTE_RECOVERY_TEST=$previous}
  }
 }
 $sourceAfter=(& node scripts/verification-source.mjs | ConvertFrom-Json)
 if($LASTEXITCODE -ne 0){throw 'Cannot identify verification source'}
 $rows.Add([pscustomobject]@{name='source-unchanged-during-run';passed=($sourceBefore.source_sha256 -eq $sourceAfter.source_sha256 -and $sourceBefore.head -eq $sourceAfter.head);seconds=0})
 $operationalRecovery=@{status='not_run';acceptance='V22';productionReady=$false}
 if($Full){
  $auditOutput=& node --import tsx scripts/recovery-audit.ts 2> (Join-Path $reportDir 'recovery-source-audit-error.log')
  $auditExit=$LASTEXITCODE
  $operationalRecovery=@{status='unavailable';exitCode=$auditExit;acceptance='V22';productionReady=$false}
  try{$audit=$auditOutput|ConvertFrom-Json;if($null -ne $audit -and $audit.schema -eq 1){$operationalRecovery.audit=$audit;$operationalRecovery.status=if($auditExit -eq 0){'metadata_clear_bytes_unverified'}else{'incomplete'}}}catch{}
 }
 $report=@{runId=$runId;head=$sourceBefore.head;source=$sourceBefore;sourceAfter=$sourceAfter;at=[DateTimeOffset]::UtcNow.ToString('o');full=[bool]$Full;checks=$rows;operationalRecovery=$operationalRecovery;deviceAcceptance='separate';productionReady=$false}|ConvertTo-Json -Depth 7
 $report|Set-Content -LiteralPath (Join-Path $reportDir 'report.json') -Encoding utf8
 $report|Set-Content -LiteralPath (Join-Path $reportRoot 'latest.json') -Encoding utf8
 if($Full){$report|Set-Content -LiteralPath (Join-Path $reportRoot 'latest-full.json') -Encoding utf8}
 $rows|Format-Table name,passed,seconds
 if(@($rows|Where-Object {!$_.passed}).Count){throw 'Development verification has failures; see local logs'}
}finally{Pop-Location}
