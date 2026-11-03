param([switch]$Lan,[switch]$Restart,[switch]$StayRunning,[switch]$SkipBuild,[ValidateRange(1024,65000)][int]$Port=5190)
$ErrorActionPreference='Stop'
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$work=Join-Path $repo $(if($Port -eq 5190){'.work/work-preview'}else{".work/work-preview-$Port"})
New-Item -ItemType Directory -Force -Path $work | Out-Null
Push-Location $repo
try {
    # Existing local containers/data are reused. Never reset or regenerate credentials here.
    & node node_modules/supabase/dist/supabase.js start *> (Join-Path $work 'supabase-start-private.log')
    if($LASTEXITCODE -ne 0){throw 'Start Docker Desktop, then run this command again. Supabase diagnostics are private in the preview folder.'}
    & node scripts/db-gate.mjs
    if($LASTEXITCODE -ne 0){throw 'Local DB/Auth/Storage verification failed. Existing configuration was preserved.'}
    if(-not $SkipBuild -or -not (Test-Path -LiteralPath (Join-Path $work 'web/index.html'))){
        & node scripts/build-native-work-ui.mjs
        if($LASTEXITCODE -ne 0){throw 'Shared UI build failed'}
    # Keep each lab's static assets with its session. Copy assets before switching the index.
    $web=Join-Path $work 'web'
    New-Item -ItemType Directory -Force -Path $web | Out-Null
    Copy-Item -LiteralPath (Join-Path $repo '.work/native-assets/work/assets') -Destination $web -Recurse -Force
        Copy-Item -LiteralPath (Join-Path $repo '.work/native-assets/work/index.html') -Destination $web -Force
    }
    $listener=Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if($listener){
        $health=Invoke-RestMethod "http://127.0.0.1:$Port/health"
        if($health.service -ne 'sigongnote-work-preview' -or $health.lan -ne [bool]$Lan){throw 'Port is occupied; existing process preserved'}
        if($Restart){
            $pidFile=Join-Path $work 'server.pid'
            if(-not (Test-Path -LiteralPath $pidFile)){throw 'Cannot verify preview ownership; existing process preserved. For a legacy relative-path launch, stop that server in its original terminal once, then rerun.'}
            $savedPid=[int](Get-Content -LiteralPath $pidFile)
            $processInfo=Get-CimInstance Win32_Process -Filter "ProcessId=$savedPid"
            $expected=Join-Path $repo 'scripts/serve-work-preview.ts'
            if($listener.OwningProcess -notcontains $savedPid -or -not $processInfo -or -not $processInfo.CommandLine -or -not $processInfo.CommandLine.Contains($expected)){throw 'Cannot verify preview ownership; existing process preserved. For a legacy relative-path launch, stop that server in its original terminal once, then rerun.'}
            Stop-Process -Id $savedPid
            for($i=0;$i -lt 30 -and (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue);$i++){Start-Sleep -Milliseconds 100}
            $listener=$null
        }
    }
    if(-not $listener){
        $env:SIGONGNOTE_WORK_PREVIEW_PORT=[string]$Port;$arguments=@('--import','tsx',('"'+(Join-Path $repo 'scripts/serve-work-preview.ts')+'"'));if($Lan){$arguments+='--lan'}
        $process=Start-Process (Get-Command node.exe).Source -ArgumentList $arguments -WorkingDirectory $repo -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $work 'server.log') -RedirectStandardError (Join-Path $work 'server-error.log')
        [IO.File]::WriteAllText((Join-Path $work 'server.pid'),[string]$process.Id)
    }
    $ready=$false
    for($i=0;$i -lt 100;$i++){
        try{$health=Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2;if($health.service -eq 'sigongnote-work-preview' -and $health.ready -and $health.workerStatus -ne 'starting'){$ready=$true;break}}catch{}
        Start-Sleep -Milliseconds 500
    }
    if(-not $ready){throw 'Preview dependencies/worker are not ready. Inspect private local diagnostics; old servers need -Restart.'}
    if($health.workerStatus -ne 'ready'){Write-Warning "Dependencies are ready; worker status: $($health.workerStatus). Check connection/storage status in the app."}
    $health.urls | ForEach-Object {Write-Output "READY $_"}
    if($StayRunning){Wait-Process -Id (Get-NetTCPConnection -LocalPort $Port -State Listen).OwningProcess}
} finally {Pop-Location}
