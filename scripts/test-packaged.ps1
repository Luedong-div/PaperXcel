$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$systemTemp = [System.IO.Path]::GetFullPath(
    [System.IO.Path]::GetTempPath()
).TrimEnd("\")
$tempOutput = Join-Path $systemTemp (
    "paperxcel-packaged-smoke-" + [Guid]::NewGuid().ToString("N")
)

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath exited with code $LASTEXITCODE."
    }
}

function Remove-CheckedDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$AllowedRoot
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    $resolvedPath = (Resolve-Path -LiteralPath $Path).Path
    $resolvedRoot = (Resolve-Path -LiteralPath $AllowedRoot).Path.TrimEnd("\")
    if (-not $resolvedPath.StartsWith(
        "$resolvedRoot\",
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw "Refusing to remove a directory outside $resolvedRoot."
    }
    Remove-Item -LiteralPath $resolvedPath -Recurse -Force -ErrorAction Stop
}

Push-Location $projectRoot
try {
    Invoke-Checked npm.cmd run build

    if (-not $env:ELECTRON_MIRROR) {
        $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
    }
    if (-not $env:ELECTRON_BUILDER_BINARIES_MIRROR) {
        $env:ELECTRON_BUILDER_BINARIES_MIRROR = (
            "https://npmmirror.com/mirrors/electron-builder-binaries/"
        )
    }

    Invoke-Checked npx.cmd electron-builder --win --dir `
        "--config.directories.output=$tempOutput"

    $packagedExecutable = Join-Path $tempOutput (
        "win-unpacked\PaperXcel.exe"
    )
    if (-not (Test-Path -LiteralPath $packagedExecutable)) {
        throw "electron-builder did not produce a complete unpacked application."
    }

    $previousExecutable = $env:PAPERXCEL_EXECUTABLE_PATH
    try {
        $env:PAPERXCEL_EXECUTABLE_PATH = $packagedExecutable
        Invoke-Checked node.exe tests/packaged-smoke.mjs
    }
    finally {
        if ($null -eq $previousExecutable) {
            Remove-Item Env:PAPERXCEL_EXECUTABLE_PATH -ErrorAction SilentlyContinue
        }
        else {
            $env:PAPERXCEL_EXECUTABLE_PATH = $previousExecutable
        }
    }
}
finally {
    Pop-Location
    if (Test-Path -LiteralPath $tempOutput) {
        Remove-CheckedDirectory $tempOutput $systemTemp
    }
}
