param([Parameter(Mandatory=$true)][string]$WindowsDirectory)
$ErrorActionPreference='Stop'
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$windows=(Resolve-Path -LiteralPath $WindowsDirectory).Path
$local=Join-Path $windows 'local-agent'
if(Test-Path -LiteralPath $local){throw 'Local runtime already exists; use a fresh package directory'}
New-Item -ItemType Directory -Path $local | Out-Null
$node=(Get-Command node.exe -ErrorAction Stop).Source
$nodeVersion=& $node -p 'process.versions.node'
if($nodeVersion -notmatch '^24\.'){throw 'Node 24 is required for packaged SQLite'}
Copy-Item -LiteralPath $node -Destination (Join-Path $local 'node.exe')
Push-Location $repo
try { & $node scripts/build-local-agent.mjs (Join-Path $local 'main.mjs'); if($LASTEXITCODE -ne 0){throw 'Local engine bundle failed'} }
finally { Pop-Location }
$worker=Join-Path $repo 'services/document-worker'
$venvPython=Join-Path $worker '.venv/Scripts/python.exe'
if(!(Test-Path -LiteralPath $venvPython)){throw 'Document parser environment is missing'}
$pythonBase=(& $venvPython -c 'import sys; print(sys.base_prefix)').Trim()
if($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath (Join-Path $pythonBase 'python.exe'))){throw 'Python runtime is missing'}
$python=Join-Path $local 'python'
New-Item -ItemType Directory -Path $python | Out-Null
Get-ChildItem -LiteralPath $pythonBase -File | Where-Object {$_.Name -eq 'python.exe' -or $_.Extension -eq '.dll' -or $_.Name -eq 'LICENSE.txt'} | ForEach-Object {Copy-Item -LiteralPath $_.FullName -Destination $python}
Copy-Item -LiteralPath (Join-Path $pythonBase 'DLLs') -Destination $python -Recurse
$pythonLib=Join-Path $python 'Lib'
New-Item -ItemType Directory -Path $pythonLib | Out-Null
Get-ChildItem -LiteralPath (Join-Path $pythonBase 'Lib') | Where-Object {$_.Name -notin @('site-packages','__pycache__','test','idlelib','tkinter','turtledemo')} | ForEach-Object {Copy-Item -LiteralPath $_.FullName -Destination $pythonLib -Recurse}
$site=Join-Path $pythonLib 'site-packages'
New-Item -ItemType Directory -Path $site | Out-Null
# Do not package editable-environment paths or the developer's startup hooks.
Get-ChildItem -LiteralPath (Join-Path $worker '.venv/Lib/site-packages') | Where-Object {$_.Extension -ne '.pth' -and $_.Name -notmatch '^(__editable__|_virtualenv)' -and $_.Name -notmatch '^(__pycache__|pytest|_pytest|sigongnote_document_worker-.*\.dist-info)$'} | ForEach-Object {Copy-Item -LiteralPath $_.FullName -Destination $site -Recurse}
$workerOut=Join-Path $windows 'services/document-worker'
New-Item -ItemType Directory -Path $workerOut -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $worker 'src') -Destination $workerOut -Recurse
# Bytecode records the development source path; editable metadata must not ship.
$packagePrefix=[IO.Path]::GetFullPath($windows)+[IO.Path]::DirectorySeparatorChar
Get-ChildItem -LiteralPath $windows -File -Recurse | Where-Object {$_.Extension -eq '.pyc' -or $_.Name -eq 'direct_url.json' -or $_.Name -like '__editable__*'} | ForEach-Object {
    if(-not [IO.Path]::GetFullPath($_.FullName).StartsWith($packagePrefix,[StringComparison]::OrdinalIgnoreCase)){throw 'Generated runtime path escaped package'}
    Remove-Item -LiteralPath $_.FullName
}
$scriptOut=Join-Path $windows 'scripts'
New-Item -ItemType Directory -Path $scriptOut -Force | Out-Null
$utf8Bom=New-Object Text.UTF8Encoding($true)
foreach($name in @('local-agent-key.ps1','select-local-folder.ps1')){[IO.File]::WriteAllText((Join-Path $scriptOut $name),[IO.File]::ReadAllText((Join-Path $PSScriptRoot $name)),$utf8Bom)}
& (Join-Path $python 'python.exe') -B -c 'import sqlite3,openpyxl,pdfplumber,pypdf,defusedxml,olefile; print("Local parser runtime ready")'
if($LASTEXITCODE -ne 0){throw 'Packaged parser import failed'}
Write-Output 'PASS packaged local engine, Node, and document parser'
