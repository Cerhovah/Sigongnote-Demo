param([Parameter(Mandatory=$true)][string]$KeyFile)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ge 6) { Add-Type -AssemblyName System.Security.Cryptography.ProtectedData }
else { Add-Type -AssemblyName System.Security }
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
if (Test-Path -LiteralPath $KeyFile) {
    $key = [System.Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($KeyFile), $null, $scope)
} else {
    $key = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($key) } finally { $rng.Dispose() }
    $wrapped = [System.Security.Cryptography.ProtectedData]::Protect($key, $null, $scope)
    $temporary = $KeyFile + '.' + [Guid]::NewGuid().ToString('N') + '.new'
    [IO.File]::WriteAllBytes($temporary, $wrapped)
    [IO.File]::Move($temporary, $KeyFile)
}
if ($key.Length -ne 32) { throw 'INVALID_LOCAL_KEY' }
# Consumed only through the parent's private stdout pipe; never sent to a log.
[Console]::Write([Convert]::ToBase64String($key))
[Array]::Clear($key, 0, $key.Length)
