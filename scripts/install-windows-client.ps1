param(
 [Parameter(Mandatory=$true)][string]$PackageDirectory,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedManifestSha256,
 [string]$InstallRoot=(Join-Path $env:LOCALAPPDATA 'SigongnotePrograms'),
 [switch]$NoShortcut
)
$ErrorActionPreference='Stop'
function Get-CanonicalInstallPath([string]$value){
 $full=[IO.Path]::GetFullPath($value)
 $pathRoot=[IO.Path]::GetPathRoot($full)
 if($full.Length -gt $pathRoot.Length){$full=$full.TrimEnd([char[]]@([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar))}
 return $full
}
$package=Get-CanonicalInstallPath ((Resolve-Path -LiteralPath $PackageDirectory).Path)
$root=Get-CanonicalInstallPath $InstallRoot
$state=Get-CanonicalInstallPath (Join-Path $env:LOCALAPPDATA 'Sigongnote')
if($root -eq $state -or $root.StartsWith($state+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Install directory must be separate from account and queue data'}
$manifestPath=Join-Path $package 'install-manifest.json'
if((Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash -ne $ExpectedManifestSha256){throw 'Manifest does not match the trusted release hash'}
$manifest=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if($manifest.schema -ne 1 -or $manifest.version -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$' -or $manifest.entry -ne 'Sigongnote.Windows.exe' -or !$manifest.files.Count){throw 'Invalid installation manifest'}
function Assert-PlainPath([string]$base,[string]$relative){
 $base=Get-CanonicalInstallPath $base
 if($relative -notmatch '^[a-zA-Z0-9_+.\-]+(?:/[a-zA-Z0-9_+.\-]+)*$' -or @($relative.Split('/') | Where-Object {$_ -in @('.','..')}).Count){throw 'Invalid package path'}
 $target=[IO.Path]::GetFullPath((Join-Path $base $relative))
 if(!$target.StartsWith($base+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Path leaves package'}
 $cursor=$target
 while($cursor -and $cursor.Length -ge $base.Length){if(Test-Path -LiteralPath $cursor){if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked paths cannot be installed'}};$cursor=[IO.Path]::GetDirectoryName($cursor)}
 return $target
}
$names=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach($file in $manifest.files){
 if(!$names.Add([string]$file.path) -or $file.sha256 -notmatch '^[a-fA-F0-9]{64}$'){throw 'Invalid package entry'}
 $source=Assert-PlainPath $package $file.path
 if((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $file.sha256){throw 'Package file is incomplete or changed'}
}
if(!$names.Contains($manifest.entry)){throw 'Executable missing'}
New-Item -ItemType Directory -Path $root -Force | Out-Null
if((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked install root is unsupported'}
$slot=Join-Path $root ($manifest.version+'-'+$ExpectedManifestSha256.Substring(0,12).ToLower())
if(Test-Path -LiteralPath $slot){
 $savedManifest=Assert-PlainPath $slot 'install-manifest.json'
 if((Get-FileHash -LiteralPath $savedManifest -Algorithm SHA256).Hash -ne $ExpectedManifestSha256){throw 'Existing installation is incomplete or changed; previous version remains available'}
 foreach($file in $manifest.files){if((Get-FileHash -LiteralPath (Assert-PlainPath $slot $file.path) -Algorithm SHA256).Hash -ne $file.sha256){throw 'Existing installation is changed; previous version remains available'}}
}else{
 $staging=$slot+'.staging-'+[guid]::NewGuid().ToString('N')
 New-Item -ItemType Directory -Path $staging | Out-Null
 foreach($file in $manifest.files){
  $target=Assert-PlainPath $staging $file.path
  New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $package $file.path) -Destination $target
  if((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $file.sha256){throw 'Staged file check failed; previous version remains available; retry installation'}
 }
 Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $staging 'install-manifest.json')
 # Both resolved move targets must remain inside the dedicated installation root.
 foreach($movePath in @($staging,$slot)){if(![IO.Path]::GetFullPath($movePath).StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid installation move'}}
 [IO.Directory]::Move($staging,$slot)
}
# The shortcut is switched only after every new file passed. No app/data directory is deleted.
if(!$NoShortcut){
 $link=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) '시공노트.lnk'))
 $link.TargetPath=Join-Path $slot $manifest.entry;$link.WorkingDirectory=$slot;$link.Save()
}
[pscustomobject]@{status='installed';version=$manifest.version;accountAndQueue='preserved';previousVersion='retained';launched=$false}|ConvertTo-Json -Compress
