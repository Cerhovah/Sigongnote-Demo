#Requires -Version 7
param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Output,
    [int[]]$SectionBreaks = @(),
    [string[]]$FitColumns = @(),
    [string]$PrintRange
)
$ErrorActionPreference = 'Stop'
# Originals are mounted read-only. Outputs never replace existing files.
$sourceItem = Get-Item -LiteralPath $Source
if ($sourceItem.Extension -ne '.xlsx' -or $sourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'UNSUPPORTED_SOURCE' }
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$target = [IO.Path]::GetFullPath($Output)
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Sigongnote/field-v2-output'))
if (-not $target.StartsWith($allowedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'OUTPUT_OUTSIDE_PRIVATE_ROOT' }
# Only the dedicated generated-output root is supported. Reject junctions in its ancestry.
for ($ancestor = [IO.DirectoryInfo]$target; $null -ne $ancestor; $ancestor = $ancestor.Parent) {
    if ($ancestor.Exists -and ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'OUTPUT_LINK_NOT_ALLOWED' }
}
if (Test-Path -LiteralPath $target) { throw 'OUTPUT_ALREADY_EXISTS' }
$sourceHash = (Get-FileHash -LiteralPath $sourceItem.FullName -Algorithm SHA256).Hash
$job = Join-Path $repo ('.work/office-jobs/' + [guid]::NewGuid().ToString())
$inputDir = New-Item -ItemType Directory -Path (Join-Path $job 'input') -Force
$outputDir = New-Item -ItemType Directory -Path (Join-Path $job 'output') -Force
$fontDir = New-Item -ItemType Directory -Path (Join-Path $job 'fonts') -Force
'{"policy":"generated-private-office-work"}' | Set-Content (Join-Path $job 'sigongnote-generated.json') -Encoding utf8NoBOM
foreach ($font in @('malgun.ttf','malgunbd.ttf','malgunsl.ttf')) {
    $installed = Join-Path $env:WINDIR "Fonts/$font"
    if (Test-Path -LiteralPath $installed) { Copy-Item -LiteralPath $installed -Destination $fontDir.FullName }
}
Copy-Item -LiteralPath $sourceItem.FullName -Destination (Join-Path $inputDir.FullName 'source.xlsx')
$layout = @{section_breaks=@($SectionBreaks);fit_columns=@($FitColumns)}
if ($PrintRange) { $layout.print_range=$PrintRange }
$layout | ConvertTo-Json | Set-Content (Join-Path $inputDir.FullName 'layout.json') -Encoding utf8NoBOM
$docker = Join-Path $env:LOCALAPPDATA 'Programs/DockerDesktop/resources/bin/docker.exe'
if (-not (Test-Path -LiteralPath $docker)) { $docker='docker' }
$script = Join-Path $repo 'services/document-worker/src/sigongnote_worker/office_copy.py'
& $docker run --rm --pull=never --network=none --memory=1g --memory-swap=1g --cpus=2 --pids-limit=128 --cap-drop=ALL `
    --ulimit fsize=104857600 --ulimit nofile=1024:1024 `
    --security-opt=no-new-privileges --read-only --tmpfs /tmp:rw,size=256m --entrypoint /usr/bin/timeout `
    --mount "type=bind,source=$($inputDir.FullName),target=/input,readonly" `
    --mount "type=bind,source=$($outputDir.FullName),target=/output" `
    --mount "type=bind,source=$($fontDir.FullName),target=/usr/share/fonts/truetype/local-user,readonly" `
    --mount "type=bind,source=$script,target=/renderer.py,readonly" sigongnote-office:local 180 /usr/bin/python3 /renderer.py `
    > (Join-Path $job 'result.log') 2>&1
if ($LASTEXITCODE -ne 0) { throw 'OFFICE_RENDER_FAILED' }
if ((Get-FileHash -LiteralPath $sourceItem.FullName -Algorithm SHA256).Hash -ne $sourceHash) { throw 'SOURCE_CHANGED' }
$result = Join-Path $outputDir.FullName 'result'
$manifest = Get-Content (Join-Path $result 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.source_sha256 -ne $sourceHash.ToLower()) { throw 'SOURCE_BINDING_MISMATCH' }
foreach ($format in @('xlsx','pdf')) {
    $actual = (Get-FileHash -LiteralPath (Join-Path $result "document.$format") -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $manifest."${format}_sha256") { throw 'OUTPUT_HASH_MISMATCH' }
}
$partial = $target + '.partial-' + [guid]::NewGuid().ToString()
New-Item -ItemType Directory -Path $partial | Out-Null
'{"policy":"generated-internal-review-copy"}' | Set-Content (Join-Path $partial 'sigongnote-generated.json') -Encoding utf8NoBOM
Copy-Item -LiteralPath (Join-Path $result 'document.xlsx'),(Join-Path $result 'document.pdf'),(Join-Path $result 'manifest.json'),(Join-Path $result 'computed-private.json') -Destination $partial
foreach ($format in @('xlsx','pdf')) {
    if ((Get-FileHash -LiteralPath (Join-Path $partial "document.$format") -Algorithm SHA256).Hash.ToLower() -ne $manifest."${format}_sha256") { throw 'FINAL_COPY_HASH_MISMATCH' }
}
Move-Item -LiteralPath $partial -Destination $target
Write-Output 'PASS'
