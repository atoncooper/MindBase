# fetch-ffmpeg.ps1 - Provision the FFmpeg sidecar binaries bundled with MindBase Desktop.
#
# Copies (or downloads) ffmpeg.exe / ffprobe.exe into src-tauri/binaries/ using the
# "-{target-triple}" naming required by Tauri's `bundle.externalBin`.
#
# TODO(supply-chain): binaries are not hash/version pinned yet; pin known-good SHA-256 artifacts before public distribution.
#
# LICENSE NOTE: The gyan.dev "release essentials" build used by the download
# fallback is licensed under GPLv3 (it bundles GPL components such as libx264).
# Distributing those binaries inside this application means the whole
# distribution must comply with the GNU GPLv3 terms (ship the license text,
# honor the corresponding-source obligation, etc.). Verify the license of
# whichever build you vendor before publishing installers. See:
#   https://www.gyan.dev/ffmpeg/builds/
#   https://www.gnu.org/licenses/gpl-3.0.html
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1 -Force
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1 `
#       -DownloadUrl https://example.com/ffmpeg.zip -Proxy http://127.0.0.1:10808

param(
    # Root directory scanned for a pre-installed ffmpeg (strategy A).
    [string]$LocalSourceRoot = "C:\ffmpeg",
    # Download URL used when no local installation exists (strategy B).
    [string]$DownloadUrl = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
    # Optional HTTP(S) proxy for the download fallback (strategy B).
    [string]$Proxy = "",
    # Re-copy / re-download even when the target files already exist.
    [switch]$Force
)

$ErrorActionPreference = "Stop"

# Must match the triple reported by `rustc -vV` (host) and tauri.conf.json externalBin.
$TargetTriple = "x86_64-pc-windows-msvc"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$OutDir = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir "..\src-tauri\binaries"))
$FfmpegTarget = Join-Path $OutDir ("ffmpeg-{0}.exe" -f $TargetTriple)
$FfprobeTarget = Join-Path $OutDir ("ffprobe-{0}.exe" -f $TargetTriple)

function Test-NonEmptyFile {
    param([string]$Path)
    return (Test-Path -LiteralPath $Path -PathType Leaf) -and ((Get-Item -LiteralPath $Path).Length -gt 0)
}

# Copy ffmpeg.exe + ffprobe.exe from one bin directory into the sidecar layout.
function Copy-BinariesFrom {
    param([string]$BinDir)
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    foreach ($name in @("ffmpeg.exe", "ffprobe.exe")) {
        $src = Join-Path $BinDir $name
        if (-not (Test-NonEmptyFile $src)) {
            throw "[fetch-ffmpeg] missing or empty binary: $src"
        }
        $dst = if ($name -eq "ffmpeg.exe") { $FfmpegTarget } else { $FfprobeTarget }
        Copy-Item -LiteralPath $src -Destination $dst -Force
        Write-Host "[fetch-ffmpeg] copied $src -> $dst"
    }
}

if (-not $Force -and (Test-NonEmptyFile $FfmpegTarget) -and (Test-NonEmptyFile $FfprobeTarget)) {
    Write-Host "[fetch-ffmpeg] sidecar binaries already present, skipping (-Force to refresh)"
    exit 0
}

# --- Strategy A: reuse a pre-existing local ffmpeg installation ---------------
$localPattern = Join-Path $LocalSourceRoot "*\bin\ffmpeg.exe"
$locals = @(Get-ChildItem -Path $localPattern -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending)
if ($locals.Count -gt 0) {
    $best = $locals[0]
    Write-Host ("[fetch-ffmpeg] strategy A: local ffmpeg found at {0} ({1} candidate(s))" -f `
        $best.FullName, $locals.Count)
    Copy-BinariesFrom -BinDir $best.DirectoryName
    exit 0
}

# --- Strategy B: download the gyan.dev release essentials zip -----------------
Write-Host "[fetch-ffmpeg] strategy B: no local ffmpeg under $LocalSourceRoot, downloading $DownloadUrl"

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("mindbase-ffmpeg-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
try {
    $zipPath = Join-Path $tempRoot "ffmpeg-release-essentials.zip"
    $downloadArgs = @{
        Uri = $DownloadUrl
        OutFile = $zipPath
        UseBasicParsing = $true
    }
    if ($Proxy -ne "") {
        $downloadArgs["Proxy"] = $Proxy
        Write-Host "[fetch-ffmpeg] using proxy $Proxy"
    }
    Invoke-WebRequest @downloadArgs
    if (-not (Test-NonEmptyFile $zipPath)) {
        throw "[fetch-ffmpeg] downloaded archive is missing or empty: $zipPath"
    }

    $extractDir = Join-Path $tempRoot "extracted"
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force

    $zipped = @(Get-ChildItem -Path (Join-Path $extractDir "*") -Recurse -Filter "ffmpeg.exe" `
        -File -ErrorAction SilentlyContinue)
    if ($zipped.Count -eq 0) {
        throw "[fetch-ffmpeg] ffmpeg.exe not found inside downloaded archive"
    }
    Copy-BinariesFrom -BinDir $zipped[0].DirectoryName
}
finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "[fetch-ffmpeg] done."
