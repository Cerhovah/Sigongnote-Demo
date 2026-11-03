param()
$ErrorActionPreference='Stop'
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$work=Join-Path $repo '.work/live-work'
New-Item -ItemType Directory -Force -Path $work | Out-Null
$account=[Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $work /inheritance:r /grant:r "${account}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' *> $null
if($LASTEXITCODE -ne 0){throw 'Cannot protect the local workspace directory.'}
$existing=Get-NetTCPConnection -LocalPort 5189 -State Listen -ErrorAction SilentlyContinue
if($existing){
    $health=Invoke-RestMethod 'http://127.0.0.1:5189/health' -TimeoutSec 3
    $pidFile=Join-Path $work 'server.pid'
    if($health.service -ne 'sigongnote-live-work' -or -not (Test-Path -LiteralPath $pidFile)){throw 'Port 5189 is in use; preserved existing process.'}
    $savedProcessId=[int](Get-Content -LiteralPath $pidFile)
    $processInfo=Get-CimInstance Win32_Process -Filter "ProcessId=$savedProcessId"
    if($savedProcessId -notin $existing.OwningProcess -or $processInfo.CommandLine -notlike '*scripts/serve-live-work.ts*'){throw 'Live workspace ownership differs; preserved existing process.'}
}
Push-Location $repo
try {
    & node scripts/db-gate.mjs
    if($LASTEXITCODE -ne 0){throw 'Start the local Supabase services first.'}
    $localApiPort=if($env:SIGONGNOTE_LOCAL_API_PORT){$env:SIGONGNOTE_LOCAL_API_PORT}else{'3001'}
    if($localApiPort -notmatch '^\d+$' -or [long]$localApiPort -lt 1 -or [long]$localApiPort -gt 65535){throw 'Invalid local API port.'}
    $api=Invoke-WebRequest "http://127.0.0.1:$localApiPort/health/live" -TimeoutSec 5
    if($api.StatusCode -ne 200){throw 'Start npm.cmd run dev:api first.'}
    & npm.cmd run build --workspace @sigongnote/web -- --outDir (Join-Path $work 'web') *> (Join-Path $work 'build.log')
    if($LASTEXITCODE -ne 0){throw 'Web build failed; see .work/live-work/build.log'}
    $revision=(& git rev-parse --short HEAD).Trim()
    $dirty=@(& git status --porcelain -- apps/web packages scripts/live-work-routes.ts scripts/serve-live-work.ts).Count -gt 0
    @{revision=$revision;builtAt=[DateTime]::UtcNow.ToString('o');sourceDirty=$dirty} | ConvertTo-Json | Set-Content -Encoding utf8NoBOM (Join-Path $work 'web/build-info.json')
    if($existing){Stop-Process -Id $savedProcessId -ErrorAction Stop}
    $node=(Get-Command node.exe).Source
    $process=Start-Process -FilePath $node -ArgumentList @('--import','tsx','scripts/serve-live-work.ts') -WorkingDirectory $repo -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $work 'server.log') -RedirectStandardError (Join-Path $work 'server-error.log')
    [IO.File]::WriteAllText((Join-Path $work 'server.pid'),[string]$process.Id)
} finally {Pop-Location}
$ready=$false
for($attempt=0;$attempt -lt 30;$attempt++){
    try{$health=Invoke-RestMethod 'http://127.0.0.1:5189/health' -TimeoutSec 2;if($health.service -eq 'sigongnote-live-work'){$ready=$true;break}}catch{}
    Start-Sleep -Milliseconds 400
}
if(-not $ready){throw 'Live workspace did not start; see .work/live-work/server-error.log'}
Write-Output 'READY http://127.0.0.1:5189/ (this PC only; local workspace, no production data)'
