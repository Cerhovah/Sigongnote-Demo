#requires -Version 7.0
[CmdletBinding()]
param([switch]$Json, [switch]$Strict, [int]$AndroidApi = 36)

$ErrorActionPreference = 'Continue'
$checks = [System.Collections.Generic.List[object]]::new()
function Add-Check([string]$Name, [bool]$Ready, [string]$Detail, [string]$Scope = 'build') {
    $checks.Add([pscustomobject]@{ component=$Name; ready=$Ready; detail=$Detail; scope=$Scope })
}
function Find-Tool([string]$Name, [string[]]$Fallback = @()) {
    $found = Get-Command $Name -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    foreach ($candidate in $Fallback) { if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate } }
    return $null
}
function Read-Version([string]$Exe, [string[]]$ToolArgs) {
    if (-not $Exe) { return '' }
    $captured = & $Exe @ToolArgs 2>&1
    if ($LASTEXITCODE -ne 0) { return '' }
    return (($captured | ForEach-Object { $_.ToString() }) -join "`n").Trim()
}

$git = Read-Version (Find-Tool 'git') @('--version')
Add-Check 'Git' ($git -match '^git version') $git
$node = Read-Version (Find-Tool 'node') @('--version')
Add-Check 'Node 24 LTS' ($node -match '^v24\.') $node
$npm = Read-Version (Find-Tool 'npm.cmd') @('--version')
Add-Check 'npm' ([bool]$npm) $npm
$uvExe = Find-Tool 'uv' @((Join-Path $env:USERPROFILE '.local\bin\uv.exe'))
$uv = Read-Version $uvExe @('--version')
Add-Check 'uv' ([bool]$uv) $uv
$pythonExe = $null
if ($uvExe) {
    $pythonPath = & $uvExe python find --no-python-downloads 3.13 2>$null
    if ($LASTEXITCODE -eq 0 -and $pythonPath) { $pythonExe = $pythonPath.ToString().Trim() }
}
if (-not $pythonExe) { $pythonExe = Find-Tool 'python3.13' @((Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313\python.exe')) }
$python = Read-Version $pythonExe @('--version')
Add-Check 'Python 3.13' ($python -match '^Python 3\.13\.') $python 'parser'
$java = Read-Version (Find-Tool 'java') @('-version')
Add-Check 'JDK 17' ($java -match 'version "17\.') (($java -split "`n")[0]) 'android'
$javac = Read-Version (Find-Tool 'javac') @('-version')
Add-Check 'javac 17' ($javac -match '^javac 17\.') $javac 'android'
$dotnet = Read-Version (Find-Tool 'dotnet') @('--list-sdks')
$dotnetVersions = (($dotnet -split "`n" | ForEach-Object { ($_ -split ' ')[0] }) -join ', ')
Add-Check '.NET SDK 10' ($dotnet -match '(?m)^10\.') $dotnetVersions 'windows'
$ghExe = Find-Tool 'gh' @((Join-Path $env:ProgramFiles 'GitHub CLI\gh.exe'))
$gh = Read-Version $ghExe @('--version')
Add-Check 'GitHub CLI' ([bool]$gh) (($gh -split "`n")[0]) 'optional'
$adb = Read-Version (Find-Tool 'adb') @('version')
Add-Check 'adb' ([bool]$adb) (($adb -split "`n")[0]) 'android'
$sdkRoot = $env:ANDROID_HOME
if (-not $sdkRoot) { $sdkRoot = $env:ANDROID_SDK_ROOT }
if (-not $sdkRoot) { $sdkRoot = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$sdkReady = Test-Path -LiteralPath (Join-Path $sdkRoot "platforms\android-$AndroidApi\android.jar") -PathType Leaf
Add-Check "Android SDK API $AndroidApi" $sdkReady $(if ($sdkReady) {'platform installed'} else {'missing; complete Android Studio SDK Manager setup'}) 'android'
$managerReady = Test-Path -LiteralPath (Join-Path $sdkRoot 'cmdline-tools\latest\bin\sdkmanager.bat') -PathType Leaf
Add-Check 'Android SDK command-line tools' $managerReady $(if ($managerReady) {'installed'} else {'missing'}) 'android'
$dockerExe = Find-Tool 'docker' @((Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe'))
$docker = Read-Version $dockerExe @('version','--format','{{.Server.Version}}')
Add-Check 'Docker server' ([bool]$docker) $(if ($docker) {$docker} else {'not installed or not running; requires user setup'}) 'local-backend'
$webview = @()
foreach ($key in @('HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients','HKCU:\Software\Microsoft\EdgeUpdate\Clients')) {
    Get-ChildItem -LiteralPath $key -ErrorAction SilentlyContinue | ForEach-Object {
        $entry = Get-ItemProperty -LiteralPath $_.PSPath
        if ($entry.name -match 'WebView2') { $webview += $entry.pv }
    }
}
Add-Check 'WebView2 runtime' ([bool]$webview.Count) ($webview -join ', ') 'windows'
$report = [pscustomobject]@{
    checked_at = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK')
    checks = $checks
    required_ready = @($checks | Where-Object { -not $_.ready -and $_.scope -ne 'optional' }).Count -eq 0
    note = 'Read-only inventory. Does not inspect credentials, accept licenses, install tools, start services, or prove app build/runtime behavior.'
}
if ($Json) { $report | ConvertTo-Json -Depth 5 } else { $checks | Format-Table component,ready,detail,scope -Wrap; Write-Output $report.note }
if ($Strict -and -not $report.required_ready) { exit 1 }
