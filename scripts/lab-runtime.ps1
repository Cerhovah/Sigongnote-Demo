# Shared by the local lab supervisor, installer and status command. No credentials are read.
$LabRepo=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$LabDirectory=Join-Path $LabRepo '.work/lab-service'
$LabId=([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($LabRepo.ToLowerInvariant())))).Substring(0,12)
$LabTaskName="SigongnoteLab-$LabId"
$LabSupervisor=Join-Path $LabRepo 'scripts/supervise-lab.ps1'
$LabStartupLink=Join-Path ([Environment]::GetFolderPath('Startup')) "$LabTaskName.lnk"
$LabStatePath=Join-Path $LabDirectory 'status.json'
$LabInstallPath=Join-Path $LabDirectory 'installation.json'
function Get-LabHealth([int]$Port) {
    try { return Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 3 } catch { return $null }
}
function Get-LabOwnedProcess([string]$PidFile,[string]$Script,[int]$Port=0) {
    if(-not (Test-Path -LiteralPath $PidFile)){return $null}
    $processNumber=0
    if(-not [int]::TryParse(([IO.File]::ReadAllText($PidFile)).Trim(),[ref]$processNumber)){return $null}
    $found=Get-CimInstance Win32_Process -Filter "ProcessId=$processNumber" -ErrorAction SilentlyContinue
    if(-not $found -or -not $found.CommandLine -or -not $found.CommandLine.Contains($Script)){return $null}
    if($Port -and (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).OwningProcess -notcontains $processNumber){return $null}
    return $found
}
function Save-LabJson([string]$Path,$Value) {
    $temporary="$Path.new-$PID"
    [IO.File]::WriteAllText($temporary,($Value|ConvertTo-Json -Depth 5))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}
