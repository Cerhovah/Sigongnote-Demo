param([string[]]$Tasks = @(':app:testStandardDebugUnitTest', ':app:testSmsRoleDebugUnitTest',
    ':app:assembleStandardDebug', ':app:assembleSmsRoleDebug', ':app:assembleStandardRelease'),
    [switch]$UpdateLocks,
    [switch]$PrivateSmsPilot,
    [switch]$IsolatedDeviceTest,
    [string]$DeviceTestClass)
$ErrorActionPreference = 'Stop'
if (($Tasks -contains ':app:assembleSmsSyncRelease') -and !$PrivateSmsPilot) {
    throw 'Private SMS release requires -PrivateSmsPilot'
}
if ($DeviceTestClass -and (!$IsolatedDeviceTest -or $DeviceTestClass -notmatch '^com\.sigongnote\.app\.[A-Za-z0-9]+Test$')) {
    throw 'Device test class requires an isolated application and a named test class'
}
if ($IsolatedDeviceTest -and @($Tasks | Where-Object { $_ -match 'Release' }).Count) {
    throw 'Isolated device tests are debug only'
}
function Test-BaselinePermissions([string[]]$Lines) {
    $allowed = @('android.permission.RECORD_AUDIO', 'android.permission.INTERNET', 'android.permission.ACCESS_NETWORK_STATE',
        'android.permission.WAKE_LOCK', 'android.permission.RECEIVE_BOOT_COMPLETED',
        'com.sigongnote.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION')
    if ($IsolatedDeviceTest) { $allowed += 'com.sigongnote.app.devtest.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION' }
    return @($Lines | Where-Object {
        $_ -match '^uses-permission(?:-sdk-\d+)?:' -and
        ($_ -notmatch "name='([^']+)'" -or $Matches[1] -notin $allowed)
    }).Count -eq 0
}
if (Test-BaselinePermissions @("uses-permission: name='android.permission.SEND_SMS'")) {
    throw 'Permission gate negative control failed'
}
if (Test-BaselinePermissions @("uses-permission-sdk-23: name='android.permission.SEND_SMS'")) {
    throw 'SDK permission gate negative control failed'
}
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$drive = @('Z:', 'Y:', 'X:', 'W:', 'V:') | Where-Object { -not (Test-Path "$_\") } | Select-Object -First 1
if (-not $drive) { throw 'No free temporary drive for Android tests' }
try {
    & subst $drive $repo
    if ($LASTEXITCODE -ne 0) { throw 'Could not map Android build path' }
    $gradle = "$drive\apps\android\gradlew.bat"
    $lockFlag = if ($UpdateLocks) { @('--write-locks') } else { @() }
    $gradleArgs = @('-p', "$drive\apps\android") + $Tasks + $lockFlag +
        @('--no-daemon', '--quiet')
    if ($IsolatedDeviceTest) { $gradleArgs += '-PISOLATED_DEVICE_TEST=true' }
    if ($PrivateSmsPilot) { $gradleArgs += '-PPRIVATE_SMS_PILOT=true' }
    if ($DeviceTestClass) { $gradleArgs += "-Pandroid.testInstrumentationRunnerArguments.class=$DeviceTestClass" }
    & $gradle @gradleArgs
    if ($LASTEXITCODE -ne 0) { throw "Android Gradle tasks failed ($LASTEXITCODE)" }
    if (@($Tasks | Where-Object { $_ -like ':app:assemble*' }).Count -gt 0) {
        $sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android/Sdk' }
        $aapt = Get-ChildItem (Join-Path $sdk 'build-tools') -Directory |
            Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName 'aapt.exe' } |
            Where-Object { Test-Path $_ } | Select-Object -First 1
        if (-not $aapt) { throw 'Android aapt unavailable for merged manifest check' }
        $variants = @(
            @{ Task=':app:assembleStandardDebug'; Path='standard\debug\app-standard-debug.apk'; Role=$false },
            @{ Task=':app:assembleStandardRelease'; Path='standard\release\app-standard-release-unsigned.apk'; Role=$false },
            @{ Task=':app:assembleSmsSyncDebug'; Path='smsSync\debug\app-smsSync-debug.apk'; Role=$false; Sync=$true },
            @{ Task=':app:assembleSmsSyncRelease'; Path='smsSync\release\app-smsSync-release-unsigned.apk'; Role=$false; Sync=$true },
            @{ Task=':app:assembleSmsRoleDebug'; Path='smsRole\debug\app-smsRole-debug.apk'; Role=$true }
        )
        foreach ($variant in $variants) {
            if ($Tasks -notcontains $variant.Task) { continue }
            $apk = "$drive\apps\android\app\build\outputs\apk\$($variant.Path)"
            if (-not (Test-Path $apk)) { throw "$variant Android APK missing" }
            $permissions = & $aapt dump permissions $apk
            if ($LASTEXITCODE -ne 0) { throw "$($variant.Task) APK permission inspection failed" }
            if ($variant.Sync) {
                if (@($permissions | Where-Object { $_ -match 'android.permission.(SEND_SMS|RECEIVE_SMS|RECEIVE_MMS|RECEIVE_WAP_PUSH|READ_CALL_LOG)' }).Count) { throw 'Read-only SMS build declares a forbidden permission' }
                if (-not @($permissions | Where-Object { $_ -match "name='android.permission.READ_SMS'" }).Count) { throw 'Read-only SMS permission missing' }
                $filtered = @($permissions | Where-Object { $_ -notmatch "name='android.permission.READ_SMS'" -and $_ -notmatch 'com.sigongnote.app(?:.devtest)?.smssync.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION' })
                if (-not (Test-BaselinePermissions $filtered)) { throw 'Read-only SMS build declares an unexpected permission' }
            } elseif ($variant.Role) {
                $required = @('READ_SMS','SEND_SMS','RECEIVE_SMS','RECEIVE_MMS','RECEIVE_WAP_PUSH') |
                    ForEach-Object { "android.permission.$_" }
                foreach ($permission in $required) {
                    if (-not (@($permissions | Where-Object { $_ -match "name='$permission'" }).Count)) {
                        throw "SMS role APK missing $permission"
                    }
                }
                if (@($permissions | Where-Object { $_ -match 'android.permission.READ_CALL_LOG' }).Count) {
                    throw 'SMS role APK unexpectedly declares Call Log access'
                }
            } elseif (-not (Test-BaselinePermissions $permissions)) {
                throw "$($variant.Task) baseline APK declares an unapproved permission"
            }
        }
    }
    Write-Output 'PASS'
} finally {
    & subst $drive /D | Out-Null
}
