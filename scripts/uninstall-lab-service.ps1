param([switch]$StopServers)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'lab-runtime.ps1')
$task=Get-ScheduledTask -TaskName $LabTaskName -ErrorAction SilentlyContinue
if($task -and $task.Actions.Arguments -like ('*'+$LabSupervisor+'*')){Stop-ScheduledTask -TaskName $LabTaskName -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName $LabTaskName -Confirm:$false}
if(Test-Path -LiteralPath $LabStartupLink){
    $shortcut=(New-Object -ComObject WScript.Shell).CreateShortcut($LabStartupLink)
    if($shortcut.Arguments.Contains($LabSupervisor)){Remove-Item -LiteralPath $LabStartupLink}
}
$supervisor=Get-LabOwnedProcess (Join-Path $LabDirectory 'supervisor.pid') $LabSupervisor
if($supervisor){Stop-Process -Id $supervisor.ProcessId -ErrorAction SilentlyContinue}
if($StopServers){
    foreach($item in @(@{port=5188;folder='review-preview';script='serve-review-preview.mjs'},@{port=5190;folder='work-preview';script='serve-work-preview.ts'},@{port=5190;folder='live-links';script='serve-real-links.mjs'})){
        $owned=Get-LabOwnedProcess (Join-Path $LabRepo ".work/$($item.folder)/server.pid") (Join-Path $PSScriptRoot $item.script) $item.port
        if($owned){Stop-Process -Id $owned.ProcessId -ErrorAction SilentlyContinue}
    }
}
if(Test-Path -LiteralPath $LabInstallPath){Remove-Item -LiteralPath $LabInstallPath}
Write-Output 'UNINSTALLED automatic startup; data and Docker/Supabase preserved.'
