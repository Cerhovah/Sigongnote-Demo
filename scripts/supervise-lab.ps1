param([switch]$Lan,[ValidateRange(5,60)][int]$IntervalSeconds=15)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'lab-runtime.ps1')
New-Item -ItemType Directory -Path $LabDirectory -Force | Out-Null
$mutex=[Threading.Mutex]::new($false,"Local\$LabTaskName")
try{$ownsMutex=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$ownsMutex=$true}
if(-not $ownsMutex){$mutex.Dispose();exit 0}
$state=@{service='sigongnote-lab-supervisor';pid=$PID;startedAt=[DateTime]::UtcNow.ToString('o');checkedAt=$null;lan=[bool]$Lan;review='starting';work='starting';worker='unknown';recoveries=0;lastEvent='starting'}
[IO.File]::WriteAllText((Join-Path $LabDirectory 'supervisor.pid'),[string]$PID)
$failures=@{5188=0;5190=0}
$lastAttempt=@{5188=[datetime]::MinValue;5190=[datetime]::MinValue}
function Invoke-LabLauncher([int]$Port) {
    $name=if($Port -eq 5188){'start-review-preview.ps1'}else{'start-real-links.ps1'}
    $argsList=@('-NoProfile','-File',('"'+(Join-Path $PSScriptRoot $name)+'"'),'-SkipBuild')
    if($Lan){$argsList+='-Lan'}
    # A bounded child launch; only this newly created process may be terminated on timeout.
    $child=Start-Process -FilePath (Join-Path $PSHOME 'pwsh.exe') -ArgumentList $argsList -WorkingDirectory $LabRepo -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $LabDirectory "$Port-start.log") -RedirectStandardError (Join-Path $LabDirectory "$Port-error.log")
    if(-not $child.WaitForExit(180000)){
        Stop-Process -Id $child.Id -ErrorAction SilentlyContinue
        return $false
    }
    return $child.ExitCode -eq 0
}
try {
    Set-Location -LiteralPath $LabRepo
    while($true){
        foreach($port in @(5188,5190)){
            $key=if($port -eq 5188){'review'}else{'work'}
            $expected=if($port -eq 5188){'sigongnote-review-preview'}else{'sigongnote-live-links'}
            $health=Get-LabHealth $port
            $listening=Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
            $matches=$health -and $health.service -eq $expected
            if($matches -and ($port -eq 5188 -or $health.ready)){
                $state[$key]='ready';$failures[$port]=0
                if($port -eq 5190){$state.worker=$health.workerStatus}
                continue
            }
            $failures[$port]++
            $state[$key]=if($matches){'dependency_wait'}elseif($listening){'port_conflict_or_unresponsive'}else{'offline'}
            if($port -eq 5190){$state.worker=if($health){$health.workerStatus}else{'offline'}}
            if(([DateTime]::UtcNow-$lastAttempt[$port]).TotalSeconds -lt 60){continue}
            $lastAttempt[$port]=[DateTime]::UtcNow
            if($listening){
                if($failures[$port] -lt 3){continue}
                $folder=if($port -eq 5188){'.work/review-preview'}else{'.work/live-links'}
                $script=if($port -eq 5188){'scripts/serve-review-preview.mjs'}else{'scripts/serve-real-links.mjs'}
                $owned=Get-LabOwnedProcess (Join-Path $LabRepo "$folder/server.pid") (Join-Path $LabRepo $script) $port
                if(-not $owned){$state.lastEvent='unrelated_listener_preserved';continue}
                Stop-Process -Id $owned.ProcessId -ErrorAction SilentlyContinue
                Start-Sleep -Seconds 1
            }
            $state.lastEvent="starting_$port";$state.checkedAt=[DateTime]::UtcNow.ToString('o');Save-LabJson $LabStatePath $state
            if(Invoke-LabLauncher $port){$state.recoveries++;$state.lastEvent="recovered_$port"}else{$state.lastEvent="startup_failed_$port"}
        }
        $state.checkedAt=[DateTime]::UtcNow.ToString('o');Save-LabJson $LabStatePath $state
        Start-Sleep -Seconds $IntervalSeconds
    }
} finally {
    $mutex.ReleaseMutex();$mutex.Dispose()
}
