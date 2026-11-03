param([switch]$Lan,[switch]$SkipBuild)
$ErrorActionPreference='Stop'
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$work=Join-Path $repo '.work/review-preview'
New-Item -ItemType Directory -Force -Path $work | Out-Null
$existing=$false
if(Get-NetTCPConnection -LocalPort 5188 -State Listen -ErrorAction SilentlyContinue) {
    try {
        $health=Invoke-RestMethod -Uri 'http://127.0.0.1:5188/health' -TimeoutSec 2
        $version=Invoke-RestMethod -Uri 'http://127.0.0.1:5188/version.json' -TimeoutSec 2
        if($health.service -ne 'sigongnote-review-preview' -or $version.lan -ne [bool]$Lan) {throw 'Preview mode differs'}
        $existing=$true
    } catch {throw 'Port 5188 is already in use or its PC/LAN mode differs. Existing services were preserved.'}
}
if(-not $SkipBuild -or -not (Test-Path -LiteralPath (Join-Path $work 'web/preview-build.json'))) {
Push-Location (Join-Path $repo 'apps/web')
try {
    & npm.cmd run build -- --outDir (Join-Path $work 'web') *> (Join-Path $work 'build.log')
    if($LASTEXITCODE -ne 0) {throw 'Preview build failed; see .work/review-preview/build.log'}
} finally {Pop-Location}
$revision=(& git -C $repo rev-parse --short HEAD).Trim()
$dirty=@(& git -C $repo status --porcelain -- apps/web packages).Count -gt 0
@{revision=$revision;builtAt=[DateTime]::UtcNow.ToString('o');webSourceDirty=$dirty} | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $work 'web/preview-build.json')
}
if(-not $existing) {
    $node=(Get-Command node.exe).Source
    $server=Join-Path $repo 'scripts/serve-review-preview.mjs'
    $arguments=@(('"'+$server+'"'));if($Lan){$arguments+='--lan'}
    $process=Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $repo -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $work 'server.log') -RedirectStandardError (Join-Path $work 'server-error.log')
    [IO.File]::WriteAllText((Join-Path $work 'server.pid'),[string]$process.Id)
}
$ready=$false
for($attempt=0;$attempt -lt 20;$attempt++) {
    try {$health=Invoke-RestMethod -Uri 'http://127.0.0.1:5188/health' -TimeoutSec 2;if($health.service -eq 'sigongnote-review-preview'){$ready=$true;break}} catch {}
    Start-Sleep -Milliseconds 250
}
if(-not $ready){throw 'Preview did not start; see .work/review-preview/server-error.log'}
Write-Output 'READY http://127.0.0.1:5188/'
if($Lan){$running=Invoke-RestMethod -Uri 'http://127.0.0.1:5188/version.json' -TimeoutSec 2; $running.urls | ForEach-Object {Write-Output "LAN $_"}; Write-Output 'If Wi-Fi/IP changes, restart the preview server before using a new address.'}
