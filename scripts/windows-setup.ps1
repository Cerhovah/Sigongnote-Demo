param(
 [string]$InstallRoot=(Join-Path $env:LOCALAPPDATA 'SigongnotePrograms'),
 [switch]$NoShortcut,
 [switch]$NoLaunch,
 [switch]$Quiet
)
$ErrorActionPreference='Stop'
$progress=$null
try {
 if(!$Quiet){
  Add-Type -AssemblyName System.Windows.Forms
  $progress=New-Object System.Windows.Forms.Form
  $progress.Text='시공노트';$progress.Width=380;$progress.Height=130
  $progress.StartPosition='CenterScreen';$progress.FormBorderStyle='FixedDialog';$progress.ControlBox=$false
  $progress.BackColor=[Drawing.Color]::White
  $label=New-Object System.Windows.Forms.Label
  $label.Text='시공노트를 준비하고 있어요…';$label.AutoSize=$true;$label.Left=28;$label.Top=28
  $label.Font=New-Object Drawing.Font('Malgun Gothic',12)
  $progress.Controls.Add($label);$progress.Show();[System.Windows.Forms.Application]::DoEvents()
 }
 $release=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'setup-release.json') -Raw -Encoding UTF8 | ConvertFrom-Json
 if($release.packageSha256 -notmatch '^[a-fA-F0-9]{64}$' -or $release.manifestSha256 -notmatch '^[a-fA-F0-9]{64}$'){throw 'Invalid installer release'}
 $zip=Join-Path $PSScriptRoot 'payload.zip'
 if((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $release.packageSha256){throw 'Package hash mismatch'}
 $unpack=Join-Path $PSScriptRoot ('payload-'+[guid]::NewGuid().ToString('N'))
 New-Item -ItemType Directory -Path $unpack | Out-Null
 Add-Type -AssemblyName System.IO.Compression.FileSystem
 $archive=[IO.Compression.ZipFile]::OpenRead($zip)
 try {
  foreach($entry in $archive.Entries){
   $target=[IO.Path]::GetFullPath((Join-Path $unpack $entry.FullName))
   if(!$target.StartsWith($unpack+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Package entry leaves extraction directory'}
  }
 } finally {$archive.Dispose()}
 Expand-Archive -LiteralPath $zip -DestinationPath $unpack
 $installer=Join-Path $PSScriptRoot 'install-windows-client.ps1'
 $result=& $installer -PackageDirectory $unpack -ExpectedManifestSha256 $release.manifestSha256 -InstallRoot $InstallRoot -NoShortcut:$NoShortcut
 $installed=$result | ConvertFrom-Json
 if($installed.status -ne 'installed'){throw 'Installation did not complete'}
 $slot=Join-Path ([IO.Path]::GetFullPath($InstallRoot)) ($installed.version+'-'+$release.manifestSha256.Substring(0,12).ToLower())
 if(!$NoLaunch){
  $stop=Start-Process -FilePath (Join-Path $slot 'Sigongnote.Windows.exe') -ArgumentList '--shutdown-for-update' -WorkingDirectory $slot -WindowStyle Hidden -Wait -PassThru
  if($stop.ExitCode -ne 0){throw 'The previous application could not finish its update shutdown'}
 }
 if($progress){$progress.Close();$progress.Dispose();$progress=$null}
 if(!$NoLaunch){Start-Process -FilePath (Join-Path $slot 'Sigongnote.Windows.exe') -WorkingDirectory $slot | Out-Null}
 [pscustomobject]@{status='installed';version=$installed.version;accountAndQueue='preserved';launched=(!$NoLaunch)} | ConvertTo-Json -Compress
} catch {
 if($progress){$progress.Close();$progress.Dispose()}
 if(!$Quiet){
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show('설치를 마치지 못했습니다. 설치 파일을 다시 받아 실행해 주세요. 기존 자료는 그대로 있습니다.','시공노트',[System.Windows.Forms.MessageBoxButtons]::OK,[System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
 }
 Write-Error $_
 exit 1
}
