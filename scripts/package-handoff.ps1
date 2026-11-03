#requires -Version 7.0
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$artifactDir = Join-Path $repoRoot '.work/documentation'
New-Item -ItemType Directory -Path $artifactDir -Force | Out-Null
$archivePath = Join-Path $artifactDir 'sigongnote-docs-v0.3.zip'
$paths = @('README.md','AGENTS.md','CLAUDE.md','HANDOFF.md','docs/EXECUTION_STATE.md','docs/AGENT_SPEC.md','docs/ENVIRONMENT.md')
$manifest = foreach ($relative in $paths) {
    $file = Join-Path $repoRoot $relative
    [pscustomobject]@{ path=$relative; bytes=(Get-Item -LiteralPath $file).Length; sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
}
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [IO.File]::Open($archivePath, [IO.FileMode]::Create, [IO.FileAccess]::Write)
$zip = [IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create,$false)
try {
    foreach ($entry in $manifest) {
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,(Join-Path $repoRoot $entry.path),$entry.path,[IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
    $manifestEntry = $zip.CreateEntry('MANIFEST.json')
    $writer = [IO.StreamWriter]::new($manifestEntry.Open(),[Text.UTF8Encoding]::new($false))
    try { $writer.Write((@{ version='0.3'; kind='documentation-not-application'; files=@($manifest) } | ConvertTo-Json -Depth 5)) }
    finally { $writer.Dispose() }
} finally { $zip.Dispose(); $stream.Dispose() }
Write-Output ('Packaged ' + $manifest.Count + ' active documents plus MANIFEST.json into .work/documentation/sigongnote-docs-v0.3.zip')
Write-Output ('SHA256 ' + (Get-FileHash -LiteralPath $archivePath).Hash.ToLowerInvariant())
