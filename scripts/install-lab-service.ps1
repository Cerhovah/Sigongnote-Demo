param([switch]$Lan)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'lab-runtime.ps1')
New-Item -ItemType Directory -Path $LabDirectory -Force | Out-Null
$shellPath=Join-Path $PSHOME 'pwsh.exe'
$arguments='-NoProfile -WindowStyle Hidden -File "'+$LabSupervisor+'"'
if($Lan){$arguments+=' -Lan'}
$mode='scheduled-task'
try {
    $prior=Get-ScheduledTask -TaskName $LabTaskName -ErrorAction SilentlyContinue
    if($prior -and ($prior.Actions.Arguments -notcontains $arguments)){throw 'Existing task differs; preserved'}
    $user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
    $action=New-ScheduledTaskAction -Execute $shellPath -Argument $arguments -WorkingDirectory $LabRepo
    $trigger=New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable
    Register-ScheduledTask -TaskName $LabTaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Sigongnote local lab; existing data only, no passwords, current user login.' -Force | Out-Null
    Start-ScheduledTask -TaskName $LabTaskName
} catch {
    # Standard accounts may not register logon tasks. A per-user Startup link needs no elevation.
    $mode='user-startup'
    $shell=New-Object -ComObject WScript.Shell
    $shortcut=$shell.CreateShortcut($LabStartupLink)
    if((Test-Path -LiteralPath $LabStartupLink) -and ($shortcut.TargetPath -ne $shellPath -or $shortcut.Arguments -ne $arguments)){throw 'Existing Startup link differs; preserved'}
    $shortcut.TargetPath=$shellPath;$shortcut.Arguments=$arguments;$shortcut.WorkingDirectory=$LabRepo;$shortcut.WindowStyle=7;$shortcut.Description='Sigongnote local lab supervisor'
    $shortcut.Save()
    # WMI owns this process, so ending a Codex tool/terminal does not tear it down.
    $startup=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}
    $result=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=('"'+$shellPath+'" '+$arguments);CurrentDirectory=$LabRepo;ProcessStartupInformation=$startup}
    if($result.ReturnValue -ne 0){throw 'Startup link installed, but starting supervisor failed. Sign out/in or launch the Startup link.'}
}
Save-LabJson $LabInstallPath @{mode=$mode;taskName=$LabTaskName;installedAt=[DateTime]::UtcNow.ToString('o');lan=[bool]$Lan}
Write-Output "INSTALLED $mode; current-user logon starts the lab; status: pwsh -File scripts/lab-service-status.ps1"
