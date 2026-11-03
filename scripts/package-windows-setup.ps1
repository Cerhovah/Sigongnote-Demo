param(
 [Parameter(Mandatory=$true)][string]$PackageZip,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedManifestSha256,
 [Parameter(Mandatory=$true)][string]$OutputPath
)
$ErrorActionPreference='Stop'
$zip=(Resolve-Path -LiteralPath $PackageZip).Path
$output=[IO.Path]::GetFullPath($OutputPath)
if([IO.Path]::GetExtension($output) -ne '.exe'){throw 'OutputPath must be an EXE'}
if(Test-Path -LiteralPath $output){throw 'Refusing to overwrite an existing installer'}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=[IO.Compression.ZipFile]::OpenRead($zip)
try {
 $entry=$archive.GetEntry('install-manifest.json')
 if(!$entry){throw 'Package installation manifest is missing'}
 $stream=$entry.Open();$digest=[Security.Cryptography.SHA256]::Create()
 try {$manifestHash=[BitConverter]::ToString($digest.ComputeHash($stream)).Replace('-','')}
 finally {$stream.Dispose();$digest.Dispose()}
 if($manifestHash -ne $ExpectedManifestSha256){throw 'Package manifest does not match the requested release'}
} finally {$archive.Dispose()}
$iexpress=Join-Path $env:WINDIR 'System32\iexpress.exe'
if(!(Test-Path -LiteralPath $iexpress)){throw 'Windows IExpress is unavailable'}
# IExpress SED files use the Windows code page. Keep every package path ASCII.
$stage=Join-Path $env:TEMP ('sgn-setup-'+[guid]::NewGuid().ToString('N'))
if($stage -match '[^\x00-\x7F]'){throw 'IExpress needs an ASCII temporary path'}
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item -LiteralPath $zip -Destination (Join-Path $stage 'payload.zip')
$utf8Bom=New-Object Text.UTF8Encoding($true)
foreach($name in @('windows-setup.ps1','install-windows-client.ps1')){
 $target=if($name -eq 'windows-setup.ps1'){'setup.ps1'}else{$name}
 [IO.File]::WriteAllText((Join-Path $stage $target),[IO.File]::ReadAllText((Join-Path $PSScriptRoot $name)),$utf8Bom)
}
@{schema=1;packageSha256=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower();manifestSha256=$ExpectedManifestSha256.ToLower()} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'setup-release.json') -Encoding utf8
$targetExe=Join-Path $stage 'Sigongnote-Setup.exe'
$sed=@"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=%InstallPrompt%
DisplayLicense=%DisplayLicense%
FinishMessage=%FinishMessage%
TargetName=%TargetName%
FriendlyName=%FriendlyName%
AppLaunched=%AppLaunched%
PostInstallCmd=%PostInstallCmd%
AdminQuietInstCmd=%AdminQuietInstCmd%
UserQuietInstCmd=%UserQuietInstCmd%
SourceFiles=SourceFiles
[Strings]
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$targetExe
FriendlyName=Sigongnote
AppLaunched=powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File setup.ps1
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
FILE0="payload.zip"
FILE1="setup.ps1"
FILE2="install-windows-client.ps1"
FILE3="setup-release.json"
[SourceFiles]
SourceFiles0=$stage\
[SourceFiles0]
%FILE0%=
%FILE1%=
%FILE2%=
%FILE3%=
"@
$sedPath=Join-Path $stage 'setup.sed'
[IO.File]::WriteAllText($sedPath,$sed,[Text.Encoding]::ASCII)
$process=Start-Process -FilePath $iexpress -ArgumentList @('/N','/Q',$sedPath) -Wait -PassThru -WindowStyle Hidden
if($process.ExitCode -ne 0 -or !(Test-Path -LiteralPath $targetExe)){throw 'IExpress packaging failed'}
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($output)) -Force | Out-Null
Copy-Item -LiteralPath $targetExe -Destination $output
[pscustomobject]@{status='packaged';path=$output;sha256=(Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLower();manifestSha256=$ExpectedManifestSha256.ToLower()} | ConvertTo-Json -Compress
