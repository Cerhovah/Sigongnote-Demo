#requires -Version 7.0
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$InstallMissing,
    [ValidateSet('DotNet10','GitHubCLI')][string[]]$Components = @('DotNet10','GitHubCLI')
)

$ErrorActionPreference = 'Stop'
$plans = @{
    DotNet10 = @{ Id='Microsoft.DotNet.SDK.10'; Version='10.0.401'; Name='.NET SDK 10' }
    GitHubCLI = @{ Id='GitHub.cli'; Version='2.101.0'; Name='GitHub CLI' }
}
foreach ($component in $Components) {
    $plan = $plans[$component]
    $present = $false
    if ($component -eq 'DotNet10') {
        $dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
        if ($dotnet) { $present = [bool]((& $dotnet.Source --list-sdks) -match '^10\.') }
    } else {
        $present = [bool](Get-Command gh -ErrorAction SilentlyContinue)
        if (-not $present) { $present = Test-Path -LiteralPath (Join-Path $env:ProgramFiles 'GitHub CLI\gh.exe') }
    }
    if ($present) { Write-Output ($plan.Name + ': already installed; leave unchanged'); continue }
    if (-not $InstallMissing) { Write-Output ($plan.Name + ': would install ' + $plan.Id + ' ' + $plan.Version); continue }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'winget is missing. Install Microsoft App Installer using Microsoft Store first.' }
    if ($PSCmdlet.ShouldProcess($plan.Name, 'Install official pinned winget package')) {
        & winget install --id $plan.Id --version $plan.Version --exact --source winget --silent --disable-interactivity
        if ($LASTEXITCODE -ne 0) { throw ('Installation did not finish: ' + $plan.Id + '. Resolve installer/UAC or agreement prompt yourself; no auto-accept or reboot is attempted.') }
    }
}
Write-Output 'Next: run scripts/check-environment.ps1. Android SDK licenses, Docker/WSL, service logins, signing keys and payments are user-owned setup steps; see docs/ENVIRONMENT.md.'
