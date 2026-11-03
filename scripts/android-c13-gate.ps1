param([string]$Serial = 'emulator-5554')

$ErrorActionPreference = 'Stop'
if (-not $Serial.StartsWith('emulator-')) { throw 'C13 gate requires an emulator serial' }
$testClass = 'com.sigongnote.app.CaptureRecoveryDeviceTest#queuedFixtureSurvivesProcessRestart'
$runner = 'com.sigongnote.app.test/androidx.test.runner.AndroidJUnitRunner'
$fixtureId = [guid]::NewGuid().ToString()
$projectRoot = Split-Path $PSScriptRoot -Parent

function Invoke-Adb([string[]]$Arguments) {
    $result = & adb -s $Serial @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($result -join "`n") }
    return ($result -join "`n")
}

function Assert-Fixture([string]$Mode, [bool]$ExpectOffline) {
    $arguments = @('shell','am','instrument','-w','-e','class',$testClass,
        '-e','c13Mode',$Mode,'-e','c13FixtureId',$fixtureId)
    if ($ExpectOffline) { $arguments += @('-e','c13ExpectOffline','true') }
    $arguments += $runner
    $result = Invoke-Adb $arguments
    if ($result -notmatch 'OK \(1 test\)') { throw "C13 $Mode instrumentation failed: $result" }
}

$originalAirplane = Invoke-Adb @('shell','cmd','connectivity','airplane-mode')
Invoke-Adb @('install','-r',(Join-Path $projectRoot 'apps/android/app/build/outputs/apk/debug/app-debug.apk')) | Out-Null
Invoke-Adb @('install','-r',(Join-Path $projectRoot 'apps/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk')) | Out-Null
try {
    Assert-Fixture 'seed' $false
    Invoke-Adb @('shell','am','force-stop','com.sigongnote.app') | Out-Null
    Invoke-Adb @('shell','cmd','connectivity','airplane-mode','enable') | Out-Null
    $idle = Invoke-Adb @('shell','cmd','deviceidle','force-idle')
    if ($idle -notmatch 'idle') { throw "Doze activation failed: $idle" }
    Assert-Fixture 'verify' $true
} finally {
    Invoke-Adb @('shell','cmd','deviceidle','unforce') | Out-Null
    if ($originalAirplane -match 'enabled') {
        Invoke-Adb @('shell','cmd','connectivity','airplane-mode','enable') | Out-Null
    } else {
        Invoke-Adb @('shell','cmd','connectivity','airplane-mode','disable') | Out-Null
    }
}
Assert-Fixture 'verify' $false
Assert-Fixture 'cleanup' $false
Write-Output 'PASS C13 emulator force-stop/Doze/offline/restart queue retention'
