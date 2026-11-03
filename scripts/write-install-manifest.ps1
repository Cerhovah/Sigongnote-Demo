param([Parameter(Mandatory=$true)][string]$Directory,[Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$')][string]$Version)
$ErrorActionPreference='Stop'
$root=(Resolve-Path -LiteralPath $Directory).Path
if(!(Test-Path -LiteralPath (Join-Path $root 'Sigongnote.Windows.exe'))){throw 'Windows build is missing'}
$files=@(Get-ChildItem -LiteralPath $root -File -Recurse | Where-Object {$_.Name -ne 'install-manifest.json'} | Sort-Object FullName | ForEach-Object {
 if($_.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked package file'}
 $relative=[IO.Path]::GetRelativePath($root,$_.FullName).Replace('\','/')
 if($relative -notmatch '^[a-zA-Z0-9_+.\-]+(?:/[a-zA-Z0-9_+.\-]+)*$' -or @($relative.Split('/') | Where-Object {$_ -in @('.','..')}).Count){throw 'Unsupported installation path'}
 @{path=$relative;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower()}
})
@{schema=1;version=$Version;entry='Sigongnote.Windows.exe';files=$files}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $root 'install-manifest.json') -Encoding utf8
