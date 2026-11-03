param(
  [string]$Classes = 'com.sigongnote.app.WorkScreenDeviceTest,com.sigongnote.app.WorkLedgerDeviceTest',
  [string]$OutputDirectory = '.work/device/android',
  [string]$Serial = ''
)
# Real-device instrumentation over adb for the isolated test build (com.sigongnote.app.devtest).
# Builds standardDebug + its androidTest APK, installs both on the single attached device, runs the
# requested classes one by one through `am instrument`, and pulls the on-device transfer evidence.
# Never touches the installed public app (different application id) or the user's data.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$adb = if ($Serial) { "adb -s $Serial" } else { 'adb' }
$devices = @(& adb devices | Select-String -Pattern '^(\S+)\s+device$' | ForEach-Object { $_.Matches[0].Groups[1].Value })
if (-not $Serial -and $devices.Count -ne 1) { throw "Expected exactly one authorized device, found $($devices.Count). Pass -Serial to choose." }
$gradle = Join-Path $root 'apps/android/gradlew.bat'
& $gradle -p apps/android ':app:assembleStandardDebug' ':app:assembleStandardDebugAndroidTest' '-PISOLATED_DEVICE_TEST=true' '--no-daemon' | Tee-Object -FilePath (Join-Path $OutputDirectory 'gradle.log')
if ($LASTEXITCODE -ne 0) { throw 'Gradle build failed' }
$app = Get-ChildItem apps/android/app/build/outputs/apk/standard/debug -Filter '*.apk' | Select-Object -First 1
$test = Get-ChildItem apps/android/app/build/outputs/apk/androidTest/standard/debug -Filter '*.apk' | Select-Object -First 1
if (-not $app -or -not $test) { throw 'APK outputs missing' }
Invoke-Expression "$adb install -r -t `"$($app.FullName)`"" | Out-Null
Invoke-Expression "$adb install -r -t `"$($test.FullName)`"" | Out-Null
$runner = 'com.sigongnote.app.devtest.test/androidx.test.runner.AndroidJUnitRunner'
$results = @()
foreach ($class in ($Classes -split ',' | Where-Object { $_.Trim() })) {
  $name = $class.Trim()
  $log = Join-Path $OutputDirectory ("$name.log")
  $output = Invoke-Expression "$adb shell am instrument -w -r -e class $name $runner" 2>&1
  $output | Out-File -FilePath $log -Encoding utf8
  $failed = ($output | Select-String -Pattern 'INSTRUMENTATION_STATUS_CODE: -2|INSTRUMENTATION_STATUS_CODE: -1|FAILURES!!!|INSTRUMENTATION_RESULT: shortMsg=').Count -gt 0
  $results += [pscustomobject]@{ class = $name; passed = -not $failed; log = $log }
}
# On-device evidence written by the ledger test (mobile-transfer.json) and a screenshot for the report.
Invoke-Expression "$adb shell run-as com.sigongnote.app.devtest cat files/mobile-transfer.json" 2>$null | Out-File -FilePath (Join-Path $OutputDirectory 'mobile-transfer.json') -Encoding utf8
Invoke-Expression "$adb exec-out screencap -p" | Set-Content -Path (Join-Path $OutputDirectory 'screen.png') -AsByteStream
$model = (Invoke-Expression "$adb shell getprop ro.product.model").Trim()
[pscustomobject]@{ device = $model; serial = ($Serial -or $devices[0]); ran_at = (Get-Date).ToString('o'); results = $results } |
  ConvertTo-Json -Depth 4 | Out-File -FilePath (Join-Path $OutputDirectory 'report.json') -Encoding utf8
$results | Format-Table -AutoSize
if ($results | Where-Object { -not $_.passed }) { throw 'One or more device test classes failed' }
