param(
    [Parameter(Mandatory=$true)][string]$PublicConfigPath,
    [Parameter(Mandatory=$false)][string]$OutputDirectory,
    [switch]$ValidateOnly,
    [ValidateRange(2,2100000000)][int]$AndroidVersionCode=23,
    [ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.]+)?$')][string]$AndroidVersionName='0.3.0-rc.13'
)
$ErrorActionPreference='Stop'
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$config=Get-Content -LiteralPath $PublicConfigPath -Raw | ConvertFrom-Json
$expected=@('apiBaseUrl','supabaseOrigin','publishableKey','googleEnabled')
$optional=@('naverEnabled','kakaoEnabled')
if (@($config.PSObject.Properties.Name | Where-Object {$_ -notin ($expected+$optional)}).Count -or
    @($expected | Where-Object {$_ -notin $config.PSObject.Properties.Name}).Count -or
    ($config.googleEnabled -isnot [bool])) {throw 'Only public client settings are accepted'}
foreach($name in $optional) {
    if($name -in $config.PSObject.Properties.Name -and $config.$name -isnot [bool]) {throw 'Provider flags must be booleans'}
}
$loginProviders=@()
if($config.googleEnabled -eq $true) {$loginProviders+='google'}
if($config.naverEnabled -eq $true) {$loginProviders+='custom:naver'}
if($config.kakaoEnabled -eq $true) {$loginProviders+='custom:kakao'}
foreach($value in @($config.apiBaseUrl,$config.supabaseOrigin)) {
    $uri=[Uri]$value
    if($uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') {
        throw 'HTTPS origins required'
    }
}
if($config.supabaseOrigin -notmatch '^https://[a-z]{20}\.supabase\.co/?$' -or
   $config.publishableKey -notmatch '^sb_publishable_[A-Za-z0-9_-]{20,}$') {
    throw 'Dedicated Supabase public settings required'
}
if($ValidateOnly) {Write-Output ('PASS providers='+($loginProviders -join ','));return}
if([string]::IsNullOrWhiteSpace($OutputDirectory)) {throw 'OutputDirectory required for packaging'}
if(Test-Path -LiteralPath $OutputDirectory) {throw 'Use a new output directory; existing packages are preserved'}
$output=New-Item -ItemType Directory -Path $OutputDirectory
$signing=Join-Path $env:LOCALAPPDATA 'Sigongnote/signing'
New-Item -ItemType Directory -Force -Path $signing | Out-Null
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls $signing /inheritance:r /grant:r "*$($sid):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if($LASTEXITCODE -ne 0) {throw 'Signing directory protection failed'}
$keyStore=Join-Path $signing 'android-release.p12'
$passwordFile=Join-Path $signing 'android-release.password'
if((Test-Path $keyStore) -ne (Test-Path $passwordFile)) {throw 'Signing material is incomplete; never overwrite it'}
if(-not (Test-Path $keyStore)) {
    $password=[Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    [IO.File]::WriteAllText($passwordFile,$password)
    $password=$null
    & (Join-Path $env:JAVA_HOME 'bin/keytool.exe') -genkeypair -keystore $keyStore -storetype PKCS12 `
        -storepass:file $passwordFile -keypass:file $passwordFile -alias sigongnote-release `
        -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=Sigongnote Android, O=Sigongnote, C=KR' `
        *> (Join-Path $output 'signing.log')
    if($LASTEXITCODE -ne 0) {throw 'Signing key creation failed; inspect the protected setup'}
}
$tasks=@(':app:testStandardDebugUnitTest',':app:assembleStandardRelease',"-PAPP_VERSION_CODE=$AndroidVersionCode","-PAPP_VERSION_NAME=$AndroidVersionName",
    "-PCLOUD_API_ORIGIN=$($config.apiBaseUrl)","-PCLOUD_AUTH_ORIGIN=$($config.supabaseOrigin)",
    "-PCLOUD_PUBLISHABLE_KEY=$($config.publishableKey)","-PCLOUD_LOGIN_PROVIDERS=$($loginProviders -join ',')")
$unsigned=Join-Path $repo 'apps/android/app/build/outputs/apk/standard/release/app-standard-release-unsigned.apk'
# Delete only the generated artifact, so a failed build cannot sign an older APK.
$buildRoot=[IO.Path]::GetFullPath((Join-Path $repo 'apps/android/app/build'))+[IO.Path]::DirectorySeparatorChar
if(-not [IO.Path]::GetFullPath($unsigned).StartsWith($buildRoot,[StringComparison]::OrdinalIgnoreCase)) {
    throw 'Generated APK path escaped the build directory'
}
if(Test-Path -LiteralPath $unsigned) {Remove-Item -LiteralPath $unsigned}
$buildStarted=[DateTime]::UtcNow
& (Join-Path $PSScriptRoot 'check-android.ps1') -Tasks $tasks *> (Join-Path $output 'android-build.log')
if(-not (Test-Path -LiteralPath $unsigned) -or
    (Get-Item -LiteralPath $unsigned).LastWriteTimeUtc -lt $buildStarted.AddSeconds(-2)) {
    throw 'Android build did not produce a fresh APK'
}
$archive=[IO.Compression.ZipFile]::OpenRead($unsigned)
try {
    $dexText=foreach($entry in $archive.Entries | Where-Object {$_.FullName -match '^classes\d*\.dex$'}) {
        $stream=$entry.Open();$buffer=[IO.MemoryStream]::new()
        try {$stream.CopyTo($buffer);[Text.Encoding]::UTF8.GetString($buffer.ToArray())}
        finally {$stream.Dispose();$buffer.Dispose()}
    }
    $dexText=$dexText -join ''
    foreach($value in @($config.apiBaseUrl,$config.supabaseOrigin,$config.publishableKey,($loginProviders -join ','))) {
        if(-not $dexText.Contains($value)) {throw 'APK public connection settings do not match this release'}
    }
    if($dexText -match 'sb_secret_[A-Za-z0-9_-]{20,}') {throw 'APK contains a server credential'}
} finally {$archive.Dispose()}
$tools=Get-ChildItem (Join-Path $env:ANDROID_HOME 'build-tools') -Directory |
    Where-Object {$_.Name -match '^\d+\.\d+\.\d+$'} |
    Sort-Object {[Version]$_.Name} -Descending | Select-Object -First 1
$apk=Join-Path $output 'Sigongnote-Android.apk'
& (Join-Path $tools.FullName 'apksigner.bat') sign --ks $keyStore --ks-key-alias sigongnote-release `
    --ks-pass "file:$passwordFile" --out $apk $unsigned
if($LASTEXITCODE -ne 0) {throw 'APK signing failed'}
& (Join-Path $tools.FullName 'apksigner.bat') verify --verbose --print-certs $apk *> (Join-Path $output 'apk-signature.log')
if($LASTEXITCODE -ne 0) {throw 'APK signature verification failed'}
& (Join-Path $tools.FullName 'zipalign.exe') -c -P 16 4 $apk *> (Join-Path $output 'apk-alignment.log')
if($LASTEXITCODE -ne 0) {throw 'APK alignment verification failed'}
& dotnet test (Join-Path $repo 'apps/windows/tests/Sigongnote.Windows.Tests.csproj') `
    --filter 'FullyQualifiedName~BundledConnectionTests|FullyQualifiedName~GoogleLoginTests|FullyQualifiedName~IdentityLinkTests|FullyQualifiedName~WorkspaceBootstrapTests' `
    *> (Join-Path $output 'windows-tests.log')
if($LASTEXITCODE -ne 0) {throw 'Windows package tests failed'}
$windows=Join-Path $output 'Windows'
& dotnet publish (Join-Path $repo 'apps/windows/Sigongnote.Windows.csproj') -c Release -r win-x64 `
    --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
    "-p:NuGetLockFilePath=$(Join-Path $repo 'apps/windows/packages.publish.lock.json')" -p:RestoreLockedMode=true `
    -p:DebugType=None -o $windows *> (Join-Path $output 'windows-build.log')
if($LASTEXITCODE -ne 0) {throw 'Windows package build failed'}
& (Join-Path $PSScriptRoot 'package-windows-local-agent.ps1') -WindowsDirectory $windows
$config | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $windows 'connection.json') -Encoding utf8
$sourceHead=(& git -C $repo rev-parse HEAD).Trim()
$workspaceDirty=[bool](& git -C $repo status --porcelain --untracked-files=normal)
# Only actual build-input changes affect sourceDirty; preserve unrelated notes and CRLF-only status.
$inputs=@('apps','packages','services','scripts','package.json','package-lock.json','tsconfig.json','tsconfig.base.json')
$sourceDirty=(@(& git -C $repo diff --name-only HEAD -- $inputs).Count + @(& git -C $repo ls-files --others --exclude-standard -- $inputs).Count) -gt 0
$sharedBuild=Get-Content -LiteralPath (Join-Path $repo '.work/native-assets/work/build.json') -Raw | ConvertFrom-Json
$buildInfo=@{
    schema=1;version=$AndroidVersionName;androidVersionCode=$AndroidVersionCode
    sourceHead=$sourceHead;sourceDirty=$sourceDirty;workspaceDirty=$workspaceDirty;sharedUiHash=$sharedBuild.sourceHash
    builtAt=[DateTime]::UtcNow.ToString('o');apiOrigin=$config.apiBaseUrl
}
$buildInfo | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'BUILD.json') -Encoding utf8
Copy-Item -LiteralPath (Join-Path $output 'BUILD.json') -Destination (Join-Path $windows 'BUILD.json')
& (Join-Path $repo 'scripts/write-install-manifest.ps1') -Directory $windows -Version $AndroidVersionName
if($LASTEXITCODE -ne 0){throw 'Install manifest failed'}
Copy-Item -LiteralPath (Join-Path $repo 'scripts/install-windows-client.ps1') -Destination (Join-Path $output 'install-windows-client.ps1')
(Get-FileHash -LiteralPath (Join-Path $windows 'install-manifest.json') -Algorithm SHA256).Hash | Set-Content -LiteralPath (Join-Path $output 'WINDOWS-MANIFEST-SHA256.txt')
Compress-Archive -Path (Join-Path $windows '*') -DestinationPath (Join-Path $output 'Sigongnote-Windows.zip')
& (Join-Path $PSScriptRoot 'package-windows-setup.ps1') -PackageZip (Join-Path $output 'Sigongnote-Windows.zip') -ExpectedManifestSha256 ((Get-FileHash -LiteralPath (Join-Path $windows 'install-manifest.json') -Algorithm SHA256).Hash) -OutputPath (Join-Path $output 'Sigongnote-Setup.exe')
Get-FileHash $apk,(Join-Path $output 'Sigongnote-Windows.zip'),(Join-Path $output 'Sigongnote-Setup.exe') -Algorithm SHA256 |
    ForEach-Object {"$($_.Hash)  $([IO.Path]::GetFileName($_.Path))"} |
    Set-Content -LiteralPath (Join-Path $output 'SHA256SUMS.txt') -Encoding utf8
Write-Output 'PASS'
