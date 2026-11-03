param([switch]$Lan,[switch]$SkipBuild)
$ErrorActionPreference='Stop'
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$work=Join-Path $repo '.work/live-links'
New-Item -ItemType Directory -Force -Path $work | Out-Null
if(Get-NetTCPConnection -LocalPort 5190 -State Listen -ErrorAction SilentlyContinue){
    $health=Invoke-RestMethod 'http://127.0.0.1:5190/health' -TimeoutSec 3
    if($health.service -ne 'sigongnote-live-links'){throw 'Port 5190 is owned by another service; stop the retired work preview explicitly.'}
    Write-Output 'READY real-service redirect';return
}
$arguments=@(('"'+(Join-Path $PSScriptRoot 'serve-real-links.mjs')+'"'));if($Lan){$arguments+='--lan'}
$process=Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList $arguments -WorkingDirectory $repo -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $work 'server.log') -RedirectStandardError (Join-Path $work 'server-error.log')
[IO.File]::WriteAllText((Join-Path $work 'server.pid'),[string]$process.Id)
