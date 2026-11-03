param([switch]$Background, [switch]$InstallStartup, [switch]$InstallShortcut)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$data = Join-Path $env:LOCALAPPDATA 'Sigongnote\local-agent'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$powershell = (Get-Process -Id $PID).Path
$env:SIGONGNOTE_POWERSHELL = $powershell
if (!(Test-Path -LiteralPath (Join-Path $repo 'apps\web\dist\index.html'))) {
    throw '먼저 npm run build --workspace @sigongnote/web 을 실행하세요.'
}
if ($InstallStartup) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'Sigongnote Local Agent.lnk'))
    $shortcut.TargetPath = $powershell
    $shortcut.Arguments = '-NoProfile -WindowStyle Hidden -File "' + $PSCommandPath + '" -Background'
    $shortcut.WorkingDirectory = $repo
    $shortcut.WindowStyle = 7
    $shortcut.Save()
}
if ($InstallShortcut) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) '시공노트.lnk'))
    $shortcut.TargetPath = $powershell
    $shortcut.Arguments = '-NoProfile -WindowStyle Hidden -File "' + $PSCommandPath + '"'
    $shortcut.WorkingDirectory = $repo
    $shortcut.WindowStyle = 7
    $shortcut.Save()
}
# Optional localhost field API. Failure remains visible in the application.
$fieldFile = Join-Path $data 'field.json'
if (Test-Path -LiteralPath $fieldFile) {
    $fieldConfig = Get-Content -LiteralPath $fieldFile -Raw | ConvertFrom-Json
    if ($fieldConfig.apiUrl -ne 'http://127.0.0.1:3002') { throw '업무 서버 주소를 확인해 주세요.' }
    $apiReady = $false
    try { $apiReady = (Invoke-RestMethod -Uri ($fieldConfig.apiUrl + '/health/live') -TimeoutSec 2).service -eq 'sigongnote-api' } catch { }
    if (!$apiReady -and !(Get-NetTCPConnection -LocalPort 3002 -State Listen -ErrorAction SilentlyContinue)) {
        $previousPort = $env:PORT
        try {
            $env:PORT = '3002'
            Start-Process -FilePath $node -ArgumentList '--import tsx services/api/src/main.ts' -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput (Join-Path $data 'field-api.log') -RedirectStandardError (Join-Path $data 'field-api-error.log')
        } finally { $env:PORT = $previousPort }
    }
}
$running = $false
$launchFile = Join-Path $data 'launch.json'
if (Test-Path -LiteralPath $launchFile) {
    $launch = Get-Content -LiteralPath $launchFile -Raw | ConvertFrom-Json
    $running = $null -ne (Get-Process -Id $launch.pid -ErrorAction SilentlyContinue)
}
if (!$running) {
    New-Item -ItemType Directory -Path $data -Force | Out-Null
    Start-Process -FilePath $node -ArgumentList '--import tsx services/local-agent/src/main.ts' -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput (Join-Path $data 'runtime.log') -RedirectStandardError (Join-Path $data 'runtime-error.log')
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 250
        if (Test-Path -LiteralPath $launchFile) {
            $launch = Get-Content -LiteralPath $launchFile -Raw | ConvertFrom-Json
            if (Get-Process -Id $launch.pid -ErrorAction SilentlyContinue) { $running = $true; break }
        }
    }
}
if (!$running) { throw '로컬 에이전트를 시작하지 못했습니다.' }
if (!$Background) { Start-Process $launch.url }
Write-Output 'PASS'
