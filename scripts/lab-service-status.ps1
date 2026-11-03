param()
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'lab-runtime.ps1')
$installation=if(Test-Path -LiteralPath $LabInstallPath){Get-Content -LiteralPath $LabInstallPath -Raw|ConvertFrom-Json}else{$null}
$registered=$false
if($installation.mode -eq 'scheduled-task'){
    $task=Get-ScheduledTask -TaskName $LabTaskName -ErrorAction SilentlyContinue
    $registered=[bool]($task -and $task.Settings.Enabled -and @($task.Actions | Where-Object {$_.Arguments -and $_.Arguments.Contains($LabSupervisor)}).Count)
}elseif($installation.mode -eq 'user-startup' -and (Test-Path -LiteralPath $LabStartupLink)){
    $link=(New-Object -ComObject WScript.Shell).CreateShortcut($LabStartupLink)
    $registered=$link.Arguments.Contains($LabSupervisor)
}
$state=if(Test-Path -LiteralPath $LabStatePath){Get-Content -LiteralPath $LabStatePath -Raw|ConvertFrom-Json}else{$null}
$supervisor=Get-LabOwnedProcess (Join-Path $LabDirectory 'supervisor.pid') $LabSupervisor
$recent=$state -and ([DateTime]::UtcNow-([DateTime]$state.checkedAt).ToUniversalTime()).TotalSeconds -lt 210
$review=Get-LabHealth 5188;$work=Get-LabHealth 5190
@{installed=$registered;startup=$installation.mode;supervisorRunning=[bool]$supervisor;heartbeatRecent=[bool]$recent;checkedAt=$state.checkedAt;reviewReady=($review.service -eq 'sigongnote-review-preview');workReady=($work.service -eq 'sigongnote-live-links' -and $work.ready);worker=$work.workerStatus;recoveries=$state.recoveries;lastEvent=$state.lastEvent;scope='current-user feedback; real cloud redirect';urls=@('http://127.0.0.1:5188/','https://sigongnote-api.onrender.com/')}|ConvertTo-Json -Depth 4
